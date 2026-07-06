const MockExpressRequest = require('mock-express-request');
const MockExpressResponse = require('mock-express-response');

// Must mock database config before other imports as per memory instructions
jest.mock('../../config/database', () => ({
  run: jest.fn(),
  get: jest.fn(),
  all: jest.fn(),
  serialize: jest.fn((cb) => cb()),
}));

// Mock authService fully as per memory instructions
jest.mock('../../src/services/authService', () => ({
  verifyJWT: jest.fn()
}));

const authService = require('../../src/services/authService');
const { authMiddleware, optionalAuthMiddleware } = require('../../src/middleware/authMiddleware');

describe('Auth Middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = new MockExpressRequest();
    res = new MockExpressResponse();
    next = jest.fn();
    jest.clearAllMocks();
  });

  describe('authMiddleware', () => {
    it('should return 401 if no token is provided in cookies or headers', () => {
      // req has no cookies or headers initially

      authMiddleware(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res._getJSON()).toEqual({ error: 'Token não fornecido' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should extract token from cookies and verify', () => {
      req.cookies = { auth_token: 'valid_cookie_token' };
      const decodedUser = { id: 1, email: 'test@example.com' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_cookie_token');
      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });

    it('should extract token from authorization header and verify', () => {
      req.headers = { authorization: 'Bearer valid_header_token' };
      const decodedUser = { id: 2, email: 'test2@example.com' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_header_token');
      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });

    it('should return 401 if token is invalid or expired', () => {
      req.cookies = { auth_token: 'invalid_token' };
      authService.verifyJWT.mockReturnValue(null);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('invalid_token');
      expect(res.statusCode).toBe(401);
      expect(res._getJSON()).toEqual({ error: 'Token inválido ou expirado' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('optionalAuthMiddleware', () => {
    it('should call next without setting req.user if no token is provided', () => {
      optionalAuthMiddleware(req, res, next);

      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('should call next without setting req.user if token is invalid', () => {
      req.headers = { authorization: 'Bearer invalid_token' };
      authService.verifyJWT.mockReturnValue(null);

      optionalAuthMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('invalid_token');
      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('should set req.user and call next if valid token is provided', () => {
      req.headers = { authorization: 'Bearer valid_token' };
      const decodedUser = { id: 3, role: 'admin' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      optionalAuthMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token');
      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });
  });
});
