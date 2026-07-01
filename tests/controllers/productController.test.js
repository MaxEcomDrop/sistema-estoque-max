jest.mock('../../config/database', () => ({
  get: jest.fn(),
  all: jest.fn(),
  run: jest.fn(),
  serialize: jest.fn(cb => cb()),
}));

jest.mock('../../src/services/blingService', () => ({
  getProdutos: jest.fn(),
}));

jest.mock('../../src/services/authService', () => ({
  isTokenExpired: jest.fn(),
  refreshUserToken: jest.fn(),
}));

const MockRequest = require('mock-express-request');
const MockResponse = require('mock-express-response');
const productController = require('../../src/controllers/productController');

describe('productController', () => {
  describe('searchProdutos', () => {
    it('should return 400 when query parameter "q" is not provided', () => {
      const req = new MockRequest({
        user: { userId: 1 },
        query: {}
      });
      const res = new MockResponse();

      productController.searchProdutos(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSON()).toEqual({ error: 'Parâmetro de busca não fornecido' });
    });
  });
});
