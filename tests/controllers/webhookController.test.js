jest.mock('../../config/database', () => ({
  run: jest.fn(),
  get: jest.fn(),
  serialize: jest.fn(),
}));

jest.mock('../../src/services/blingService', () => ({
  getProdutoById: jest.fn(),
}));

jest.mock('../../src/services/authService', () => ({
  isTokenExpired: jest.fn(),
  refreshUserToken: jest.fn(),
}));

const MockRequest = require('mock-express-request');
const MockResponse = require('mock-express-response');
const webhookController = require('../../src/controllers/webhookController');

describe('webhookController', () => {
  describe('getWebhookStatus', () => {
    it('should return webhook status with supported events and endpoint', () => {
      const req = new MockRequest();
      const res = new MockResponse();

      webhookController.getWebhookStatus(req, res);

      expect(res.statusCode).toBe(200);

      // Parse the JSON since we are using mock-express-response
      const responseData = JSON.parse(res._getString());

      expect(responseData).toEqual({
        message: 'Webhook do Bling está funcionando',
        supported_events: [
          'produto.criacao',
          'produto.atualizacao',
          'estoque.atualizacao',
        ],
        endpoint: '/api/webhook/bling',
      });
    });
  });
});
