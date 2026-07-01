const crypto = require('crypto');

// Global mock for axios
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

const tiktokService = require('../src/services/tiktokService');

describe('tiktokService', () => {
  describe('verifyWebhookSignature', () => {
    it('should return true for valid hex signature', () => {
      const rawBody = '{"event": "test"}';
      const secret = 'my-secret';
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(rawBody, 'utf8');
      const signature = hmac.digest('hex');

      const result = tiktokService.verifyWebhookSignature(rawBody, signature, secret);
      expect(result).toBe(true);
    });

    it('should return true for valid base64 signature', () => {
      const rawBody = '{"event": "test"}';
      const secret = 'my-secret';
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(rawBody, 'utf8');
      const signature = hmac.digest('base64');

      const result = tiktokService.verifyWebhookSignature(rawBody, signature, secret);
      expect(result).toBe(true);
    });

    it('should return false for missing signature', () => {
      const result = tiktokService.verifyWebhookSignature('body', undefined, 'secret');
      expect(result).toBe(false);
    });

    it('should return false for missing secret', () => {
      const result = tiktokService.verifyWebhookSignature('body', 'signature', undefined);
      expect(result).toBe(false);
    });

    it('should return false for invalid signature', () => {
      const result = tiktokService.verifyWebhookSignature('body', 'invalid', 'secret');
      expect(result).toBe(false);
    });

    it('should catch error and return false when crypto.createHmac fails', () => {
      // Temporarily mock console.error to avoid noise in test output
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      // Passing an object as secret will throw in crypto.createHmac
      const result = tiktokService.verifyWebhookSignature('body', 'signature', { invalid: 'type' });

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        'Erro ao verificar assinatura do webhook (TikTok):',
        expect.any(String)
      );

      consoleSpy.mockRestore();
    });
  });
});
