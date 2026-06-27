const axios = require('axios');

const BLING_API_URL = 'https://www.bling.com.br/Api/v3';
const BLING_OAUTH_URL = 'https://www.bling.com.br/Api/v3/oauth';

const blingApi = axios.create({
  baseURL: BLING_API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

exports.getAuthorizationUrl = () => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.BLING_CLIENT_ID,
    redirect_uri: process.env.BLING_REDIRECT_URI,
  });

  return `${BLING_OAUTH_URL}/authorize?${params.toString()}`;
};

exports.exchangeCodeForToken = async (code) => {
  try {
    const response = await axios.post(`${BLING_OAUTH_URL}/token`, {
      grant_type: 'authorization_code',
      code,
      client_id: process.env.BLING_CLIENT_ID,
      client_secret: process.env.BLING_CLIENT_SECRET,
      redirect_uri: process.env.BLING_REDIRECT_URI,
    });

    return response.data;
  } catch (error) {
    console.error('Erro ao trocar código por token:', error.response?.data || error.message);
    throw error;
  }
};

exports.refreshAccessToken = async (refreshToken) => {
  try {
    const response = await axios.post(`${BLING_OAUTH_URL}/token`, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.BLING_CLIENT_ID,
      client_secret: process.env.BLING_CLIENT_SECRET,
    });

    return response.data;
  } catch (error) {
    console.error('Erro ao renovar token:', error.response?.data || error.message);
    throw error;
  }
};

exports.getProdutos = async (accessToken) => {
  try {
    const response = await blingApi.get('/produtos', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return response.data.data || [];
  } catch (error) {
    console.error('Erro ao buscar produtos do Bling:', error.response?.data || error.message);
    throw error;
  }
};

exports.getProdutoById = async (accessToken, id) => {
  try {
    const response = await blingApi.get(`/produtos/${id}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return response.data.data;
  } catch (error) {
    console.error(`Erro ao buscar produto ${id} do Bling:`, error.response?.data || error.message);
    throw error;
  }
};

exports.getEstoque = async (accessToken) => {
  try {
    const response = await blingApi.get('/estoques', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return response.data.data || [];
  } catch (error) {
    console.error('Erro ao buscar estoque do Bling:', error.response?.data || error.message);
    throw error;
  }
};
