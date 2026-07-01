const jwt = require('jsonwebtoken');

// Mock dependencies before requiring authService
jest.mock('../config/database', () => ({
  get: jest.fn(),
  run: jest.fn()
}));
jest.mock('../src/services/blingService', () => ({
  refreshAccessToken: jest.fn()
}));

let authService;

describe('authService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.env.JWT_SECRET = 'testsecret';

    // Require authService inside beforeEach so it gets re-evaluated
    // and uses the new process.env variables (if applicable) and fresh mocks
    authService = require('../src/services/authService');
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('generateJWT', () => {
    it('should generate a valid JWT containing the userId', () => {
      const userId = 123;
      const token = authService.generateJWT(userId);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      expect(decoded.userId).toBe(userId);
    });

    it('should set an expiration of 7 days', () => {
      const userId = 123;
      const token = authService.generateJWT(userId);
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      expect(decoded.exp).toBeDefined();
      expect(decoded.iat).toBeDefined();

      // 7 days in seconds = 7 * 24 * 60 * 60 = 604800
      expect(decoded.exp - decoded.iat).toBe(604800);
    });
  });
});
