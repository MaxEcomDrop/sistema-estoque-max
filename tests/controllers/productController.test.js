const productController = require('../../src/controllers/productController');
const db = require('../../config/database');
const blingService = require('../../src/services/blingService');
const authService = require('../../src/services/authService');

// Mock dependencies
jest.mock('../../config/database', () => ({
  get: jest.fn(),
  serialize: jest.fn(),
  run: jest.fn(),
  all: jest.fn()
}));

jest.mock('../../src/services/blingService', () => ({
  getProdutos: jest.fn()
}));

jest.mock('../../src/services/authService', () => ({
  isTokenExpired: jest.fn(),
  refreshUserToken: jest.fn()
}));

describe('productController.syncProdutos', () => {
  let req;
  let res;

  beforeEach(() => {
    req = {
      user: { userId: 1 }
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    jest.clearAllMocks();
  });

  it('should handle errors when blingService.getProdutos throws an error', async () => {
    // Mock user db lookup
    db.get.mockImplementation((query, params, callback) => {
      callback(null, { id: 1, access_token: 'valid_token' });
    });

    // Mock token not expired
    authService.isTokenExpired.mockReturnValue(false);

    // Mock blingService to throw error
    blingService.getProdutos.mockRejectedValue(new Error('Bling API Error'));

    await productController.syncProdutos(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Erro ao buscar produtos do Bling' });
  });
});
