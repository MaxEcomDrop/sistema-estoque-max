const { handleBlingWebhook } = require('../../src/controllers/webhookController');
const MockRequest = require('mock-express-request');
const MockResponse = require('mock-express-response');

// Mock dependencies
jest.mock('../../config/database', () => ({
  run: jest.fn(),
  get: jest.fn(),
  serialize: jest.fn(),
}));
jest.mock('../../src/services/blingService');
jest.mock('../../src/services/authService');

describe('webhookController', () => {
  let req;
  let res;

  beforeEach(() => {
    jest.clearAllMocks();
    res = new MockResponse();
    // Spy on json and status to check calls easily
    res.json = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
  });

  describe('handleBlingWebhook', () => {
    it('should return 400 if tipo is missing', async () => {
      req = new MockRequest({
        body: { idRegistro: '123' },
      });

      await handleBlingWebhook(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Parâmetros obrigatórios não fornecidos' });
    });

    it('should return 400 if idRegistro is missing', async () => {
      req = new MockRequest({
        body: { tipo: 'produto.criacao' },
      });

      await handleBlingWebhook(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Parâmetros obrigatórios não fornecidos' });
    });

    it('should return 400 if both tipo and idRegistro are missing', async () => {
      req = new MockRequest({
        body: {},
      });

      await handleBlingWebhook(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Parâmetros obrigatórios não fornecidos' });
    });

    it('should process correctly with required parameters', async () => {
      req = new MockRequest({
        body: { tipo: 'teste.evento', idRegistro: '123' },
      });

      await handleBlingWebhook(req, res);

      // Verify that status 400 wasn't called
      expect(res.status).not.toHaveBeenCalledWith(400);

      // Verify success response
      expect(res.json).toHaveBeenCalledWith({
        message: 'Webhook recebido com sucesso',
        tipo: 'teste.evento',
        idRegistro: '123'
      });
    });
  });
});
