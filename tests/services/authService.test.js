const jwt = require('jsonwebtoken');
const authService = require('../../src/services/authService');

jest.mock('jsonwebtoken');

describe('authService - generateJWT', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, JWT_SECRET: 'test-secret' };
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should generate a JWT token with correct payload, secret, and options', () => {
    // Arrange
    const userId = 123;
    const expectedToken = 'mocked-jwt-token';
    jwt.sign.mockReturnValue(expectedToken);

    // Act
    const token = authService.generateJWT(userId);

    // Assert
    expect(token).toBe(expectedToken);
    expect(jwt.sign).toHaveBeenCalledTimes(1);
    expect(jwt.sign).toHaveBeenCalledWith(
      { userId },
      'test-secret',
      { expiresIn: '7d' }
    );
  });
});

describe('authService - verifyJWT', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, JWT_SECRET: 'test-secret' };
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should verify and return decoded payload for a valid token', () => {
    const token = 'valid-token';
    const decodedPayload = { userId: 123 };
    jwt.verify.mockReturnValue(decodedPayload);

    const result = authService.verifyJWT(token);

    expect(result).toBe(decodedPayload);
    expect(jwt.verify).toHaveBeenCalledTimes(1);
    expect(jwt.verify).toHaveBeenCalledWith(token, 'test-secret');
  });

  it('should return null for an invalid token', () => {
    const token = 'invalid-token';
    jwt.verify.mockImplementation(() => {
      throw new Error('invalid signature');
    });

    const result = authService.verifyJWT(token);

    expect(result).toBeNull();
    expect(jwt.verify).toHaveBeenCalledTimes(1);
    expect(jwt.verify).toHaveBeenCalledWith(token, 'test-secret');
  });
});
