const axios = require('axios');

// Mock axios globally
jest.mock('axios');

const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
};

axios.create.mockReturnValue(mockAxiosInstance);

// After setting up the mock, require the service
const tiktokService = require('../src/services/tiktokService');

describe('tiktokService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getProducts', () => {
    it('should handle and rethrow errors when tiktokApi.get fails', async () => {
      const errorMessage = 'Network Error';
      const mockError = new Error(errorMessage);
      mockError.response = { data: { message: 'API Error details' } };

      // Mock the rejected promise
      mockAxiosInstance.get.mockRejectedValue(mockError);

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const accessToken = 'test_access_token';

      await expect(tiktokService.getProducts(accessToken)).rejects.toThrow(mockError);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/products', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { page: 1, page_size: 50 },
      });

      expect(consoleSpy).toHaveBeenCalledWith('Erro ao buscar produtos (TikTok):', mockError.response.data);

      consoleSpy.mockRestore();
    });

    it('should correctly return products data when tiktokApi.get succeeds', async () => {
      const mockData = [{ id: '123', name: 'Product 1' }];
      mockAxiosInstance.get.mockResolvedValue({ data: mockData });

      const accessToken = 'test_access_token';

      const result = await tiktokService.getProducts(accessToken);

      expect(result).toEqual(mockData);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/products', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { page: 1, page_size: 50 },
      });
    });
  });
});
