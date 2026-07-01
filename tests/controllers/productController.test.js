const { getProdutoById } = require('../../src/controllers/productController');
const db = require('../../config/database');

// Mock the database
jest.mock('../../config/database', () => ({
  get: jest.fn(),
  all: jest.fn(),
  run: jest.fn(),
  serialize: jest.fn((callback) => callback()),
}));

// Mock the services since they are imported in productController.js
jest.mock('../../src/services/blingService', () => ({
  getProdutos: jest.fn(),
}));

jest.mock('../../src/services/authService', () => ({
  isTokenExpired: jest.fn(),
  refreshUserToken: jest.fn(),
}));

describe('Product Controller', () => {
  let req;
  let res;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup request and response objects
    req = {
      user: {
        userId: 1,
      },
      params: {
        id: '123',
      },
      query: {},
      body: {},
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  describe('getProdutoById', () => {
    it('should return 404 if product is not found', () => {
      // Mock db.get to simulate no product found (returns undefined)
      db.get.mockImplementation((query, params, callback) => {
        callback(null, undefined);
      });

      getProdutoById(req, res);

      // Verify db.get was called correctly
      expect(db.get).toHaveBeenCalledWith(
        'SELECT * FROM products WHERE id = ? AND user_id = ?',
        [req.params.id, req.user.userId],
        expect.any(Function)
      );

      // Verify the response
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Produto não encontrado' });
    });
  });
});
