const jwt = require('jsonwebtoken');
const authService = require('./authService');

// Mock db and other dependencies imported in authService that aren't needed for this test
jest.mock('../../config/database', () => ({
  get: jest.fn(),
  run: jest.fn()
}));
jest.mock('./blingService', () => ({}));

describe('authService', () => {
  describe('verifyJWT', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
      process.env.JWT_SECRET = 'test-secret';
    });

    afterEach(() => {
      process.env = originalEnv;
      jest.clearAllMocks();
    });

    it('should return decoded token when a valid token is provided', () => {
      // Arrange
      const payload = { userId: 123 };
      const validToken = jwt.sign(payload, process.env.JWT_SECRET);

      // Act
      const result = authService.verifyJWT(validToken);

      // Assert
      expect(result).not.toBeNull();
      expect(result).toHaveProperty('userId', 123);
      // jwt.verify also adds iat (issued at) to the decoded token
      expect(result).toHaveProperty('iat');
    });

    it('should return null when an invalid token is provided', () => {
      // Arrange
      const invalidToken = 'this-is-not-a-valid-token';

      // Act
      const result = authService.verifyJWT(invalidToken);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when token was signed with a different secret', () => {
      // Arrange
      const payload = { userId: 123 };
      const wrongSecretToken = jwt.sign(payload, 'wrong-secret');

      // Act
      const result = authService.verifyJWT(wrongSecretToken);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when token is expired', () => {
      // Arrange
      const payload = { userId: 123 };
      // Create a token that expires immediately (-10s)
      const expiredToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '-10s' });

      // Act
      const result = authService.verifyJWT(expiredToken);

      // Assert
      expect(result).toBeNull();
    });
  });
});
