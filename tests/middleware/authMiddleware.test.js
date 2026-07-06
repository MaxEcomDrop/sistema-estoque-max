jest.mock('../../config/database', () => ({
  run: jest.fn(),
  get: jest.fn(),
  all: jest.fn()
}));

jest.mock('../../src/services/authService', () => ({
  verifyJWT: jest.fn()
}));

const { authMiddleware, optionalAuthMiddleware } = require('../../src/middleware/authMiddleware');
const authService = require('../../src/services/authService');

describe('authMiddleware', () => {
  let req, res, next;

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

  it('should return 401 if no token is provided', () => {
    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token não fornecido' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 if token is provided but verifyJWT returns null', () => {
    req.cookies.auth_token = 'invalid-token';
    authService.verifyJWT.mockReturnValue(null);

    authMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('invalid-token');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido ou expirado' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should call next and set req.user if token is valid (from cookie)', () => {
    req.cookies.auth_token = 'valid-token';
    const decodedUser = { id: 1, name: 'Test' };
    authService.verifyJWT.mockReturnValue(decodedUser);

    authMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('valid-token');
    expect(req.user).toEqual(decodedUser);
    expect(next).toHaveBeenCalled();
  });

  it('should call next and set req.user if token is valid (from header)', () => {
    req.headers.authorization = 'Bearer valid-header-token';
    const decodedUser = { id: 1, name: 'Test' };
    authService.verifyJWT.mockReturnValue(decodedUser);

    authMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('valid-header-token');
    expect(req.user).toEqual(decodedUser);
    expect(next).toHaveBeenCalled();
  });
});

describe('optionalAuthMiddleware', () => {
  let req, res, next;

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

  it('should call next without setting req.user if no token is provided', () => {
    optionalAuthMiddleware(req, res, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('should call next without setting req.user if token is provided but invalid', () => {
    req.cookies.auth_token = 'invalid-token';
    authService.verifyJWT.mockReturnValue(null);

    optionalAuthMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('invalid-token');
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('should call next and set req.user if valid token is provided', () => {
    req.cookies.auth_token = 'valid-token';
    const decodedUser = { id: 1, name: 'Test' };
    authService.verifyJWT.mockReturnValue(decodedUser);

    optionalAuthMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('valid-token');
    expect(req.user).toEqual(decodedUser);
    expect(next).toHaveBeenCalled();
  });
});
