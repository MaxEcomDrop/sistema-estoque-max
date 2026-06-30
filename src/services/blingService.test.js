const axios = require('axios');
const blingService = require('./blingService');

// Mock axios and axios.create
jest.mock('axios', () => {
  const mockAxiosInstance = {
    get: jest.fn(),
    post: jest.fn(),
  };
  return {
    create: jest.fn(() => mockAxiosInstance),
    post: jest.fn(),
    get: jest.fn(),
  };
});

describe('Bling Service', () => {
  let mockAxiosInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosInstance = axios.create(); // This gets our mock instance

    // Set environment variables for testing
    process.env.BLING_CLIENT_ID = 'test-client-id';
    process.env.BLING_CLIENT_SECRET = 'test-client-secret';
    process.env.BLING_REDIRECT_URI = 'http://localhost/callback';
  });

  afterEach(() => {
    delete process.env.BLING_CLIENT_ID;
    delete process.env.BLING_CLIENT_SECRET;
    delete process.env.BLING_REDIRECT_URI;
  });

  describe('getAuthorizationUrl', () => {
    it('should generate correct authorization URL', () => {
      const url = blingService.getAuthorizationUrl();
      expect(url).toContain('response_type=code');
      expect(url).toContain('client_id=test-client-id');
      expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%2Fcallback');
    });
  });

  describe('getProdutos', () => {
    const accessToken = 'valid-access-token';

    it('should return a list of products successfully', async () => {
      const mockProducts = [{ id: 1, nome: 'Produto A' }, { id: 2, nome: 'Produto B' }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { data: mockProducts } });

      const products = await blingService.getProdutos(accessToken);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/produtos', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(products).toEqual(mockProducts);
    });

    it('should return an empty array if data is missing', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} });

      const products = await blingService.getProdutos(accessToken);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/produtos', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(products).toEqual([]);
    });

    it('should handle API errors and throw', async () => {
      const mockError = new Error('API Error');
      mockError.response = { data: { error: 'Invalid Token' } };
      mockAxiosInstance.get.mockRejectedValueOnce(mockError);

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(blingService.getProdutos(accessToken)).rejects.toThrow('API Error');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Erro ao buscar produtos do Bling:', { error: 'Invalid Token' });
      consoleErrorSpy.mockRestore();
    });

    it('should handle general errors and throw', async () => {
      const mockError = new Error('Network Error');
      mockAxiosInstance.get.mockRejectedValueOnce(mockError);

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(blingService.getProdutos(accessToken)).rejects.toThrow('Network Error');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Erro ao buscar produtos do Bling:', 'Network Error');
      consoleErrorSpy.mockRestore();
    });
  });

  describe('exchangeCodeForToken', () => {
    const code = 'valid-code';

    it('should exchange code for token successfully', async () => {
      const mockResponse = { access_token: 'new-token', refresh_token: 'new-refresh' };
      axios.post.mockResolvedValueOnce({ data: mockResponse });

      const result = await blingService.exchangeCodeForToken(code);

      expect(axios.post).toHaveBeenCalledWith('https://www.bling.com.br/Api/v3/oauth/token', {
        grant_type: 'authorization_code',
        code,
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
        redirect_uri: 'http://localhost/callback',
      });
      expect(result).toEqual(mockResponse);
    });

    it('should handle errors during token exchange', async () => {
      const mockError = new Error('Exchange Error');
      axios.post.mockRejectedValueOnce(mockError);

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(blingService.exchangeCodeForToken(code)).rejects.toThrow('Exchange Error');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Erro ao trocar código por token:', 'Exchange Error');
      consoleErrorSpy.mockRestore();
    });
  });

  describe('refreshAccessToken', () => {
    const refreshToken = 'valid-refresh-token';

    it('should refresh token successfully', async () => {
      const mockResponse = { access_token: 'refreshed-token' };
      axios.post.mockResolvedValueOnce({ data: mockResponse });

      const result = await blingService.refreshAccessToken(refreshToken);

      expect(axios.post).toHaveBeenCalledWith('https://www.bling.com.br/Api/v3/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
      });
      expect(result).toEqual(mockResponse);
    });

    it('should handle errors during token refresh', async () => {
      const mockError = new Error('Refresh Error');
      axios.post.mockRejectedValueOnce(mockError);

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(blingService.refreshAccessToken(refreshToken)).rejects.toThrow('Refresh Error');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Erro ao renovar token:', 'Refresh Error');
      consoleErrorSpy.mockRestore();
    });
  });

  describe('getProdutoById', () => {
    const accessToken = 'valid-access-token';
    const produtoId = '123';

    it('should return a specific product successfully', async () => {
      const mockProduct = { id: 123, nome: 'Produto A' };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { data: mockProduct } });

      const product = await blingService.getProdutoById(accessToken, produtoId);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(`/produtos/${produtoId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(product).toEqual(mockProduct);
    });

    it('should handle errors during getProdutoById', async () => {
      const mockError = new Error('Not Found');
      mockAxiosInstance.get.mockRejectedValueOnce(mockError);

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(blingService.getProdutoById(accessToken, produtoId)).rejects.toThrow('Not Found');

      expect(consoleErrorSpy).toHaveBeenCalledWith(`Erro ao buscar produto ${produtoId} do Bling:`, 'Not Found');
      consoleErrorSpy.mockRestore();
    });
  });

  describe('getEstoque', () => {
    const accessToken = 'valid-access-token';

    it('should return inventory successfully', async () => {
      const mockEstoque = [{ id: 1, saldo: 10 }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { data: mockEstoque } });

      const estoque = await blingService.getEstoque(accessToken);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/estoques', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(estoque).toEqual(mockEstoque);
    });

    it('should return empty array if inventory data is missing', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} });

      const estoque = await blingService.getEstoque(accessToken);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/estoques', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(estoque).toEqual([]);
    });

    it('should handle errors during getEstoque', async () => {
      const mockError = new Error('Estoque Error');
      mockAxiosInstance.get.mockRejectedValueOnce(mockError);

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(blingService.getEstoque(accessToken)).rejects.toThrow('Estoque Error');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Erro ao buscar estoque do Bling:', 'Estoque Error');
      consoleErrorSpy.mockRestore();
    });
  });
});
