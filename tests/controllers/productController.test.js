jest.mock('../../config/database', () => {
  return {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    serialize: jest.fn(),
  };
});

const productController = require('../../src/controllers/productController');

describe('Product Controller', () => {
  describe('searchProdutos', () => {
    let mockReq;
    let mockRes;

    beforeEach(() => {
      mockReq = {
        user: { userId: 1 },
        query: {}
      };

      mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
    });

    it('should return 400 if q parameter is missing', () => {
      productController.searchProdutos(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Parâmetro de busca não fornecido' });
    });
  });
});
