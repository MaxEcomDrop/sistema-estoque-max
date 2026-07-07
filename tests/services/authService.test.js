const authService = require('../../src/services/authService');
const db = require('../../config/database');

// Mock the database module
jest.mock('../../config/database', () => ({
  get: jest.fn(),
  run: jest.fn()
}));

describe('authService - getUserByBlingId', () => {
  beforeEach(() => {
    // Clear mock calls before each test
    jest.clearAllMocks();
  });

  it('should resolve with the user when found', async () => {
    const mockBlingUserId = 'bling123';
    const mockUser = { id: 1, bling_user_id: mockBlingUserId, name: 'Test User' };

    // Setup the mock to simulate a successful database query finding a user
    db.get.mockImplementation((query, params, callback) => {
      callback(null, mockUser);
    });

    const result = await authService.getUserByBlingId(mockBlingUserId);

    // Assert the result matches the mocked user
    expect(result).toEqual(mockUser);

    // Assert db.get was called with correct parameters
    expect(db.get).toHaveBeenCalledWith(
      'SELECT * FROM users WHERE bling_user_id = ?',
      [mockBlingUserId],
      expect.any(Function)
    );
  });

  it('should resolve with undefined when the user is not found', async () => {
    const mockBlingUserId = 'bling_not_found';

    // Setup the mock to simulate a successful database query finding no user
    db.get.mockImplementation((query, params, callback) => {
      callback(null, undefined);
    });

    const result = await authService.getUserByBlingId(mockBlingUserId);

    // Assert the result is undefined
    expect(result).toBeUndefined();

    // Assert db.get was called with correct parameters
    expect(db.get).toHaveBeenCalledWith(
      'SELECT * FROM users WHERE bling_user_id = ?',
      [mockBlingUserId],
      expect.any(Function)
    );
  });

  it('should reject with an error when a database error occurs', async () => {
    const mockBlingUserId = 'bling_error';
    const mockError = new Error('Database connection failed');

    // Setup the mock to simulate a database error
    db.get.mockImplementation((query, params, callback) => {
      callback(mockError, null);
    });

    // Assert the promise rejects with the mocked error
    await expect(authService.getUserByBlingId(mockBlingUserId)).rejects.toThrow(mockError);

    // Assert db.get was called with correct parameters
    expect(db.get).toHaveBeenCalledWith(
      'SELECT * FROM users WHERE bling_user_id = ?',
      [mockBlingUserId],
      expect.any(Function)
    );
  });
});
