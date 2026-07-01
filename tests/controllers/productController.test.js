// Mocking module dependencies before importing them
jest.mock('../../config/database', () => ({
  get: jest.fn(),
  all: jest.fn(),
  run: jest.fn(),
  serialize: jest.fn((cb) => cb()),
}));

jest.mock('../../src/services/blingService', () => ({
  getProdutos: jest.fn(),
}));

jest.mock('../../src/services/authService', () => ({
  isTokenExpired: jest.fn(),
  refreshUserToken: jest.fn(),
}));

const MockExpressRequest = require('mock-express-request');
const MockExpressResponse = require('mock-express-response');
const productController = require('../../src/controllers/productController');
const db = require('../../config/database');

describe('productController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('searchProdutos', () => {
    it('should return 400 if search parameter "q" is not provided', () => {
      const req = new MockExpressRequest({
        user: { userId: 1 },
        query: {}, // Missing 'q'
      });
      const res = new MockExpressResponse();

      productController.searchProdutos(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSON()).toEqual({ error: 'Parâmetro de busca não fornecido' });
    });

    it('should search products if "q" is provided', () => {
      const req = new MockExpressRequest({
        user: { userId: 1 },
        query: { q: 'teste' },
      });
      const res = new MockExpressResponse();

      const mockProducts = [
        { id: 1, nome: 'Produto Teste', codigo: 'TEST-1' }
      ];

      // Setup db.all mock callback
      db.all.mockImplementation((query, params, callback) => {
        callback(null, mockProducts);
      });

      productController.searchProdutos(req, res);

      expect(db.all).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM products'),
        [1, '%teste%', '%teste%'],
        expect.any(Function)
      );

      expect(res.statusCode).toBe(200);
      expect(res._getJSON()).toEqual({
        total: 1,
        products: mockProducts,
      });
    });

    it('should handle database errors', () => {
      const req = new MockExpressRequest({
        user: { userId: 1 },
        query: { q: 'teste' },
      });
      const res = new MockExpressResponse();

      db.all.mockImplementation((query, params, callback) => {
        callback(new Error('DB Error'), null);
      });

      productController.searchProdutos(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSON()).toEqual({ error: 'Erro ao buscar produtos' });
    });
  });
});
