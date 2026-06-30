const { verifyWebhookSignature } = require('../tiktokService');
const crypto = require('crypto');

describe('tiktokService', () => {
  describe('verifyWebhookSignature', () => {
    it('should return false if signatureHeader or secret is missing', () => {
      expect(verifyWebhookSignature('body', null, 'secret')).toBe(false);
      expect(verifyWebhookSignature('body', 'sig', null)).toBe(false);
    });

    it('should return true for valid hex signature', () => {
      const secret = 'my_secret';
      const body = JSON.stringify({ event: 'order_update', id: 123 });

      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(body, 'utf8');
      const validSignature = hmac.digest('hex');

      expect(verifyWebhookSignature(body, validSignature, secret)).toBe(true);
    });

    it('should return true for valid base64 signature', () => {
      const secret = 'my_secret';
      const body = JSON.stringify({ event: 'order_update', id: 123 });

      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(body, 'utf8');
      const validSignature = hmac.digest('base64');

      expect(verifyWebhookSignature(body, validSignature, secret)).toBe(true);
    });

    it('should return false for invalid signature', () => {
      const secret = 'my_secret';
      const body = JSON.stringify({ event: 'order_update', id: 123 });

      expect(verifyWebhookSignature(body, 'invalid_signature', secret)).toBe(false);
    });

    it('should handle crypto errors gracefully and return false', () => {
      // Passing a non-string/non-buffer secret will cause createHmac to throw
      const originalConsoleError = console.error;
      console.error = jest.fn(); // suppress console error output during this test

      expect(verifyWebhookSignature('body', 'sig', 123)).toBe(false);

      expect(console.error).toHaveBeenCalled();
      console.error = originalConsoleError;
    });
  });
});
