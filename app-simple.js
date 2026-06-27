require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.static('public'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// API root
app.get('/', (req, res) => {
  res.json({
    message: 'Sistema de Estoque Max - API',
    version: '1.0.0',
    status: 'online',
    environment: process.env.NODE_ENV || 'development',
  });
});

// Teste de autenticação
app.get('/api/test', (req, res) => {
  res.json({ message: 'API funcionando!' });
});

// Webhook status
app.get('/api/webhook/bling', (req, res) => {
  res.json({
    message: 'Webhook do Bling está funcionando',
    endpoint: '/api/webhook/bling',
    status: 'ready',
  });
});

// Simular webhook
app.post('/api/webhook/bling', (req, res) => {
  console.log('[WEBHOOK] Recebido:', req.body);
  res.json({
    message: 'Webhook recebido com sucesso',
    data: req.body,
  });
});

// Tenta importar as rotas, mas se falhar, não quebra tudo
try {
  const authRoutes = require('./src/routes/authRoutes');
  const productRoutes = require('./src/routes/productRoutes');
  const webhookRoutes = require('./src/routes/webhookRoutes');

  app.use('/api', authRoutes);
  app.use('/api', productRoutes);
  app.use('/api', webhookRoutes);

  console.log('[ROUTES] Rotas carregadas com sucesso');
} catch (error) {
  console.error('[ROUTES] Erro ao carregar rotas:', error.message);
  console.log('[ROUTES] Usando modo fallback básico');
}

// Middleware de erro
app.use((err, req, res, next) => {
  console.error('[ERROR]', {
    message: err.message,
    path: req.path,
    method: req.method,
    stack: err.stack.split('\n').slice(0, 3).join('\n'),
  });

  res.status(err.status || 500).json({
    error: 'Erro interno do servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Tente novamente mais tarde',
    path: req.path,
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({
    error: 'Rota não encontrada',
    path: req.path,
    available: ['/', '/health', '/api/webhook/bling'],
  });
});

// Iniciar servidor (apenas em desenvolvimento)
if (process.env.NODE_ENV !== 'production' && require.main === module) {
  app.listen(PORT, () => {
    console.log(`[SERVER] Iniciado na porta ${PORT}`);
    console.log(`[ENV] ${process.env.NODE_ENV}`);
    console.log(`[URL] http://localhost:${PORT}`);
  });
}

// Para Vercel
module.exports = app;
