const { updateProduto } = require('../../src/controllers/productController');
const MockExpressRequest = require('mock-express-request');
const MockExpressResponse = require('mock-express-response');
const db = require('../../config/database');

// Mock do banco de dados
jest.mock('../../config/database', () => ({
  get: jest.fn(),
  run: jest.fn(),
}));

describe('updateProduto', () => {
  let req;
  let res;

  beforeEach(() => {
    // Reset dos mocks antes de cada teste
    jest.clearAllMocks();

    req = new MockExpressRequest({
      user: { userId: 1 },
      params: { id: 100 },
      body: {},
    });

    res = new MockExpressResponse();

    // Spies para verificar os métodos da resposta
    jest.spyOn(res, 'status');
    jest.spyOn(res, 'json');
  });

  it('should return 400 if payload is empty (estoque and preco are undefined)', () => {
    req.body = {};

    updateProduto(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Nenhum campo para atualizar' });
  });

  it('should return 404 if product is not found', () => {
    req.body = { estoque: 50 };

    // Simula a consulta não encontrando o produto (retorna undefined ou null no callback)
    db.get.mockImplementation((query, params, callback) => {
      callback(null, undefined);
    });

    updateProduto(req, res);

    expect(db.get).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM products WHERE id = ? AND user_id = ?'),
      [100, 1],
      expect.any(Function)
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Produto não encontrado' });
  });

  it('should successfully update product if payload is valid', () => {
    req.body = { estoque: 25, preco: 99.90 };

    const mockProduct = {
      id: 100,
      user_id: 1,
      estoque: 10,
      preco: 50.00,
    };

    // Simula produto encontrado
    db.get.mockImplementation((query, params, callback) => {
      callback(null, mockProduct);
    });

    // Simula update com sucesso
    db.run.mockImplementation(function(query, params, callback) {
      callback.call(this, null);
    });

    updateProduto(req, res);

    expect(db.get).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM products WHERE id = ? AND user_id = ?'),
      [100, 1],
      expect.any(Function)
    );

    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE products'),
      [25, 99.90, 100],
      expect.any(Function)
    );

    expect(res.json).toHaveBeenCalledWith({
      message: 'Produto atualizado com sucesso',
      product: {
        id: 100,
        ...mockProduct,
        estoque: 25,
        preco: 99.90,
      },
    });
  });

  it('should return 500 if there is an error fetching the product', () => {
    req.body = { preco: 150 };

    db.get.mockImplementation((query, params, callback) => {
      callback(new Error('DB Error'), null);
    });

    updateProduto(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Erro ao buscar produto' });
  });

  it('should return 500 if there is an error updating the product', () => {
    req.body = { preco: 150 };

    const mockProduct = { id: 100, user_id: 1, preco: 100 };

    db.get.mockImplementation((query, params, callback) => {
      callback(null, mockProduct);
    });

    db.run.mockImplementation(function(query, params, callback) {
      callback.call(this, new Error('Update Error'));
    });

    updateProduto(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Erro ao atualizar produto' });
  });
});
