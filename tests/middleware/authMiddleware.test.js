const { authMiddleware, optionalAuthMiddleware } = require('../../src/middleware/authMiddleware');
const authService = require('../../src/services/authService');

// Mock authService
jest.mock('../../src/services/authService', () => ({
  verifyJWT: jest.fn()
}));

describe('authMiddleware', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = {
      cookies: {},
      headers: {}
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  describe('authMiddleware', () => {
    it('should return 401 if no token is provided', () => {
      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token não fornecido' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 if token is invalid', () => {
      req.cookies.auth_token = 'invalid-token';
      authService.verifyJWT.mockReturnValue(null);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('invalid-token');
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido ou expirado' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should call next and set req.user if valid token is in cookies', () => {
      req.cookies.auth_token = 'valid-token';
      const mockUser = { id: 1, name: 'Test User' };
      authService.verifyJWT.mockReturnValue(mockUser);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid-token');
      expect(req.user).toEqual(mockUser);
      expect(next).toHaveBeenCalled();
    });

    it('should call next and set req.user if valid token is in headers', () => {
      req.headers.authorization = 'Bearer header-token';
      const mockUser = { id: 1, name: 'Test User' };
      authService.verifyJWT.mockReturnValue(mockUser);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('header-token');
      expect(req.user).toEqual(mockUser);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('optionalAuthMiddleware', () => {
    it('should call next and not set req.user if no token is provided', () => {
      optionalAuthMiddleware(req, res, next);

      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('should call next and set req.user if valid token is provided', () => {
      req.cookies.auth_token = 'valid-token';
      const mockUser = { id: 1, name: 'Test User' };
      authService.verifyJWT.mockReturnValue(mockUser);

      optionalAuthMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid-token');
      expect(req.user).toEqual(mockUser);
      expect(next).toHaveBeenCalled();
    });

    it('should call next and not set req.user if token is invalid', () => {
      req.cookies.auth_token = 'invalid-token';
      authService.verifyJWT.mockReturnValue(null);

      optionalAuthMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('invalid-token');
      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });
  });
});
