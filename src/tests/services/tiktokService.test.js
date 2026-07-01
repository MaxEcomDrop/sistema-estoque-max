const crypto = require('crypto');
const tiktokService = require('../../services/tiktokService');

describe('tiktokService.verifyWebhookSignature', () => {
  const secret = 'my_secret';
  const rawBody = 'my_body';
  let validHexSignature;

  beforeAll(() => {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody, 'utf8');
    validHexSignature = hmac.digest('hex');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return true for a valid hex signature', () => {
    const result = tiktokService.verifyWebhookSignature(rawBody, validHexSignature, secret);
    expect(result).toBe(true);
  });

  it('should return false if signatureHeader or secret is missing', () => {
    expect(tiktokService.verifyWebhookSignature(rawBody, '', secret)).toBe(false);
    expect(tiktokService.verifyWebhookSignature(rawBody, validHexSignature, '')).toBe(false);
  });

  it('should return false and catch error if invalid arguments are provided', () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // Passing an object as a secret will cause crypto.createHmac to throw an error
    const result = tiktokService.verifyWebhookSignature(rawBody, validHexSignature, { invalid: 'secret' });

    expect(result).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Erro ao verificar assinatura do webhook (TikTok):',
      expect.any(String)
    );
  });
});
