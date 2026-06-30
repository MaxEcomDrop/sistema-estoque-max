const axios = require('axios');
const blingService = require('./blingService');

jest.mock('axios');

describe('blingService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      BLING_CLIENT_ID: 'test_client_id',
      BLING_CLIENT_SECRET: 'test_client_secret',
      BLING_REDIRECT_URI: 'test_redirect_uri',
    };
    jest.clearAllMocks();

    // Silence console.error during tests
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    console.error.mockRestore();
  });

  describe('getAuthorizationUrl', () => {
    it('should generate correct authorization URL with env variables', () => {
      const url = blingService.getAuthorizationUrl();
      const expectedUrl = 'https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=test_client_id&redirect_uri=test_redirect_uri';
      expect(url).toBe(expectedUrl);
    });
  });

  describe('exchangeCodeForToken', () => {
    const mockCode = 'test_auth_code';
    const mockTokenResponse = {
      access_token: 'test_access_token',
      expires_in: 10800,
      token_type: 'Bearer',
      scope: 'read write',
      refresh_token: 'test_refresh_token',
    };

    it('should successfully exchange code for token', async () => {
      axios.post.mockResolvedValueOnce({ data: mockTokenResponse });

      const result = await blingService.exchangeCodeForToken(mockCode);

      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith('https://www.bling.com.br/Api/v3/oauth/token', {
        grant_type: 'authorization_code',
        code: mockCode,
        client_id: 'test_client_id',
        client_secret: 'test_client_secret',
        redirect_uri: 'test_redirect_uri',
      });
      expect(result).toEqual(mockTokenResponse);
    });

    it('should handle and throw error when API call fails', async () => {
      const errorResponse = {
        response: {
          data: { error: 'invalid_grant', error_description: 'The provided authorization grant is invalid.' },
        },
      };
      axios.post.mockRejectedValueOnce(errorResponse);

      await expect(blingService.exchangeCodeForToken(mockCode)).rejects.toEqual(errorResponse);

      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(
        'Erro ao trocar código por token:',
        errorResponse.response.data
      );
    });

    it('should handle and throw generic error when API call fails without response data', async () => {
      const genericError = new Error('Network Error');
      axios.post.mockRejectedValueOnce(genericError);

      await expect(blingService.exchangeCodeForToken(mockCode)).rejects.toEqual(genericError);

      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(
        'Erro ao trocar código por token:',
        'Network Error'
      );
    });
  });
});
