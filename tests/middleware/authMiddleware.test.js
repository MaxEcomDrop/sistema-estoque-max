const { optionalAuthMiddleware } = require('../../src/middleware/authMiddleware');
const authService = require('../../src/services/authService');

jest.mock('../../src/services/authService', () => ({
  verifyJWT: jest.fn(),
  saveOrUpdateUser: jest.fn(),
  getUserByBlingId: jest.fn(),
  generateJWT: jest.fn(),
  isTokenExpired: jest.fn(),
  refreshUserToken: jest.fn(),
}));

describe('Auth Middleware - optionalAuthMiddleware', () => {
  let mockReq;
  let mockRes;
  let mockNext;

  beforeEach(() => {
    mockReq = {
      cookies: {},
      headers: {},
    };
    mockRes = {};
    mockNext = jest.fn();
    jest.clearAllMocks();
  });

  it('should call next() and not set req.user if no token is provided', () => {
    optionalAuthMiddleware(mockReq, mockRes, mockNext);

    expect(authService.verifyJWT).not.toHaveBeenCalled();
    expect(mockReq.user).toBeUndefined();
    expect(mockNext).toHaveBeenCalledTimes(1);
  });

  it('should set req.user and call next() if valid token is provided in cookies', () => {
    const validToken = 'valid.token.cookie';
    const decodedPayload = { userId: 1, role: 'admin' };

    mockReq.cookies.auth_token = validToken;
    authService.verifyJWT.mockReturnValue(decodedPayload);

    optionalAuthMiddleware(mockReq, mockRes, mockNext);

    expect(authService.verifyJWT).toHaveBeenCalledWith(validToken);
    expect(mockReq.user).toEqual(decodedPayload);
    expect(mockNext).toHaveBeenCalledTimes(1);
  });

  it('should set req.user and call next() if valid token is provided in headers', () => {
    const validToken = 'valid.token.header';
    const decodedPayload = { userId: 2, role: 'user' };

    mockReq.headers.authorization = `Bearer ${validToken}`;
    authService.verifyJWT.mockReturnValue(decodedPayload);

    optionalAuthMiddleware(mockReq, mockRes, mockNext);

    expect(authService.verifyJWT).toHaveBeenCalledWith(validToken);
    expect(mockReq.user).toEqual(decodedPayload);
    expect(mockNext).toHaveBeenCalledTimes(1);
  });

  it('should call next() and not set req.user if an invalid token is provided', () => {
    const invalidToken = 'invalid.token';

    mockReq.headers.authorization = `Bearer ${invalidToken}`;
    authService.verifyJWT.mockReturnValue(null);

    optionalAuthMiddleware(mockReq, mockRes, mockNext);

    expect(authService.verifyJWT).toHaveBeenCalledWith(invalidToken);
    expect(mockReq.user).toBeUndefined();
    expect(mockNext).toHaveBeenCalledTimes(1);
  });
});
