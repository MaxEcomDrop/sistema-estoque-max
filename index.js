require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const axios = require('axios');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors());
app.use(express.static('public'));

// ============================================
// VERIFICAR VARIÁVEIS DE AMBIENTE
// ============================================

const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID;
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const BLING_REDIRECT_URI = process.env.BLING_REDIRECT_URI;

if (!BLING_CLIENT_ID || !BLING_CLIENT_SECRET || !BLING_REDIRECT_URI) {
  console.warn('\n⚠️  AVISO: Variáveis de ambiente não configuradas!');
  console.warn('Configure no Vercel Dashboard:');
  console.warn('  - BLING_CLIENT_ID');
  console.warn('  - BLING_CLIENT_SECRET');
  console.warn('  - BLING_REDIRECT_URI');
  console.warn('\n');
}

// ============================================
// ROTAS
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', env_configured: !!BLING_CLIENT_ID });
});

// Home
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Dashboard
app.get('/dashboard.html', (req, res) => {
  res.sendFile(__dirname + '/public/dashboard.html');
});

// ============================================
// OAUTH - LOGIN COM BLING
// ============================================

app.get('/api/auth/url', (req, res) => {
  if (!BLING_CLIENT_ID || !BLING_REDIRECT_URI) {
    return res.status(400).json({
      error: 'Variáveis de ambiente não configuradas',
      required: ['BLING_CLIENT_ID', 'BLING_REDIRECT_URI'],
      help: 'Configure no Vercel Dashboard → Settings → Environment Variables',
    });
  }

  const authUrl = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${BLING_CLIENT_ID}&redirect_uri=${BLING_REDIRECT_URI}`;
  res.json({ authUrl });
});

// Callback do Bling
app.get('/api/webhook/bling', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).redirect(`/?error=${error}`);
  }

  if (!code) {
    return res.status(400).redirect('/?error=no_code');
  }

  if (!BLING_CLIENT_SECRET) {
    return res.status(500).redirect('/?error=env_not_configured');
  }

  try {
    // Trocar código por token
    const tokenResponse = await axios.post(
      'https://www.bling.com.br/Api/v3/oauth/token',
      {
        grant_type: 'authorization_code',
        code,
        client_id: BLING_CLIENT_ID,
        client_secret: BLING_CLIENT_SECRET,
        redirect_uri: BLING_REDIRECT_URI,
      }
    );

    const { access_token } = tokenResponse.data;

    // Salvar token no cookie
    res.cookie('bling_token', access_token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 3600000, // 1 hora
    });

    res.redirect('/dashboard.html?success=true');
  } catch (error) {
    console.error('Erro ao trocar código por token:', error.message);
    res.redirect('/?error=token_exchange_failed');
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('bling_token');
  res.json({ message: 'Desconectado' });
});

// ============================================
// API - PRODUTOS DO BLING
// ============================================

app.get('/api/produtos', async (req, res) => {
  const token = req.cookies?.bling_token;

  if (!token) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  try {
    const response = await axios.get(
      'https://www.bling.com.br/Api/v3/produtos',
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const produtos = (Array.isArray(response.data?.data) ? response.data.data : []);

    res.json({
      total: produtos.length,
      products: produtos.map(p => ({
        id: p.id,
        nome: p.nome || 'N/A',
        codigo: p.codigo || 'N/A',
        preco: p.preco || 0,
        estoque: p.estoque || 0,
        situacao: p.situacao || 'A',
      })),
    });
  } catch (error) {
    if (error.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado' });
    }
    console.error('Erro ao buscar produtos:', error.message);
    res.status(500).json({ error: 'Erro ao buscar produtos do Bling', details: error.message });
  }
});

// Atualizar produto
app.patch('/api/produtos/:id', async (req, res) => {
  const token = req.cookies?.bling_token;
  const { id } = req.params;
  const { estoque, preco } = req.body;

  if (!token) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  try {
    const payload = {};
    if (estoque !== undefined) payload.estoque = estoque;
    if (preco !== undefined) payload.preco = preco;

    // Nota: A API do Bling pode não suportar PATCH direto
    // Esta é uma simulação. Ajuste conforme sua integração real.
    res.json({
      message: 'Produto será atualizado no Bling',
      id,
      changes: payload,
    });
  } catch (error) {
    console.error('Erro ao atualizar:', error.message);
    res.status(500).json({ error: 'Erro ao atualizar produto' });
  }
});

// ============================================
// WEBHOOKS (Placeholder)
// ============================================

app.get('/api/webhook/bling', (req, res) => {
  res.json({ status: 'ready', endpoint: '/api/webhook/bling' });
});

app.post('/api/webhook/bling', (req, res) => {
  console.log('[WEBHOOK] Recebido:', req.body);
  res.json({ received: true });
});

// ============================================
// TRATAMENTO DE ERROS
// ============================================

app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// ============================================
// INICIALIZAR
// ============================================

if (process.env.NODE_ENV !== 'production' && require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n✅ Servidor iniciado em http://localhost:${PORT}`);
    console.log(`   Dashboard: http://localhost:${PORT}/dashboard.html`);
    if (!BLING_CLIENT_ID) {
      console.warn('\n⚠️  Variáveis de ambiente não configuradas!');
    }
    console.log('\n');
  });
}

module.exports = app;
