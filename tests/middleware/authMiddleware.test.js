jest.mock('../../config/database', () => ({}));
jest.mock('../../src/services/authService', () => ({
  verifyJWT: jest.fn(),
}));

const { authMiddleware, optionalAuthMiddleware } = require('../../src/middleware/authMiddleware');
const authService = require('../../src/services/authService');
const MockExpressRequest = require('mock-express-request');
const MockExpressResponse = require('mock-express-response');

describe('authMiddleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = new MockExpressRequest();
    res = new MockExpressResponse();
    next = jest.fn();
    jest.clearAllMocks();
  });

  describe('authMiddleware', () => {
    it('should return 401 if no token is provided', () => {
      // Nenhum token fornecido nos cookies ou no header

      // Spy no status e no json para checar os retornos
      const statusSpy = jest.spyOn(res, 'status');
      const jsonSpy = jest.spyOn(res, 'json');

      authMiddleware(req, res, next);

      expect(statusSpy).toHaveBeenCalledWith(401);
      expect(jsonSpy).toHaveBeenCalledWith({ error: 'Token não fornecido' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should proceed to next if valid token is provided in cookies', () => {
      req.cookies = { auth_token: 'valid_token' };
      const decodedUser = { id: 1, name: 'Test User' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token');
      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });

    it('should proceed to next if valid token is provided in authorization header', () => {
      req.headers = { authorization: 'Bearer valid_token_header' };
      const decodedUser = { id: 2, name: 'Header User' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token_header');
      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });

    it('should return 401 if token is invalid or expired', () => {
      req.cookies = { auth_token: 'invalid_token' };
      authService.verifyJWT.mockReturnValue(null);

      const statusSpy = jest.spyOn(res, 'status');
      const jsonSpy = jest.spyOn(res, 'json');

      authMiddleware(req, res, next);

      expect(statusSpy).toHaveBeenCalledWith(401);
      expect(jsonSpy).toHaveBeenCalledWith({ error: 'Token inválido ou expirado' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('optionalAuthMiddleware', () => {
    it('should proceed to next without user if no token is provided', () => {
      optionalAuthMiddleware(req, res, next);

      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('should attach user and proceed if valid token is provided', () => {
      req.cookies = { auth_token: 'valid_token' };
      const decodedUser = { id: 1, name: 'Test User' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      optionalAuthMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token');
      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });

    it('should proceed to next without user if invalid token is provided', () => {
      req.cookies = { auth_token: 'invalid_token' };
      authService.verifyJWT.mockReturnValue(null);

      optionalAuthMiddleware(req, res, next);

      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });
  });
});
