require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const db = require('./config/database');
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

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV}`);
  console.log(`Webhook URL: ${process.env.NODE_ENV === 'production' ? `https://${process.env.VERCEL_URL || 'seu-dominio.vercel.app'}/api/webhook/bling` : 'http://localhost:3000/api/webhook/bling'}`);
});

module.exports = app;
