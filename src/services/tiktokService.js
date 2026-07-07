const axios = require('axios');
const crypto = require('crypto');

// Base URL: preferir configurar via env caso a região/use case mude
const TIKTOK_API_URL = process.env.TIKTOK_API_BASE || 'https://open-api.tiktokglobalshop.com';
const TIKTOK_OAUTH_TOKEN = process.env.TIKTOK_OAUTH_TOKEN_URL || `${TIKTOK_API_URL}/oauth2/access_token`;

const tiktokApi = axios.create({
  baseURL: TIKTOK_API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

exports.getAuthorizationUrl = (state = '') => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.TIKTOK_CLIENT_ID,
    redirect_uri: process.env.TIKTOK_REDIRECT_URI,
    state,
  });

  // Nota: o endpoint de autorização varia por região. Ajuste TIKTOK_OAUTH_AUTHORIZE via env se necessário.
  const authUrl = process.env.TIKTOK_OAUTH_AUTHORIZE || 'https://auth.tiktok.com/authorize';
  return `${authUrl}?${params.toString()}`;
};

exports.exchangeCodeForToken = async (code) => {
  try {
    const body = {
      grant_type: 'authorization_code',
      client_id: process.env.TIKTOK_CLIENT_ID,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      code,
      redirect_uri: process.env.TIKTOK_REDIRECT_URI,
    };

    const resp = await axios.post(TIKTOK_OAUTH_TOKEN, body, {
      headers: { 'Content-Type': 'application/json' },
    });

    return resp.data;
  } catch (error) {
    console.error('Erro ao trocar código por token (TikTok):', error.response?.data || error.message);
    throw error;
  }
};

exports.refreshAccessToken = async (refreshToken) => {
  try {
    const body = {
      grant_type: 'refresh_token',
      client_id: process.env.TIKTOK_CLIENT_ID,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      refresh_token: refreshToken,
    };

    const resp = await axios.post(process.env.TIKTOK_REFRESH_URL || TIKTOK_OAUTH_TOKEN, body, {
      headers: { 'Content-Type': 'application/json' },
    });

    return resp.data;
  } catch (error) {
    console.error('Erro ao renovar token (TikTok):', error.response?.data || error.message);
    throw error;
  }
};

exports.getProducts = async (accessToken, page = 1, pageSize = 50) => {
  try {
    const resp = await tiktokApi.get('/products', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { page, page_size: pageSize },
    });

    return resp.data || [];
  } catch (error) {
    console.error('Erro ao buscar produtos (TikTok):', error.response?.data || error.message);
    throw error;
  }
};

exports.getProductById = async (accessToken, productId) => {
  try {
    const resp = await tiktokApi.get(`/products/${productId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    return resp.data;
  } catch (error) {
    console.error(`Erro ao buscar produto ${productId} (TikTok):`, error.response?.data || error.message);
    throw error;
  }
};

// Atualiza estoque: endpoints variam por região/conta. Ajuste conforme docs do TikTok Shop.
exports.updateStock = async (accessToken, skuId, quantity) => {
  try {
    const payload = { sku_id: skuId, quantity: Number(quantity) };
    // endpoint genérico — ajuste para o endpoint correto do TikTok Shop (ex: /inventory/update)
    const resp = await tiktokApi.post('/inventory/update', payload, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    return resp.data;
  } catch (error) {
    console.error(`Erro ao atualizar estoque sku ${skuId} (TikTok):`, error.response?.data || error.message);
    throw error;
  }
};

exports.getOrder = async (accessToken, orderId) => {
  try {
    const resp = await tiktokApi.get(`/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    return resp.data;
  } catch (error) {
    console.error(`Erro ao buscar pedido ${orderId} (TikTok):`, error.response?.data || error.message);
    throw error;
  }
};

// Verifica assinatura de webhook (HMAC). O modo de cálculo pode variar; aqui usamos HMAC-SHA256
// comparando hex/base64 — ajuste conforme documentação oficial da API.
exports.verifyWebhookSignature = (rawBody, signatureHeader, secret) => {
  try {
    if (!signatureHeader || !secret) return false;

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody, 'utf8');
    const expected = hmac.digest('hex');

    // algumas implementações usam base64; também aceitamos comparação base64
    // Note: hmac.digest() consumes the stream. Cannot call it twice.
    // We convert the hex string to base64 instead.
    const expectedBase64 = Buffer.from(expected, 'hex').toString('base64');

    return signatureHeader === expected || signatureHeader === expectedBase64;
  } catch (err) {
    console.error('Erro ao verificar assinatura do webhook (TikTok):', err.message);
    return false;
  }
};
