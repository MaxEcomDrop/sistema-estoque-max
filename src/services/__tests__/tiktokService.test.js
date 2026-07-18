const crypto = require('crypto');
const tiktokService = require('../tiktokService');

describe('tiktokService.verifyWebhookSignature', () => {
  const secret = 'my_super_secret';
  const rawBody = JSON.stringify({ event: 'order_status_update', order_id: '12345' });

  it('should return true for a valid hex signature', () => {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody, 'utf8');
    const validHexSignature = hmac.digest('hex');

    const result = tiktokService.verifyWebhookSignature(rawBody, validHexSignature, secret);
    expect(result).toBe(true);
  });

  it('should return true for a valid base64 signature', () => {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody, 'utf8');
    const validBase64Signature = Buffer.from(hmac.digest()).toString('base64');

    const result = tiktokService.verifyWebhookSignature(rawBody, validBase64Signature, secret);
    expect(result).toBe(true);
  });

  it('should return false for an invalid signature', () => {
    const invalidSignature = 'invalid_signature_string';

    const result = tiktokService.verifyWebhookSignature(rawBody, invalidSignature, secret);
    expect(result).toBe(false);
  });

  it('should return false if signature header is missing', () => {
    const result = tiktokService.verifyWebhookSignature(rawBody, undefined, secret);
    expect(result).toBe(false);

    const resultNull = tiktokService.verifyWebhookSignature(rawBody, null, secret);
    expect(resultNull).toBe(false);

    const resultEmpty = tiktokService.verifyWebhookSignature(rawBody, '', secret);
    expect(resultEmpty).toBe(false);
  });

  it('should return false if secret is missing', () => {
    const hmac = crypto.createHmac('sha256', 'dummy_secret');
    hmac.update(rawBody, 'utf8');
    const signature = hmac.digest('hex');

    const result = tiktokService.verifyWebhookSignature(rawBody, signature, undefined);
    expect(result).toBe(false);

    const resultNull = tiktokService.verifyWebhookSignature(rawBody, signature, null);
    expect(resultNull).toBe(false);

    const resultEmpty = tiktokService.verifyWebhookSignature(rawBody, signature, '');
    expect(resultEmpty).toBe(false);
  });

  it('should calculate HMAC correctly even for empty body', () => {
    const emptyBody = '';
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(emptyBody, 'utf8');
    const validSignature = hmac.digest('hex');

    const result = tiktokService.verifyWebhookSignature(emptyBody, validSignature, secret);
    expect(result).toBe(true);
  });

  it('should return false if secret does not match', () => {
    const hmac = crypto.createHmac('sha256', 'different_secret');
    hmac.update(rawBody, 'utf8');
    const signature = hmac.digest('hex');

    const result = tiktokService.verifyWebhookSignature(rawBody, signature, secret);
    expect(result).toBe(false);
  });
});
