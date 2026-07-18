jest.mock('../../config/database', () => ({
  all: jest.fn(),
  get: jest.fn(),
  run: jest.fn(),
  serialize: jest.fn()
}));
jest.mock('../../src/services/blingService');
jest.mock('../../src/services/authService');

const MockExpressRequest = require('mock-express-request');
const MockExpressResponse = require('mock-express-response');
const productController = require('../../src/controllers/productController');

describe('productController', () => {
  describe('searchProdutos', () => {
    it('should return 400 if search parameter q is missing', () => {
      const req = new MockExpressRequest({
        user: { userId: 1 },
        query: {} // Missing 'q'
      });
      const res = new MockExpressResponse();

      productController.searchProdutos(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSON()).toEqual({ error: 'Parâmetro de busca não fornecido' });
    });
  });
});
