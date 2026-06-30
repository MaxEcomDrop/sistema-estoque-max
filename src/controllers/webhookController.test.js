const webhookController = require('./webhookController');
const db = require('../../config/database');
const blingService = require('../services/blingService');
const authService = require('../services/authService');

// Mock dependencies
jest.mock('../../config/database', () => ({
  get: jest.fn(),
  run: jest.fn()
}));
jest.mock('../services/blingService');
jest.mock('../services/authService');

describe('Webhook Controller', () => {
  let req;
  let res;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Mock Express request
    req = {
      body: {}
    };

    // Mock Express response
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };

    // Suppress console logs during tests to keep output clean
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe('handleBlingWebhook edge cases', () => {
    test('should return 400 if parameters are missing', async () => {
      req.body = { tipo: 'produto.criacao' }; // Missing idRegistro

      await webhookController.handleBlingWebhook(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Parâmetros obrigatórios não fornecidos' });

      req.body = { idRegistro: '123' }; // Missing tipo

      await webhookController.handleBlingWebhook(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Parâmetros obrigatórios não fornecidos' });
    });

    test('should return 200 for unsupported event types without calling internal handlers', async () => {
      req.body = { tipo: 'evento.nao.suportado', idRegistro: '123' };

      await webhookController.handleBlingWebhook(req, res);

      expect(res.json).toHaveBeenCalledWith({
        message: 'Webhook recebido com sucesso',
        tipo: 'evento.nao.suportado',
        idRegistro: '123'
      });
      // Ensure we don't attempt any database/service actions for unsupported events
      expect(db.get).not.toHaveBeenCalled();
    });
  });

  describe('handleBlingWebhook happy paths', () => {
    const mockUser = { id: 1, access_token: 'valid_token' };
    const mockProduto = {
      id: '123',
      nome: 'Produto Teste',
      codigo: 'TEST-01',
      preco: 100.5,
      estoque: 10,
      situacao: 'A'
    };

    beforeEach(() => {
      // Setup successful database mocks
      db.get.mockImplementation((query, callback) => {
        callback(null, mockUser);
      });
      db.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      authService.isTokenExpired.mockReturnValue(false);
      blingService.getProdutoById.mockResolvedValue(mockProduto);
    });

    test('should process produto.criacao successfully', async () => {
      req.body = { tipo: 'produto.criacao', idRegistro: '123', sequencia: 1 };

      await webhookController.handleBlingWebhook(req, res);

      expect(res.json).toHaveBeenCalledWith({
        message: 'Webhook recebido com sucesso',
        tipo: 'produto.criacao',
        idRegistro: '123'
      });

      expect(db.get).toHaveBeenCalled();
      expect(authService.isTokenExpired).toHaveBeenCalledWith(mockUser);
      expect(blingService.getProdutoById).toHaveBeenCalledWith('valid_token', '123');
      expect(db.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO products'),
        [1, '123', 'Produto Teste', 'TEST-01', 100.5, 10, 'A'],
        expect.any(Function)
      );
    });

    test('should process produto.atualizacao successfully', async () => {
      req.body = { tipo: 'produto.atualizacao', idRegistro: '123' };

      await webhookController.handleBlingWebhook(req, res);

      expect(res.json).toHaveBeenCalledWith({
        message: 'Webhook recebido com sucesso',
        tipo: 'produto.atualizacao',
        idRegistro: '123'
      });
      expect(db.run).toHaveBeenCalled();
    });

    test('should process estoque.atualizacao successfully', async () => {
      req.body = { tipo: 'estoque.atualizacao', idRegistro: '123' };

      await webhookController.handleBlingWebhook(req, res);

      expect(res.json).toHaveBeenCalledWith({
        message: 'Webhook recebido com sucesso',
        tipo: 'estoque.atualizacao',
        idRegistro: '123'
      });
      expect(db.run).toHaveBeenCalled();
    });
  });

  describe('handleBlingWebhook token refresh flow', () => {
    const mockUser = { id: 1, access_token: 'expired_token' };
    const mockProduto = { id: '123', nome: 'Produto Teste' };

    beforeEach(() => {
      db.get.mockImplementation((query, callback) => callback(null, mockUser));
      db.run.mockImplementation((query, params, callback) => callback(null));
      blingService.getProdutoById.mockResolvedValue(mockProduto);
    });

    test('should refresh token before processing if token is expired', async () => {
      authService.isTokenExpired.mockReturnValue(true);
      authService.refreshUserToken.mockResolvedValue('new_valid_token');

      req.body = { tipo: 'estoque.atualizacao', idRegistro: '123' };

      await webhookController.handleBlingWebhook(req, res);

      expect(authService.isTokenExpired).toHaveBeenCalledWith(mockUser);
      expect(authService.refreshUserToken).toHaveBeenCalledWith(mockUser);
      expect(blingService.getProdutoById).toHaveBeenCalledWith('new_valid_token', '123');
      expect(db.run).toHaveBeenCalled();
    });

    test('should stop processing if token refresh fails', async () => {
      authService.isTokenExpired.mockReturnValue(true);
      authService.refreshUserToken.mockRejectedValue(new Error('Refresh failed'));

      req.body = { tipo: 'estoque.atualizacao', idRegistro: '123' };

      await webhookController.handleBlingWebhook(req, res);

      expect(authService.refreshUserToken).toHaveBeenCalledWith(mockUser);
      expect(blingService.getProdutoById).not.toHaveBeenCalled();
      // Should still return 200 to acknowledge the webhook from Bling,
      // but internal processing halts.
      expect(res.json).toHaveBeenCalledWith({
        message: 'Webhook recebido com sucesso',
        tipo: 'estoque.atualizacao',
        idRegistro: '123'
      });
    });
  });

  describe('handleBlingWebhook error handling', () => {
    test('should return 500 if an unexpected synchronous error occurs in the controller', async () => {
      // Force an error before parameter check
      const unexpectedError = new Error('Unexpected Controller Error');
      // e.g., if req.body is undefined, destructuring throws an error
      req.body = null;

      await webhookController.handleBlingWebhook(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Erro ao processar webhook' });
    });

    test('should handle database error in getValidUser gracefully and return 200 to bling', async () => {
      db.get.mockImplementation((query, callback) => callback(new Error('DB User Error'), null));
      req.body = { tipo: 'produto.criacao', idRegistro: '123' };

      await webhookController.handleBlingWebhook(req, res);

      expect(res.json).toHaveBeenCalledWith({
        message: 'Webhook recebido com sucesso',
        tipo: 'produto.criacao',
        idRegistro: '123'
      });
      // Verification that we didn't proceed further
      expect(blingService.getProdutoById).not.toHaveBeenCalled();
    });

    test('should handle missing user gracefully', async () => {
      db.get.mockImplementation((query, callback) => callback(null, null)); // No user found
      req.body = { tipo: 'produto.criacao', idRegistro: '123' };

      await webhookController.handleBlingWebhook(req, res);

      expect(blingService.getProdutoById).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalled(); // 200 OK
    });

    test('should handle missing product from Bling API gracefully', async () => {
      const mockUser = { id: 1, access_token: 'valid' };
      db.get.mockImplementation((query, callback) => callback(null, mockUser));
      authService.isTokenExpired.mockReturnValue(false);
      blingService.getProdutoById.mockResolvedValue(null); // Product not found

      req.body = { tipo: 'produto.atualizacao', idRegistro: '123' };

      await webhookController.handleBlingWebhook(req, res);

      expect(blingService.getProdutoById).toHaveBeenCalled();
      expect(db.run).not.toHaveBeenCalled(); // Insert should not be called
      expect(res.json).toHaveBeenCalled(); // 200 OK
    });

    test('should handle database error during product insert/update gracefully', async () => {
      const mockUser = { id: 1, access_token: 'valid' };
      const mockProduto = { id: '123', nome: 'Teste' };
      db.get.mockImplementation((query, callback) => callback(null, mockUser));
      authService.isTokenExpired.mockReturnValue(false);
      blingService.getProdutoById.mockResolvedValue(mockProduto);

      db.run.mockImplementation((query, params, callback) => callback(new Error('DB Insert Error')));

      req.body = { tipo: 'estoque.atualizacao', idRegistro: '123' };

      await webhookController.handleBlingWebhook(req, res);

      expect(db.run).toHaveBeenCalled();
      // Should still return 200 to bling since background sync failed but webhook was received
      expect(res.json).toHaveBeenCalled();
    });
  });

  describe('getWebhookStatus', () => {
    test('should return correct status payload', () => {
      webhookController.getWebhookStatus(req, res);

      expect(res.json).toHaveBeenCalledWith({
        message: 'Webhook do Bling está funcionando',
        supported_events: [
          'produto.criacao',
          'produto.atualizacao',
          'estoque.atualizacao',
        ],
        endpoint: '/api/webhook/bling',
      });
    });
  });
});
