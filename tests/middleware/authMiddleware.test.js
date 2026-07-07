const MockExpressRequest = require('mock-express-request');
const MockExpressResponse = require('mock-express-response');

describe('Auth Middleware', () => {
  let authMiddleware;
  let authService;

  beforeEach(() => {
    jest.resetModules();

    // Mock the database dependency
    jest.mock('../../config/database', () => ({}));

    // Mock authService
    jest.mock('../../src/services/authService', () => ({
      verifyJWT: jest.fn()
    }));

    authService = require('../../src/services/authService');
    const authMiddlewareModule = require('../../src/middleware/authMiddleware');
    authMiddleware = authMiddlewareModule.authMiddleware;
  });

  it('should return 401 if no token is provided', () => {
    const req = new MockExpressRequest();
    const res = new MockExpressResponse();
    const next = jest.fn();

    authMiddleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res._getJSON()).toEqual({ error: 'Token não fornecido' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 if an invalid token is provided', () => {
    const req = new MockExpressRequest({
      cookies: { auth_token: 'invalid_token' }
    });
    const res = new MockExpressResponse();
    const next = jest.fn();

    authService.verifyJWT.mockReturnValue(null);

    authMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('invalid_token');
    expect(res.statusCode).toBe(401);
    expect(res._getJSON()).toEqual({ error: 'Token inválido ou expirado' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should call next and set req.user if a valid token is provided via cookies', () => {
    const req = new MockExpressRequest({
      cookies: { auth_token: 'valid_token_cookie' }
    });
    const res = new MockExpressResponse();
    const next = jest.fn();

    const decodedToken = { id: 1, email: 'admin@max.com' };
    authService.verifyJWT.mockReturnValue(decodedToken);

    authMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token_cookie');
    expect(req.user).toEqual(decodedToken);
    expect(next).toHaveBeenCalled();
  });

  it('should call next and set req.user if a valid token is provided via authorization header', () => {
    const req = new MockExpressRequest({
      headers: { authorization: 'Bearer valid_token_header' }
    });
    const res = new MockExpressResponse();
    const next = jest.fn();

    const decodedToken = { id: 2, email: 'user@max.com' };
    authService.verifyJWT.mockReturnValue(decodedToken);

    authMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token_header');
    expect(req.user).toEqual(decodedToken);
    expect(next).toHaveBeenCalled();
  });
});
