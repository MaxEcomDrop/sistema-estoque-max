const authService = require('./authService');
const db = require('../../config/database');
const blingService = require('./blingService');

jest.mock('../../config/database', () => ({
  get: jest.fn(),
  run: jest.fn()
}));

jest.mock('./blingService');

describe('authService - saveOrUpdateUser', () => {
  const blingUserId = '12345';
  const tokenData = {
    access_token: 'access123',
    refresh_token: 'refresh123',
    expires_in: 3600
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should insert a new user if user does not exist', async () => {
    db.get.mockImplementation((query, params, callback) => {
      callback(null, null); // No user found
    });

    db.run.mockImplementation(function (query, params, callback) {
      // Simulate successful insert, 'this' context will have lastID
      const context = { lastID: 10 };
      callback.call(context, null);
    });

    const result = await authService.saveOrUpdateUser(blingUserId, tokenData);

    expect(db.get).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledTimes(1);
    expect(db.run.mock.calls[0][0]).toContain('INSERT INTO users');
    expect(db.run.mock.calls[0][1][0]).toBe(blingUserId);
    expect(db.run.mock.calls[0][1][1]).toBe(tokenData.access_token);
    expect(db.run.mock.calls[0][1][2]).toBe(tokenData.refresh_token);
    expect(result).toBe(10);
  });

  test('should update user if user already exists', async () => {
    const existingUser = { id: 20 };
    db.get.mockImplementation((query, params, callback) => {
      callback(null, existingUser);
    });

    db.run.mockImplementation(function (query, params, callback) {
      // Simulate successful update
      callback(null);
    });

    const result = await authService.saveOrUpdateUser(blingUserId, tokenData);

    expect(db.get).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledTimes(1);
    expect(db.run.mock.calls[0][0]).toContain('UPDATE users SET');
    expect(db.run.mock.calls[0][1][0]).toBe(tokenData.access_token);
    expect(db.run.mock.calls[0][1][1]).toBe(tokenData.refresh_token);
    expect(db.run.mock.calls[0][1][3]).toBe(blingUserId);
    expect(result).toBe(20);
  });

  test('should reject if db.get throws an error', async () => {
    const dbError = new Error('Database connection failed');
    db.get.mockImplementation((query, params, callback) => {
      callback(dbError, null);
    });

    await expect(authService.saveOrUpdateUser(blingUserId, tokenData)).rejects.toThrow('Database connection failed');
    expect(db.get).toHaveBeenCalledTimes(1);
    expect(db.run).not.toHaveBeenCalled();
  });

  test('should reject if db.run fails during INSERT', async () => {
    db.get.mockImplementation((query, params, callback) => {
      callback(null, null); // No user found
    });

    const dbError = new Error('Insert failed');
    db.run.mockImplementation(function (query, params, callback) {
      callback.call(this, dbError);
    });

    await expect(authService.saveOrUpdateUser(blingUserId, tokenData)).rejects.toThrow('Insert failed');
    expect(db.get).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledTimes(1);
    expect(db.run.mock.calls[0][0]).toContain('INSERT INTO users');
  });

  test('should reject if db.run fails during UPDATE', async () => {
    const existingUser = { id: 30 };
    db.get.mockImplementation((query, params, callback) => {
      callback(null, existingUser); // User found
    });

    const dbError = new Error('Update failed');
    db.run.mockImplementation(function (query, params, callback) {
      callback(dbError);
    });

    await expect(authService.saveOrUpdateUser(blingUserId, tokenData)).rejects.toThrow('Update failed');
    expect(db.get).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledTimes(1);
    expect(db.run.mock.calls[0][0]).toContain('UPDATE users SET');
  });
});
