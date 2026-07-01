const { searchProdutos } = require('../../src/controllers/productController');
const MockExpressRequest = require('mock-express-request');
const MockExpressResponse = require('mock-express-response');

jest.mock('../../config/database', () => ({
  get: jest.fn(),
  all: jest.fn(),
  run: jest.fn(),
  serialize: jest.fn(cb => cb())
}));

jest.mock('../../src/services/blingService', () => ({
  getProdutos: jest.fn()
}));

jest.mock('../../src/services/authService', () => ({
  isTokenExpired: jest.fn(),
  refreshUserToken: jest.fn()
}));

const db = require('../../config/database');

describe('productController', () => {
  describe('searchProdutos', () => {
    it('should return 400 if q parameter is not provided', () => {
      const req = new MockExpressRequest({
        user: { userId: 1 },
        query: {} // no 'q' parameter
      });
      const res = new MockExpressResponse();

      searchProdutos(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSON()).toEqual({ error: 'Parâmetro de busca não fornecido' });
    });

    it('should query database correctly when q is provided', () => {
      const req = new MockExpressRequest({
        user: { userId: 1 },
        query: { q: 'test' }
      });
      const res = new MockExpressResponse();

      const mockProducts = [
        { id: 1, nome: 'Test Product' }
      ];

      db.all.mockImplementation((query, params, cb) => {
        cb(null, mockProducts);
      });

      searchProdutos(req, res);

      expect(db.all).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM products'),
        [1, '%test%', '%test%'],
        expect.any(Function)
      );

      expect(res.statusCode).toBe(200);
      expect(res._getJSON()).toEqual({
        total: 1,
        products: mockProducts
      });
    });
  });
});
