const authController = require('../../src/controllers/authController');
const blingService = require('../../src/services/blingService');

jest.mock('../../src/services/blingService');
jest.mock('../../config/database', () => ({}));
jest.mock('../../src/services/authService', () => ({}));

describe('authController', () => {
  describe('getAuthUrl', () => {
    it('should return authUrl in JSON format', () => {
      // Mock request and response
      const req = {};
      const res = {
        json: jest.fn(),
      };

      // Mock the expected URL
      const mockUrl = 'https://bling.com.br/Api/v3/oauth/authorize?client_id=test&state=123';
      blingService.getAuthorizationUrl.mockReturnValue(mockUrl);

      // Call the function
      authController.getAuthUrl(req, res);

      // Verify blingService was called
      expect(blingService.getAuthorizationUrl).toHaveBeenCalled();

      // Verify the response
      expect(res.json).toHaveBeenCalledWith({ authUrl: mockUrl });
    });
  });
});
