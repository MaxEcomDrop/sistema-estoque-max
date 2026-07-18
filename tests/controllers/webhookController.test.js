jest.mock('../../config/database', () => {
  return {
    run: jest.fn(),
    get: jest.fn(),
    all: jest.fn()
  };
});

const webhookController = require('../../src/controllers/webhookController');

describe('webhookController', () => {
  describe('getWebhookStatus', () => {
    it('should return webhook status', () => {
      const req = {};
      const res = {
        json: jest.fn()
      };

      webhookController.getWebhookStatus(req, res);

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
