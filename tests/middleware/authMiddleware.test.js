jest.mock('../../config/database', () => ({}));
jest.mock('../../src/services/authService', () => ({
  verifyJWT: jest.fn()
}));

const authService = require('../../src/services/authService');
const { authMiddleware, optionalAuthMiddleware } = require('../../src/middleware/authMiddleware');

describe('authMiddleware', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = {
      headers: {},
      cookies: {}
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
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

  it('should return 401 if token is provided but invalid', () => {
    req.headers = { authorization: 'Bearer invalid_token' };
    authService.verifyJWT.mockReturnValue(null);

    authMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('invalid_token');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido ou expirado' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should call next and set req.user if token is valid', () => {
    req.headers = { authorization: 'Bearer valid_token' };
    const decodedToken = { id: 1, email: 'test@example.com' };
    authService.verifyJWT.mockReturnValue(decodedToken);

    authMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token');
    expect(req.user).toEqual(decodedToken);
    expect(next).toHaveBeenCalled();
  });

  it('should accept token from cookies', () => {
    req.cookies = { auth_token: 'cookie_token' };
    const decodedToken = { id: 1, email: 'test@example.com' };
    authService.verifyJWT.mockReturnValue(decodedToken);

    authMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('cookie_token');
    expect(req.user).toEqual(decodedToken);
    expect(next).toHaveBeenCalled();
  });
});

describe('optionalAuthMiddleware', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = {
      headers: {},
      cookies: {}
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  it('should call next even if no token is provided', () => {
    optionalAuthMiddleware(req, res, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('should call next and not set req.user if token is invalid', () => {
    req.headers = { authorization: 'Bearer invalid_token' };
    authService.verifyJWT.mockReturnValue(null);

    optionalAuthMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('invalid_token');
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('should call next and set req.user if token is valid', () => {
    req.headers = { authorization: 'Bearer valid_token' };
    const decodedToken = { id: 1, email: 'test@example.com' };
    authService.verifyJWT.mockReturnValue(decodedToken);

    optionalAuthMiddleware(req, res, next);

    expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token');
    expect(req.user).toEqual(decodedToken);
    expect(next).toHaveBeenCalled();
  });
});
