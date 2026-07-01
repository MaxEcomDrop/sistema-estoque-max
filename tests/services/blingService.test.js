const axios = require('axios');
const blingService = require('../../src/services/blingService');

jest.mock('axios', () => {
  return {
    create: jest.fn(() => ({
      get: jest.fn(),
      post: jest.fn(),
    })),
    post: jest.fn(),
    get: jest.fn(),
  };
});

describe('Bling Service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      BLING_CLIENT_ID: 'mock_client_id',
      BLING_CLIENT_SECRET: 'mock_client_secret',
      BLING_REDIRECT_URI: 'mock_redirect_uri',
    };
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    console.error.mockRestore();
  });

  describe('exchangeCodeForToken', () => {
    it('should return token data on successful exchange', async () => {
      const mockCode = 'mock_code';
      const mockResponseData = { access_token: 'mock_access_token', refresh_token: 'mock_refresh_token' };

      axios.post.mockResolvedValueOnce({ data: mockResponseData });

      const result = await blingService.exchangeCodeForToken(mockCode);

      expect(axios.post).toHaveBeenCalledWith('https://www.bling.com.br/Api/v3/oauth/token', {
        grant_type: 'authorization_code',
        code: mockCode,
        client_id: 'mock_client_id',
        client_secret: 'mock_client_secret',
        redirect_uri: 'mock_redirect_uri',
      });
      expect(result).toEqual(mockResponseData);
    });

    it('should throw an error and log it if the API request fails', async () => {
      const mockCode = 'mock_code';
      const mockError = new Error('Network Error');
      mockError.response = { data: 'Invalid code' };

      axios.post.mockRejectedValueOnce(mockError);

      await expect(blingService.exchangeCodeForToken(mockCode)).rejects.toThrow('Network Error');

      expect(console.error).toHaveBeenCalledWith('Erro ao trocar código por token:', 'Invalid code');
    });

    it('should throw an error and log error.message if no response data is present', async () => {
      const mockCode = 'mock_code';
      const mockError = new Error('Network Error');

      axios.post.mockRejectedValueOnce(mockError);

      await expect(blingService.exchangeCodeForToken(mockCode)).rejects.toThrow('Network Error');

      expect(console.error).toHaveBeenCalledWith('Erro ao trocar código por token:', 'Network Error');
    });
  });
});
