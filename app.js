require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

// Inicializar banco de dados
const dbConfig = require('./config/database-vercel');
const db = dbConfig.init();

const authRoutes = require('./src/routes/authRoutes');
const productRoutes = require('./src/routes/productRoutes');
const webhookRoutes = require('./src/routes/webhookRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.json({
    message: 'Sistema de Estoque Max API',
    version: '1.0.0',
    endpoints: {
      auth: {
        getAuthUrl: 'GET /api/auth/url',
        callback: 'GET /api/auth/callback?code=xxx',
        logout: 'POST /api/auth/logout',
        currentUser: 'GET /api/auth/user',
      },
      produtos: {
        sync: 'POST /api/produtos/sync',
        list: 'GET /api/produtos',
        search: 'GET /api/produtos/search?q=termo',
        getById: 'GET /api/produtos/:id',
        update: 'PATCH /api/produtos/:id',
      },
      webhooks: {
        blingStatus: 'GET /api/webhook/bling',
        blingReceive: 'POST /api/webhook/bling',
      },
    },
  });
});

app.use('/api', authRoutes);
app.use('/api', productRoutes);
app.use('/api', webhookRoutes);

// Middleware de erro
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);

  if (err.message && err.message.includes('ENOENT')) {
    return res.status(500).json({
      error: 'Erro de banco de dados',
      message: 'Sistema inicializando, tente novamente em alguns segundos',
    });
  }

  res.status(err.status || 500).json({
    error: err.message || 'Erro interno do servidor',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Ambiente: ${process.env.NODE_ENV}`);
    console.log(`Webhook URL: http://localhost:3000/api/webhook/bling`);
  });
}

module.exports = app;
