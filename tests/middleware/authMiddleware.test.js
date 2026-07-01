jest.mock('../../config/database', () => ({}));
const { authMiddleware, optionalAuthMiddleware } = require('../../src/middleware/authMiddleware');
const authService = require('../../src/services/authService');

jest.mock('../../src/services/authService');

describe('Auth Middleware', () => {
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

    it('should return 401 if token is provided but invalid', () => {
      req.cookies.auth_token = 'invalid_token';
      authService.verifyJWT.mockReturnValue(null);

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido ou expirado' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should call next and set req.user if token is valid (from cookies)', () => {
      req.cookies.auth_token = 'valid_token';
      const decodedUser = { id: 1, name: 'Test' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      authMiddleware(req, res, next);

      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });

    it('should call next and set req.user if token is valid (from headers)', () => {
      req.headers.authorization = 'Bearer valid_token_header';
      const decodedUser = { id: 1, name: 'Test' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      authMiddleware(req, res, next);

      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('optionalAuthMiddleware', () => {
    it('should call next without setting req.user if no token is provided', () => {
      optionalAuthMiddleware(req, res, next);

      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('should call next without setting req.user if token is invalid', () => {
      req.cookies.auth_token = 'invalid_token';
      authService.verifyJWT.mockReturnValue(null);

      optionalAuthMiddleware(req, res, next);

      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('should call next and set req.user if token is valid', () => {
      req.cookies.auth_token = 'valid_token';
      const decodedUser = { id: 1, name: 'Test' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      optionalAuthMiddleware(req, res, next);

      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });
  });
});
