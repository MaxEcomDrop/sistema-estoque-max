const axios = require('axios');

// Mock global do axios ANTES de requerer o serviço
jest.mock('axios');

const mockTiktokApi = {
  get: jest.fn(),
  post: jest.fn()
};

// Configuramos o axios.create para retornar nosso objeto mockado
axios.create.mockReturnValue(mockTiktokApi);

// Agora podemos requerer o serviço
const tiktokService = require('../../src/services/tiktokService');

describe('tiktokService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getProducts', () => {
    const mockAccessToken = 'mock-access-token';
    const mockPage = 1;
    const mockPageSize = 50;

    it('should return products successfully', async () => {
      const mockResponse = { data: { products: [{ id: 1, name: 'Product 1' }] } };
      mockTiktokApi.get.mockResolvedValueOnce(mockResponse);

      const result = await tiktokService.getProducts(mockAccessToken, mockPage, mockPageSize);

      expect(mockTiktokApi.get).toHaveBeenCalledWith('/products', {
        headers: { Authorization: `Bearer ${mockAccessToken}` },
        params: { page: mockPage, page_size: mockPageSize },
      });
      expect(result).toEqual(mockResponse.data);
    });

    it('should throw an error and log it when the API call fails', async () => {
      const mockError = new Error('Network Error');
      mockError.response = { data: 'API Error message' };

      mockTiktokApi.get.mockRejectedValueOnce(mockError);

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(tiktokService.getProducts(mockAccessToken, mockPage, mockPageSize)).rejects.toThrow('Network Error');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Erro ao buscar produtos (TikTok):', 'API Error message');

      consoleErrorSpy.mockRestore();
    });

    it('should throw an error and log error.message when error.response.data is unavailable', async () => {
      const mockError = new Error('Network Error without response data');

      mockTiktokApi.get.mockRejectedValueOnce(mockError);

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(tiktokService.getProducts(mockAccessToken, mockPage, mockPageSize)).rejects.toThrow('Network Error without response data');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Erro ao buscar produtos (TikTok):', 'Network Error without response data');

      consoleErrorSpy.mockRestore();
    });
  });
});
