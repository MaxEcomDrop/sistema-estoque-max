require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const app = express();

// Middleware essencial
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors());
app.use(express.static('public'));

// ============================================
// 🎯 ROTAS SIMPLES E FUNCIONAIS
// ============================================

// 1. Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', time: new Date().toISOString() });
});

// 2. Info da API
app.get('/', (req, res) => {
  res.json({
    name: 'Sistema de Estoque Max',
    version: '1.0.0',
    status: 'online',
  });
});

// 3. Login - Redireciona para Bling OAuth
app.get('/api/auth/url', (req, res) => {
  const clientId = process.env.BLING_CLIENT_ID;
  const redirectUri = process.env.BLING_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(400).json({
      error: 'Variáveis de ambiente não configuradas',
      required: ['BLING_CLIENT_ID', 'BLING_REDIRECT_URI'],
    });
  }

  const authUrl = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}`;

  res.json({ authUrl });
});

// 4. Callback (simples)
app.get('/api/auth/callback', (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).json({
      error: 'Erro ao autorizar',
      message: error,
    });
  }

  if (!code) {
    return res.status(400).json({
      error: 'Código não fornecido',
    });
  }

  // Salvar token de teste
  res.cookie('auth_token', code, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
  });

  res.redirect('/dashboard.html');
});

// 5. Status do usuário
app.get('/api/auth/user', (req, res) => {
  const token = req.cookies?.auth_token;

  if (!token) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  res.json({
    authenticated: true,
    token: token.substring(0, 10) + '...',
  });
});

// 6. Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ message: 'Desconectado' });
});

// 7. Webhook status
app.get('/api/webhook/bling', (req, res) => {
  res.json({
    status: 'ready',
    endpoint: '/api/webhook/bling',
    method: 'POST',
  });
});

// 8. Receber webhook
app.post('/api/webhook/bling', (req, res) => {
  console.log('[WEBHOOK]', req.body);
  res.json({ received: true });
});

// 9. Produtos (simulado)
app.get('/api/produtos', (req, res) => {
  // Simular produtos
  const produtos = [
    {
      id: 1,
      nome: 'Mini Seladora',
      codigo: 'MINI-SELADORA-001',
      preco: 89.90,
      estoque: 150,
    },
    {
      id: 2,
      nome: 'Aroma Sachê',
      codigo: 'AROMA-SACHÊ',
      preco: 12.50,
      estoque: 320,
    },
    {
      id: 3,
      nome: 'Vela Aromática',
      codigo: 'VELA-AROM-001',
      preco: 35.00,
      estoque: 89,
    },
  ];

  res.json({
    total: produtos.length,
    products: produtos,
  });
});

// 10. Buscar produto
app.get('/api/produtos/:id', (req, res) => {
  res.json({
    id: req.params.id,
    nome: 'Produto',
    preco: 99.90,
    estoque: 100,
  });
});

// 11. Atualizar produto
app.patch('/api/produtos/:id', (req, res) => {
  const { estoque, preco } = req.body;

  res.json({
    message: 'Produto atualizado',
    id: req.params.id,
    estoque,
    preco,
  });
});

// 12. Buscar produtos
app.get('/api/produtos/search', (req, res) => {
  const { q } = req.query;

  res.json({
    query: q,
    results: [],
  });
});

// ============================================
// 🛡️ TRATAMENTO DE ERROS
// ============================================

app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// ============================================
// 🚀 INICIALIZAR (APENAS EM DEV)
// ============================================

if (process.env.NODE_ENV !== 'production' && require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n✅ Sistema online em http://localhost:${PORT}\n`);
  });
}

module.exports = app;
