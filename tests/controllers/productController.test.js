jest.mock('../../config/database', () => ({
  get: jest.fn(),
  all: jest.fn(),
  run: jest.fn(),
  serialize: jest.fn(cb => cb())
}));
jest.mock('../../src/services/blingService');
jest.mock('../../src/services/authService', () => ({
  isTokenExpired: jest.fn(),
  refreshUserToken: jest.fn()
}));

const MockRequest = require('mock-express-request');
const MockResponse = require('mock-express-response');
const productController = require('../../src/controllers/productController');

describe('productController', () => {
  describe('searchProdutos', () => {
    it('should return 400 if q parameter is not provided', () => {
      const req = new MockRequest({
        user: { userId: 1 },
        query: {}
      });
      const res = new MockResponse();

      const statusSpy = jest.spyOn(res, 'status');
      const jsonSpy = jest.spyOn(res, 'json');

      productController.searchProdutos(req, res);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(jsonSpy).toHaveBeenCalledWith({ error: 'Parâmetro de busca não fornecido' });
    });
  });
});
