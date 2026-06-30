const authController = require('../authController');
const blingService = require('../../services/blingService');
const authService = require('../../services/authService');
const db = require('../../../config/database');

// Mock dependencies
jest.mock('../../services/blingService');
jest.mock('../../services/authService');
jest.mock('../../../config/database', () => {
  return {
    serialize: jest.fn((callback) => callback()),
    run: jest.fn(),
  };
});

describe('authController', () => {
  let req;
  let res;

  beforeEach(() => {
    req = {
      query: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      cookie: jest.fn(),
      redirect: jest.fn(),
    };

    // Silence console error and log for tests
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleCallback', () => {
    it('should return 400 if authorization code is missing', async () => {
      await authController.handleCallback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Código de autorização não fornecido' });
      expect(blingService.exchangeCodeForToken).not.toHaveBeenCalled();
    });

    it('should handle successful authentication and redirect to dashboard', async () => {
      req.query.code = 'valid_code';
      const mockTokenData = { access_token: 'access123', refresh_token: 'refresh123', expires_in: 3600 };
      const mockUserId = 1;
      const mockJwtToken = 'jwt_token_123';
      const mockProdutos = [
        { id: '101', nome: 'Produto 1', codigo: 'P01', preco: 10, estoque: 5, situacao: 'A' }
      ];

      blingService.exchangeCodeForToken.mockResolvedValue(mockTokenData);
      authService.saveOrUpdateUser.mockResolvedValue(mockUserId);
      authService.generateJWT.mockReturnValue(mockJwtToken);
      blingService.getProdutos.mockResolvedValue(mockProdutos);

      // We need to mock db.run to simulate success callback so the sync function completes
      db.run.mockImplementation((query, params, callback) => {
        // Mocking db.run callback
        if (typeof params === 'function') {
           params(null);
        } else if (typeof callback === 'function') {
           callback(null);
        }
        return db;
      });

      await authController.handleCallback(req, res);

      expect(blingService.exchangeCodeForToken).toHaveBeenCalledWith('valid_code');
      expect(authService.saveOrUpdateUser).toHaveBeenCalledWith('bling_user', mockTokenData);
      expect(authService.generateJWT).toHaveBeenCalledWith(mockUserId);

      expect(res.cookie).toHaveBeenCalledWith('auth_token', mockJwtToken, expect.objectContaining({
        httpOnly: true,
        sameSite: 'strict',
      }));
      expect(res.redirect).toHaveBeenCalledWith('/dashboard');

      // Since syncProductosAposLogin is async and backgrounded, we might need to wait for it or just verify it was called.
      // Wait for all promises to resolve in the microtask queue to allow the async background job to run
      await new Promise(process.nextTick);

      expect(blingService.getProdutos).toHaveBeenCalledWith('access123');
    });

    it('should return 500 if token exchange fails', async () => {
      req.query.code = 'invalid_code';
      const mockError = new Error('Token exchange failed');

      blingService.exchangeCodeForToken.mockRejectedValue(mockError);

      await authController.handleCallback(req, res);

      expect(blingService.exchangeCodeForToken).toHaveBeenCalledWith('invalid_code');
      expect(console.error).toHaveBeenCalledWith('Erro no callback de autenticação:', mockError);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Erro ao autenticar com Bling' });
      expect(authService.saveOrUpdateUser).not.toHaveBeenCalled();
    });
  });
});
