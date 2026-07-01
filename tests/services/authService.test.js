jest.mock('../../config/database', () => {
  return {
    get: jest.fn(),
    run: jest.fn()
  };
});

const { isTokenExpired } = require('../../src/services/authService');

describe('authService - isTokenExpired', () => {
  const CURRENT_TIME_MS = 1600000000000; // Mock current time in ms
  const CURRENT_TIME_SEC = Math.floor(CURRENT_TIME_MS / 1000); // 1600000000

  beforeAll(() => {
    // Mock Date.now() to return a fixed timestamp for deterministic testing
    jest.spyOn(Date, 'now').mockImplementation(() => CURRENT_TIME_MS);
  });

  afterAll(() => {
    // Restore original Date.now()
    jest.restoreAllMocks();
  });

  it('should return true if the token is expired (expires_at is in the past)', () => {
    const user = { expires_at: CURRENT_TIME_SEC - 100 }; // 100 seconds in the past
    expect(isTokenExpired(user)).toBe(true);
  });

  it('should return false if the token is active (expires_at is in the future)', () => {
    const user = { expires_at: CURRENT_TIME_SEC + 100 }; // 100 seconds in the future
    expect(isTokenExpired(user)).toBe(false);
  });

  it('should return false if the token expires exactly at the current second', () => {
    // Boundary case: if user.expires_at == current time, it shouldn't be considered expired yet
    // because the condition is `user.expires_at < current time`
    const user = { expires_at: CURRENT_TIME_SEC };
    expect(isTokenExpired(user)).toBe(false);
  });
});
