const { authMiddleware, optionalAuthMiddleware } = require('./authMiddleware');
const authService = require('../services/authService');

// Mock authService
jest.mock('../services/authService');

describe('Auth Middleware', () => {
  let mockReq;
  let mockRes;
  let mockNext;

  beforeEach(() => {
    mockReq = {
      cookies: {},
      headers: {},
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockNext = jest.fn();
    jest.clearAllMocks();
  });

  describe('authMiddleware', () => {
    it('should return 401 if no token is provided', () => {
      authMiddleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Token não fornecido' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 if token is invalid or expired', () => {
      mockReq.cookies.auth_token = 'invalid_token';
      authService.verifyJWT.mockReturnValue(null);

      authMiddleware(mockReq, mockRes, mockNext);

      expect(authService.verifyJWT).toHaveBeenCalledWith('invalid_token');
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Token inválido ou expirado' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should call next and set req.user if valid token in cookies', () => {
      const decodedToken = { id: 1, name: 'Test User' };
      mockReq.cookies.auth_token = 'valid_token_cookie';
      authService.verifyJWT.mockReturnValue(decodedToken);

      authMiddleware(mockReq, mockRes, mockNext);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token_cookie');
      expect(mockReq.user).toEqual(decodedToken);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
      expect(mockRes.json).not.toHaveBeenCalled();
    });

    it('should call next and set req.user if valid token in headers', () => {
      const decodedToken = { id: 2, name: 'Header User' };
      mockReq.headers.authorization = 'Bearer valid_token_header';
      authService.verifyJWT.mockReturnValue(decodedToken);

      authMiddleware(mockReq, mockRes, mockNext);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token_header');
      expect(mockReq.user).toEqual(decodedToken);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
      expect(mockRes.json).not.toHaveBeenCalled();
    });
  });

  describe('optionalAuthMiddleware', () => {
    it('should call next and not set req.user if no token is provided', () => {
      optionalAuthMiddleware(mockReq, mockRes, mockNext);

      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalled();
      expect(authService.verifyJWT).not.toHaveBeenCalled();
    });

    it('should call next and not set req.user if token is invalid', () => {
      mockReq.cookies.auth_token = 'invalid_token';
      authService.verifyJWT.mockReturnValue(null);

      optionalAuthMiddleware(mockReq, mockRes, mockNext);

      expect(authService.verifyJWT).toHaveBeenCalledWith('invalid_token');
      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should call next and set req.user if token is valid', () => {
      const decodedToken = { id: 3, name: 'Optional User' };
      mockReq.headers.authorization = 'Bearer valid_token_optional';
      authService.verifyJWT.mockReturnValue(decodedToken);

      optionalAuthMiddleware(mockReq, mockRes, mockNext);

      expect(authService.verifyJWT).toHaveBeenCalledWith('valid_token_optional');
      expect(mockReq.user).toEqual(decodedToken);
      expect(mockNext).toHaveBeenCalled();
    });
  });
});
