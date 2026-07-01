jest.mock('../config/database', () => ({
  run: jest.fn(),
  get: jest.fn()
}));
jest.mock('../src/services/blingService');
jest.mock('../src/services/authService');

const { handleBlingWebhook } = require('../src/controllers/webhookController');

describe('webhookController', () => {
  describe('handleBlingWebhook', () => {
    let req;
    let res;

    beforeEach(() => {
      // Mock para as requisições
      req = {
        body: {}
      };

      // Mock para as respostas
      res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      // Suprimir o console.log e console.error durante os testes para manter o output limpo
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return 400 when tipo is missing', async () => {
      req.body = {
        idRegistro: '123',
        sequencia: '1'
      };

      await handleBlingWebhook(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Parâmetros obrigatórios não fornecidos' });
    });

    it('should return 400 when idRegistro is missing', async () => {
      req.body = {
        tipo: 'produto.criacao',
        sequencia: '1'
      };

      await handleBlingWebhook(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Parâmetros obrigatórios não fornecidos' });
    });

    it('should return 400 when both tipo and idRegistro are missing', async () => {
      req.body = {
        sequencia: '1'
      };

      await handleBlingWebhook(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Parâmetros obrigatórios não fornecidos' });
    });

    it('should return 400 when req.body is completely empty', async () => {
      req.body = {};

      await handleBlingWebhook(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Parâmetros obrigatórios não fornecidos' });
    });
  });
});
