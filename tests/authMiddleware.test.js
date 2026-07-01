const { authMiddleware, optionalAuthMiddleware } = require('../src/middleware/authMiddleware');
const MockReq = require('mock-express-request');
const MockRes = require('mock-express-response');
const authService = require('../src/services/authService');

jest.mock('../src/services/authService', () => ({
  verifyJWT: jest.fn()
}));

describe('authMiddleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = new MockReq({
      cookies: {},
      headers: {}
    });
    res = new MockRes();
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
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

    it('should return 401 if token is invalid or expired', () => {
      req.cookies.auth_token = 'invalid_token';
      authService.verifyJWT.mockReturnValue(null);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('invalid_token');
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido ou expirado' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should call next and set req.user if token is valid', () => {
      const mockUser = { id: 1, email: 'admin@test.com' };
      req.cookies.auth_token = 'valid_token';
      authService.verifyJWT.mockReturnValue(mockUser);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token');
      expect(req.user).toEqual(mockUser);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should read token from Authorization header if cookie is missing', () => {
      const mockUser = { id: 1, email: 'admin@test.com' };
      req.headers.authorization = 'Bearer header_token';
      authService.verifyJWT.mockReturnValue(mockUser);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('header_token');
      expect(req.user).toEqual(mockUser);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('optionalAuthMiddleware', () => {
    it('should call next without setting req.user if no token is provided', () => {
      optionalAuthMiddleware(req, res, next);

      expect(authService.verifyJWT).not.toHaveBeenCalled();
      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('should call next without setting req.user if token is invalid', () => {
      req.cookies.auth_token = 'invalid_token';
      authService.verifyJWT.mockReturnValue(null);

      optionalAuthMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('invalid_token');
      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('should call next and set req.user if token is valid', () => {
      const mockUser = { id: 1, email: 'admin@test.com' };
      req.cookies.auth_token = 'valid_token';
      authService.verifyJWT.mockReturnValue(mockUser);

      optionalAuthMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token');
      expect(req.user).toEqual(mockUser);
      expect(next).toHaveBeenCalled();
    });
  });
});
