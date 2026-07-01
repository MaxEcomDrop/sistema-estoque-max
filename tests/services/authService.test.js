jest.mock('../../config/database', () => ({
  get: jest.fn(),
  run: jest.fn()
}));

const db = require('../../config/database');
const authService = require('../../src/services/authService');

describe('authService.getUserByBlingId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should resolve with the user when db.get succeeds', async () => {
    const mockBlingUserId = '12345';
    const mockUser = { id: 1, bling_user_id: '12345', access_token: 'token' };

    // When mocking SQLite (node-sqlite3) operations like db.run in Jest,
    // use standard function declarations instead of arrow functions to preserve the required lexical this binding (e.g., callback.call(this, null)).
    // For db.get, the callback is the last argument.
    db.get.mockImplementation(function(query, params, callback) {
      callback.call(this, null, mockUser);
    });

    const result = await authService.getUserByBlingId(mockBlingUserId);

    expect(db.get).toHaveBeenCalledWith(
      'SELECT * FROM users WHERE bling_user_id = ?',
      [mockBlingUserId],
      expect.any(Function)
    );
    expect(result).toEqual(mockUser);
  });

  it('should reject with an error when db.get fails', async () => {
    const mockBlingUserId = '12345';
    const mockError = new Error('Database connection failed');

    db.get.mockImplementation(function(query, params, callback) {
      callback.call(this, mockError, null);
    });

    await expect(authService.getUserByBlingId(mockBlingUserId)).rejects.toThrow('Database connection failed');

    expect(db.get).toHaveBeenCalledWith(
      'SELECT * FROM users WHERE bling_user_id = ?',
      [mockBlingUserId],
      expect.any(Function)
    );
  });
});
