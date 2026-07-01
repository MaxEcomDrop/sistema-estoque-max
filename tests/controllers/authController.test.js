const authController = require('../../src/controllers/authController');
const blingService = require('../../src/services/blingService');
const authService = require('../../src/services/authService');
const db = require('../../config/database');

jest.mock('../../src/services/blingService');
jest.mock('../../src/services/authService');
jest.mock('../../config/database');

describe('authController', () => {
  describe('handleCallback', () => {
    it('should return 400 if authorization code is not provided', async () => {
      const req = {
        query: {}
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await authController.handleCallback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Código de autorização não fornecido' });
    });
  });
});
