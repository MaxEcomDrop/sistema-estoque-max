// Mock the database dependency BEFORE requiring the modules that use it
jest.mock('../../config/database', () => ({}));
jest.mock('../../config/database-vercel', () => ({}));

const { authMiddleware, optionalAuthMiddleware } = require('../../src/middleware/authMiddleware');
const authService = require('../../src/services/authService');
const MockExpressRequest = require('mock-express-request');
const MockExpressResponse = require('mock-express-response');

jest.mock('../../src/services/authService');

describe('authMiddleware', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = new MockExpressRequest();
    res = new MockExpressResponse();
    next = jest.fn();
    jest.clearAllMocks();
  });

  describe('authMiddleware', () => {
    it('should return 401 if no token is provided', () => {
      // req.cookies and req.headers.authorization are empty by default in MockExpressRequest

      authMiddleware(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res._getJSON()).toEqual({ error: 'Token não fornecido' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should call next if token is valid (from cookies)', () => {
      req.cookies = { auth_token: 'valid-token' };
      const decodedUser = { id: 1, name: 'User' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid-token');
      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });

    it('should call next if token is valid (from headers)', () => {
      req.headers = { authorization: 'Bearer valid-token-header' };
      const decodedUser = { id: 1, name: 'User' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid-token-header');
      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });

    it('should return 401 if token is invalid', () => {
      req.cookies = { auth_token: 'invalid-token' };
      authService.verifyJWT.mockReturnValue(null);

      authMiddleware(req, res, next);

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

    it('should set req.user and call next if token is valid', () => {
      req.cookies = { auth_token: 'valid-token' };
      const decodedUser = { id: 1, name: 'User' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      optionalAuthMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid-token');
      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });

    it('should call next without setting req.user if token is invalid', () => {
      req.cookies = { auth_token: 'invalid-token' };
      authService.verifyJWT.mockReturnValue(null);

      optionalAuthMiddleware(req, res, next);

      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });
  });
});
