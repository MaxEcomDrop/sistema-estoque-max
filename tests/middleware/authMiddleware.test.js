// Mock database to avoid sqlite connection logs after tests
jest.mock('../../config/database', () => ({
  run: jest.fn(),
  get: jest.fn(),
  all: jest.fn(),
  serialize: jest.fn()
}));

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

  it('should return 401 if token is not provided', () => {
    authMiddleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res._getJSON()).toEqual({ error: 'Token não fornecido' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should call next if valid token is provided in cookies', () => {
    req = new MockExpressRequest({
      cookies: { auth_token: 'valid-token' }
    });
    authService.verifyJWT.mockReturnValue({ id: 1, username: 'testuser' });

    authMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('valid-token');
    expect(req.user).toEqual({ id: 1, username: 'testuser' });
    expect(next).toHaveBeenCalled();
  });

  it('should call next if valid token is provided in headers', () => {
    req = new MockExpressRequest({
      headers: { authorization: 'Bearer valid-token-header' }
    });
    authService.verifyJWT.mockReturnValue({ id: 1, username: 'testuser' });

    authMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('valid-token-header');
    expect(req.user).toEqual({ id: 1, username: 'testuser' });
    expect(next).toHaveBeenCalled();
  });

  it('should return 401 if token is invalid', () => {
    req = new MockExpressRequest({
      cookies: { auth_token: 'invalid-token' }
    });
    authService.verifyJWT.mockReturnValue(null);

    authMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('invalid-token');
    expect(res.statusCode).toBe(401);
    expect(res._getJSON()).toEqual({ error: 'Token inválido ou expirado' });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('optionalAuthMiddleware', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = new MockExpressRequest();
    res = new MockExpressResponse();
    next = jest.fn();
    jest.clearAllMocks();
  });

  it('should call next if no token is provided', () => {
    optionalAuthMiddleware(req, res, next);

    expect(authService.verifyJWT).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('should populate req.user and call next if valid token is provided', () => {
    req = new MockExpressRequest({
      cookies: { auth_token: 'valid-token' }
    });
    authService.verifyJWT.mockReturnValue({ id: 1, username: 'testuser' });

    optionalAuthMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('valid-token');
    expect(req.user).toEqual({ id: 1, username: 'testuser' });
    expect(next).toHaveBeenCalled();
  });

  it('should call next and not populate req.user if token is invalid', () => {
    req = new MockExpressRequest({
      cookies: { auth_token: 'invalid-token' }
    });
    authService.verifyJWT.mockReturnValue(null);

    optionalAuthMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('invalid-token');
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});
