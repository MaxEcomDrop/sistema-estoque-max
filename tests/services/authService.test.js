const jwt = require('jsonwebtoken');

// Mock dependências que causam erro no require
jest.mock('../../config/database', () => ({}));
jest.mock('../../src/services/blingService', () => ({}));

const authService = require('../../src/services/authService');

describe('authService', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
  });

  describe('verifyJWT', () => {
    it('should return decoded token for valid token', () => {
      const payload = { userId: 1 };
      const token = jwt.sign(payload, process.env.JWT_SECRET);

      const decoded = authService.verifyJWT(token);

      expect(decoded.userId).toBe(payload.userId);
    });

    it('should return null for invalid token', () => {
      const invalidToken = 'invalid.token.string';

      const decoded = authService.verifyJWT(invalidToken);

      expect(decoded).toBeNull();
    });
  });
});
