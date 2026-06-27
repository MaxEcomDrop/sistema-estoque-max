require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware básico
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.static('public'));

console.log('[INIT] Sistema de Estoque Max iniciando...');
console.log('[ENV] NODE_ENV:', process.env.NODE_ENV);
console.log('[PORT] PORT:', PORT);

// Health check (deve funcionar sempre)
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
  });
});

// API Info
app.get('/', (req, res) => {
  res.json({
    name: 'Sistema de Estoque Max',
    version: '1.0.0',
    status: 'online',
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
    docs: 'https://github.com/MaxEcomDrop/sistema-estoque-max',
  });
});

// Carregamento lazy das rotas (não quebra se houver erro)
let routesLoaded = false;

try {
  // Inicializar banco de dados
  console.log('[DB] Inicializando banco de dados...');
  const dbConfig = require('./config/database-vercel');
  const db = dbConfig.init();

  // Carregar rotas
  console.log('[ROUTES] Carregando rotas...');
  const authRoutes = require('./src/routes/authRoutes');
  const productRoutes = require('./src/routes/productRoutes');
  const webhookRoutes = require('./src/routes/webhookRoutes');

  app.use('/api', authRoutes);
  app.use('/api', productRoutes);
  app.use('/api', webhookRoutes);

  routesLoaded = true;
  console.log('[ROUTES] ✅ Todas as rotas carregadas');
} catch (error) {
  console.error('[INIT] ⚠️ Erro ao carregar rotas:', error.message);
  console.error('[INIT] Stack:', error.stack);

  // Mesmo se as rotas não carregarem, a API básica funciona
  app.use('/api', (req, res) => {
    res.status(503).json({
      error: 'Serviço indisponível',
      message: 'Sistema inicializando, tente novamente em alguns segundos',
      path: req.path,
    });
  });
}

// Middleware de erro (último)
app.use((err, req, res, next) => {
  console.error('[ERROR]', {
    message: err.message,
    path: req.path,
    method: req.method,
  });

  res.status(err.status || 500).json({
    error: 'Erro interno',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Tente novamente',
    timestamp: new Date().toISOString(),
  });
});

// 404 (deve ser o último)
app.use((req, res) => {
  res.status(404).json({
    error: 'Rota não encontrada',
    path: req.path,
  });
});

// Iniciar servidor em desenvolvimento
if (process.env.NODE_ENV !== 'production' && require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`\n✅ Servidor iniciado com sucesso`);
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`🔗 Health: http://localhost:${PORT}/health`);
    console.log(`🎯 Webhook: http://localhost:${PORT}/api/webhook/bling\n`);
  });

  server.on('error', (error) => {
    console.error('[SERVER] Erro ao iniciar:', error);
    process.exit(1);
  });
}

console.log('[INIT] ✅ Aplicação exportada para Vercel\n');

module.exports = app;
