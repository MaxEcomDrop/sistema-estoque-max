const webhookController = require('./webhookController');

jest.mock('../../config/database', () => ({
  run: jest.fn(),
  get: jest.fn()
}));

describe('webhookController', () => {
  describe('getWebhookStatus', () => {
    it('should return the correct status message and supported events', () => {
      const req = {};
      const res = {
        json: jest.fn()
      };

      webhookController.getWebhookStatus(req, res);

      expect(res.json).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({
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
