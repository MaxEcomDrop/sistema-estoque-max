const mockRequest = require('mock-express-request');
const mockResponse = require('mock-express-response');

// Mock dependencies
jest.mock('../../config/database', () => ({
  get: jest.fn(),
  run: jest.fn(),
  all: jest.fn(),
  serialize: jest.fn((cb) => cb()),
}));

jest.mock('../../src/services/blingService', () => ({
  getProdutos: jest.fn(),
}));

jest.mock('../../src/services/authService', () => ({
  isTokenExpired: jest.fn(),
  refreshUserToken: jest.fn(),
}));

const db = require('../../config/database');
const productController = require('../../src/controllers/productController');

describe('Product Controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('updateProduto', () => {
    it('should return 400 if payload is empty (no estoque, no preco)', () => {
      const req = new mockRequest({
        user: { userId: 1 },
        params: { id: '123' },
        body: {}, // empty payload
      });

      const res = new mockResponse();
      // spy on res.status and res.json
      res.status = jest.fn().mockReturnValue(res);
      res.json = jest.fn().mockReturnValue(res);

      productController.updateProduto(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Nenhum campo para atualizar' });
    });
  });
});
