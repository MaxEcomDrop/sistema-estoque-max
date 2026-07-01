jest.mock('../../config/database', () => ({}));
jest.mock('../../src/services/blingService', () => ({}));
jest.mock('../../src/services/authService', () => ({}));

const authController = require('../../src/controllers/authController');

describe('authController.logout', () => {
  it('should clear the auth_token cookie and return a success message', () => {
    const req = {};
    const res = {
      clearCookie: jest.fn(),
      json: jest.fn()
    };

    authController.logout(req, res);

    expect(res.clearCookie).toHaveBeenCalledWith('auth_token');
    expect(res.json).toHaveBeenCalledWith({ message: 'Desconectado com sucesso' });
  });
});
