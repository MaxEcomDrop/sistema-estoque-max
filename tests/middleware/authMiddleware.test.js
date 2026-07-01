// Mock database to prevent sqlite3 loading error
jest.mock('../../config/database', () => ({}));
jest.mock('../../config/database-vercel', () => ({}));

// Now require the modules
const { authMiddleware, optionalAuthMiddleware } = require('../../src/middleware/authMiddleware');
const authService = require('../../src/services/authService');

// Mock express req/res
const mockRequest = (cookies = {}, headers = {}) => ({
  cookies,
  headers
});

const mockResponse = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

// Mock authService - Need a factory function as specified in Memory
jest.mock('../../src/services/authService', () => ({
  verifyJWT: jest.fn(),
  hashPassword: jest.fn(),
  comparePassword: jest.fn(),
  generateJWT: jest.fn()
}));

describe('authMiddleware', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = mockRequest();
    res = mockResponse();
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

    it('should return 401 if token is not found in either cookie or header', () => {
      req.headers.authorization = 'Bearer'; // Missing actual token part

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token não fornecido' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should call next if valid token is provided in cookies', () => {
      req.cookies.auth_token = 'valid-token';
      const decodedUser = { id: 1, name: 'Test' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid-token');
      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });

    it('should call next if valid token is provided in headers', () => {
      req.headers.authorization = 'Bearer valid-header-token';
      const decodedUser = { id: 2, name: 'Test Header' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid-header-token');
      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });

    it('should return 401 if token is invalid or expired', () => {
      req.cookies.auth_token = 'invalid-token';
      authService.verifyJWT.mockReturnValue(null);

      authMiddleware(req, res, next);

      expect(authService.verifyJWT).toHaveBeenCalledWith('invalid-token');
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido ou expirado' });
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
      req.cookies.auth_token = 'invalid-token';
      authService.verifyJWT.mockReturnValue(null);

      optionalAuthMiddleware(req, res, next);

      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('should call next and set req.user if valid token is provided', () => {
      req.cookies.auth_token = 'valid-token';
      const decodedUser = { id: 3, name: 'Optional User' };
      authService.verifyJWT.mockReturnValue(decodedUser);

      optionalAuthMiddleware(req, res, next);

      expect(req.user).toEqual(decodedUser);
      expect(next).toHaveBeenCalled();
    });
  });
});
