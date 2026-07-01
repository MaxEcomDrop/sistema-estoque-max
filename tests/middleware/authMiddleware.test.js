jest.mock('../../config/database', () => ({}));
jest.mock('../../src/services/authService');

const { optionalAuthMiddleware, authMiddleware } = require('../../src/middleware/authMiddleware');
const authService = require('../../src/services/authService');

const MockRequest = require('mock-express-request');
const MockResponse = require('mock-express-response');

describe('Auth Middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = new MockRequest();
    res = new MockResponse();
    // Re-mock status and json to easily check calls
    res.status = jest.fn().mockReturnThis();
    res.json = jest.fn();
    next = jest.fn();

    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  describe('optionalAuthMiddleware', () => {
    it('should call next and not set req.user if no token is provided', () => {
      optionalAuthMiddleware(req, res, next);

      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should set req.user and call next if a valid token is provided in cookies', () => {
      const mockDecodedToken = { id: 1, username: 'testuser' };
      req.cookies.auth_token = 'valid_cookie_token';
      authService.verifyJWT.mockReturnValue(mockDecodedToken);

      optionalAuthMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_cookie_token');
      expect(req.user).toEqual(mockDecodedToken);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should set req.user and call next if a valid token is provided in headers', () => {
      const mockDecodedToken = { id: 1, username: 'testuser' };
      req.headers.authorization = 'Bearer valid_header_token';
      authService.verifyJWT.mockReturnValue(mockDecodedToken);

      optionalAuthMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_header_token');
      expect(req.user).toEqual(mockDecodedToken);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should call next and not set req.user if an invalid token is provided', () => {
      req.cookies.auth_token = 'invalid_token';
      authService.verifyJWT.mockReturnValue(null);

      optionalAuthMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('invalid_token');
      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('authMiddleware', () => {
    it('should return 401 if no token is provided', () => {
      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token não fornecido' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 if token is invalid', () => {
      req.cookies.auth_token = 'invalid_token';
      authService.verifyJWT.mockReturnValue(null);

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido ou expirado' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should set req.user and call next if token is valid', () => {
      const mockDecodedToken = { id: 1, username: 'testuser' };
      req.cookies.auth_token = 'valid_token';
      authService.verifyJWT.mockReturnValue(mockDecodedToken);

      authMiddleware(req, res, next);

      expect(req.user).toEqual(mockDecodedToken);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
