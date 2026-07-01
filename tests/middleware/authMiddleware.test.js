const { authMiddleware } = require('../../src/middleware/authMiddleware');

describe('authMiddleware', () => {
  it('should return 401 when no token is provided', () => {
    const req = {
      cookies: {},
      headers: {}
    };

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };

    const next = jest.fn();

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token não fornecido' });
    expect(next).not.toHaveBeenCalled();
  });
});
