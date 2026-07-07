jest.mock('../../config/database', () => {
  return {
    run: jest.fn(),
    get: jest.fn(),
    all: jest.fn(),
  };
});

const { authMiddleware, optionalAuthMiddleware } = require('../../src/middleware/authMiddleware');
const authService = require('../../src/services/authService');
const httpMocks = require('node-mocks-http');

jest.mock('../../src/services/authService');

describe('Auth Middleware', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = httpMocks.createRequest();
    res = httpMocks.createResponse();
    next = jest.fn();
    jest.clearAllMocks();
  });

  describe('authMiddleware', () => {
    it('should return 401 if no token is provided', () => {
      authMiddleware(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res._getJSONData()).toEqual({ error: 'Token não fornecido' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should call next and set req.user if valid token is provided in cookies', () => {
      req.cookies = { auth_token: 'valid_token' };
      const decodedToken = { id: 1, email: 'test@test.com' };
      authService.verifyJWT.mockReturnValue(decodedToken);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token');
      expect(req.user).toEqual(decodedToken);
      expect(next).toHaveBeenCalled();
    });

    it('should call next and set req.user if valid token is provided in authorization header', () => {
      req.headers = { authorization: 'Bearer valid_token' };
      const decodedToken = { id: 1, email: 'test@test.com' };
      authService.verifyJWT.mockReturnValue(decodedToken);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token');
      expect(req.user).toEqual(decodedToken);
      expect(next).toHaveBeenCalled();
    });

    it('should return 401 if token is invalid or expired', () => {
      req.cookies = { auth_token: 'invalid_token' };
      authService.verifyJWT.mockReturnValue(null);

      authMiddleware(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res._getJSONData()).toEqual({ error: 'Token inválido ou expirado' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('optionalAuthMiddleware', () => {
    it('should call next and not set req.user if no token is provided', () => {
      optionalAuthMiddleware(req, res, next);

      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('should call next and set req.user if valid token is provided in cookies', () => {
      req.cookies = { auth_token: 'valid_token' };
      const decodedToken = { id: 1, email: 'test@test.com' };
      authService.verifyJWT.mockReturnValue(decodedToken);

      optionalAuthMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token');
      expect(req.user).toEqual(decodedToken);
      expect(next).toHaveBeenCalled();
    });

    it('should call next and set req.user if valid token is provided in authorization header', () => {
      req.headers = { authorization: 'Bearer valid_token' };
      const decodedToken = { id: 1, email: 'test@test.com' };
      authService.verifyJWT.mockReturnValue(decodedToken);

      optionalAuthMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token');
      expect(req.user).toEqual(decodedToken);
      expect(next).toHaveBeenCalled();
    });

    it('should call next and not set req.user if token is invalid or expired', () => {
      req.cookies = { auth_token: 'invalid_token' };
      authService.verifyJWT.mockReturnValue(null);

      optionalAuthMiddleware(req, res, next);

      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });
  });
});
