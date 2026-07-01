require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ── Validação de Variáveis de Ambiente ───────────────────────────────
function validateEnvironment() {
  const required = [
    'BLING_CLIENT_ID',
    'BLING_CLIENT_SECRET',
    'BLING_REDIRECT_URI',
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
    'JWT_SECRET'
  ];
  
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.warn('⚠️  Variáveis de ambiente ausentes:', missing.join(', '));
    console.warn('   Configure-as em Vercel → Settings → Environment Variables → Redeploy.');
  }
}

// Firebase Admin SDK (lazy init para não quebrar se env var ausente)
let _fbAdmin = null;
function getAdmin() {
  if (_fbAdmin) return _fbAdmin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    }
    _fbAdmin = admin;
  } catch (e) { 
    console.error('⚠️  Firebase Admin init error:', e.message); 
  }
  return _fbAdmin;
}

const app = express();
// Confia no 1º proxy da cadeia (Vercel/Render) para req.ip refletir o IP real do cliente
app.set('trust proxy', 1);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors());

// ── Carregar Variáveis de Ambiente Seguramente ───────────────────────
// Validar variáveis de ambiente ANTES de carregar qualquer rota
validateEnvironment();

const BLING_CLIENT_ID     = process.env.BLING_CLIENT_ID;
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const BLING_REDIRECT_URI  = process.env.BLING_REDIRECT_URI;
const ADMIN_EMAIL         = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD      = process.env.ADMIN_PASSWORD;
const JWT_SECRET          = process.env.JWT_SECRET;
const NODE_ENV            = process.env.NODE_ENV || 'development';

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID     || '';
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || '';
const ML_REDIRECT_URI  = process.env.ML_REDIRECT_URI  || '';

// In-memory change log (resets on cold start)
// TODO: Persistir em banco de dados em produção
const changeLog = [];

// In-memory contas customizadas (despesas, receitas extras)
// TODO: Persistir em banco de dados ou Firestore em produção
const customContas = [];
let contaIdCounter = 1;

// In-memory calendário (eventos, feriados, datas importantes)
// TODO: Persistir em banco de dados ou Firestore em produção
const calendarEvents = [];
let eventIdCounter = 1;

// Cache do depósito padrão (evita chamada extra a cada edição de estoque)
let _depositoId = null;
async function getDepositoId(token) {
  if (_depositoId) return _depositoId;
  try {
    const { data } = await axios.get('https://www.bling.com.br/Api/v3/depositos', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const deps = Array.isArray(data?.data) ? data.data : [];
    _depositoId = (deps.find(d => d.padrao) || deps[0])?.id || 1;
  } catch { _depositoId = 1; }
  return _depositoId;
}

// ── Auth helpers ─────────────────────────────────────────────────────

function safeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}

// Rate limit simples em memória para /api/auth/login (proteção contra brute force)
const _loginAttempts = new Map(); // ip -> { count, firstAt }
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function loginRateLimit(req, res, next) {
  const ip = req.ip;
  if (!ip) return next(); // não conseguimos identificar o cliente — não bloqueia (evita lockout global)
  const now = Date.now();
  const entry = _loginAttempts.get(ip);
  if (entry && now - entry.firstAt < LOGIN_WINDOW_MS) {
    if (entry.count >= LOGIN_MAX_ATTEMPTS) {
      const waitMin = Math.ceil((LOGIN_WINDOW_MS - (now - entry.firstAt)) / 60000);
      return sendErrorResponse(res, 429, `Muitas tentativas de login. Tente novamente em ${waitMin} minuto(s).`);
    }
  } else {
    _loginAttempts.set(ip, { count: 0, firstAt: now });
  }
  next();
}

function registerLoginFailure(req) {
  const ip = req.ip;
  if (!ip) return;
  const entry = _loginAttempts.get(ip) || { count: 0, firstAt: Date.now() };
  entry.count += 1;
  _loginAttempts.set(ip, entry);
}

function clearLoginFailures(req) {
  const ip = req.ip;
  if (!ip) return;
  _loginAttempts.delete(ip);
}

// Input validation helpers
function isValidNumericId(id) {
  return /^\d+$/.test(String(id).trim());
}

function validateNumericId(id, fieldName = 'ID') {
  if (!isValidNumericId(id)) {
    const err = new Error(`${fieldName} inválido: esperado número`);
    err.statusCode = 400;
    throw err;
  }
  return Number(id);
}

function requireAuth(req, res, next) {
  try { jwt.verify(req.cookies?.system_token || '', JWT_SECRET); next(); }
  catch { res.clearCookie('system_token'); res.redirect('/login'); }
}

function requireAuthJson(req, res, next) {
  try { jwt.verify(req.cookies?.system_token || '', JWT_SECRET); next(); }
  catch { res.clearCookie('system_token'); res.status(401).json({ error: 'Não autenticado' }); }
}

function blingHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Axios config with timeout to prevent hanging requests
const AXIOS_TIMEOUT = 15000; // 15 segundos
axios.defaults.timeout = AXIOS_TIMEOUT;

// Handle common API errors
function getApiErrorMessage(err) {
  if (err.code === 'ECONNABORTED') return 'Requisição expirou - tente novamente';
  if (err.code === 'ENOTFOUND') return 'Sem conexão com a internet';
  if (err.response?.status === 401) return 'Token expirado';
  if (err.response?.status === 403) return 'Acesso negado';
  if (err.response?.status === 404) return 'Recurso não encontrado';
  if (err.response?.status === 429) return 'Muitas requisições - tente novamente em alguns segundos';
  if (err.response?.status === 500) return 'Erro no servidor - tente novamente';
  return err.response?.data?.error?.message || err.message || 'Erro desconhecido';
}

// ── Bling token: renovação automática via refresh_token ──────────
const BLING_COOKIE_OPTS = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' };

function setBlingCookies(res, data) {
  res.cookie('bling_token', data.access_token, { ...BLING_COOKIE_OPTS, maxAge: (data.expires_in || 3600) * 1000 });
  if (data.refresh_token) {
    res.cookie('bling_refresh', data.refresh_token, { ...BLING_COOKIE_OPTS, maxAge: 30 * 24 * 3600 * 1000 });
    // Persiste o refresh para os crons usarem (fire-and-forget)
    saveBlingRefresh(data.refresh_token);
  }
}

// Guarda o refresh_token do Bling no Firestore para os crons (server-side)
async function saveBlingRefresh(refreshToken) {
  const admin = getAdmin();
  if (!admin || !refreshToken) return;
  try {
    await admin.firestore().collection('bling_auth').doc('tokens').set({
      refreshToken, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.error('[saveBlingRefresh]', e.message); }
}

// Gera um access_token válido a partir do refresh salvo (usado pelos crons)
async function getCronBlingToken() {
  const admin = getAdmin();
  if (!admin) return null;
  try {
    const doc = await admin.firestore().collection('bling_auth').doc('tokens').get();
    const refresh = doc.exists ? doc.data().refreshToken : null;
    if (!refresh) return null;
    const data = await refreshBlingToken(refresh);
    if (data.refresh_token) await saveBlingRefresh(data.refresh_token);
    return data.access_token;
  } catch (e) { console.error('[getCronBlingToken]', e.message); return null; }
}

async function refreshBlingToken(refreshToken) {
  const creds = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const { data } = await axios.post('https://www.bling.com.br/Api/v3/oauth/token', body.toString(), {
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return data;
}

// Retorna um access_token válido. Se o atual expirou (cookie some junto),
// renova automaticamente usando o refresh_token (válido por 30 dias).
async function ensureBlingToken(req, res) {
  const token = req.cookies?.bling_token;
  if (token) return token;
  const refresh = req.cookies?.bling_refresh;
  if (!refresh) return null;
  try {
    const data = await refreshBlingToken(refresh);
    setBlingCookies(res, data);
    return data.access_token;
  } catch (e) {
    console.error('[Bling refresh]', e.response?.data || e.message);
    res.clearCookie('bling_refresh');
    return null;
  }
}

// ── Error Response Helper ────────────────────────────────────────────
function sendErrorResponse(res, statusCode, errorMessage, detail = null) {
  const response = { error: errorMessage };
  
  // Apenas incluir detalhes em desenvolvimento
  if (NODE_ENV === 'development' && detail) {
    response.detail = detail;
  }
  
  // Registrar erro completo em log interno
  if (detail) {
    console.error(`[${new Date().toISOString()}] Error:`, detail);
  }
  
  res.status(statusCode).json(response);
}

const _SIT_PT_MAP = {
  'pending':'Pendente','approved':'Aprovado','paid':'Pago','processing':'Em processamento',
  'in_process':'Em processamento','shipped':'Enviado','delivered':'Entregue','completed':'Concluído',
  'complete':'Concluído','cancelled':'Cancelado','canceled':'Cancelado','refunded':'Reembolsado',
  'failed':'Falhou','open':'Em aberto','closed':'Encerrado','waiting':'Aguardando',
  'waiting_payment':'Aguardando pagamento','ready_to_ship':'Pronto p/ envio',
  'return':'Devolvido','returned':'Devolvido','partially_refunded':'Parcialmente devolvido',
  'on_hold':'Em espera','suspended':'Suspenso','voided':'Cancelado','disputed':'Contestado',
};
const _TRANSP_TIPO = {
  'R':'A cargo do destinatário','E':'A cargo do remetente','T':'A cargo de terceiros',
  'D':'Sem frete','S':'Sem frete','own_account':'Conta própria','third_party':'Terceiros',
  'recipient':'Destinatário','sender':'Remetente','free':'Frete grátis',
};
function situacaoPT(s) {
  const raw = String(s || '—');
  return _SIT_PT_MAP[raw.toLowerCase().replace(/\s+/g,'_')] || raw;
}

// Resolve intervalo de datas a partir do período (today | 7d | 30d | custom)
function resolvePeriodo(period, startDate, endDate) {
  const hoje = new Date();
  const iso = d => d.toISOString().split('T')[0];
  let inicio, fim;
  if (period === 'today') {
    inicio = fim = iso(hoje);
  } else if (period === 'yesterday') {
    const d = new Date(hoje); d.setDate(d.getDate() - 1);
    inicio = fim = iso(d);
  } else if (period === '7d') {
    const d = new Date(hoje); d.setDate(d.getDate() - 6);
    inicio = iso(d); fim = iso(hoje);
  } else if (period === '90d') {
    const d = new Date(hoje); d.setDate(d.getDate() - 89);
    inicio = iso(d); fim = iso(hoje);
  } else if (period === 'year') {
    inicio = `${hoje.getFullYear()}-01-01`; fim = iso(hoje);
  } else if (period === 'custom' && startDate && endDate) {
    inicio = startDate; fim = endDate;
  } else {
    const d = new Date(hoje); d.setDate(d.getDate() - 29);
    inicio = iso(d); fim = iso(hoje);
    period = '30d';
  }
  return { inicio, fim, period: period || '30d' };
}

// ── Páginas ──────────────────────────────────────────────────────────

app.get('/login', (req, res) => res.sendFile(__dirname + '/public/login.html'));
app.get('/', requireAuth, (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/index.html', requireAuth, (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/dashboard.html', requireAuth, (req, res) => res.sendFile(__dirname + '/public/dashboard.html'));
app.get('/health', (req, res) => res.json({ status: 'OK', history: changeLog.length, environment: NODE_ENV }));

// Arquivos estáticos (fontes, imagens) — vem DEPOIS das rotas de página
// para que /index.html e /dashboard.html passem pela autenticação acima
app.use(express.static('public', { index: false }));

// ── Login ────────────────────────────────────────────────────────────

app.post('/api/auth/login', loginRateLimit, (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return sendErrorResponse(res, 400, 'Email e senha são obrigatórios');
  }

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !JWT_SECRET) {
    return sendErrorResponse(res, 500,
      'Configuração incompleta: variáveis de ambiente ADMIN_EMAIL, ADMIN_PASSWORD ou JWT_SECRET não definidas. ' +
      'Acesse Vercel → Settings → Environment Variables e configure-as, depois faça um novo deploy.');
  }

  if (!safeEqual(email, ADMIN_EMAIL) || !safeEqual(password, ADMIN_PASSWORD)) {
    registerLoginFailure(req);
    return sendErrorResponse(res, 401, 'Email ou senha incorretos');
  }

  try {
    clearLoginFailures(req);
    const token = jwt.sign({ email: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('system_token', token, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 3600 * 1000,
    });
    res.json({ success: true });
  } catch (e) {
    sendErrorResponse(res, 500, 'Erro ao gerar token. Verifique JWT_SECRET nas variáveis de ambiente.', e.message);
  }
});

// Reconfirma a senha (para liberar áreas/ações sensíveis, estilo Shopee)
app.post('/api/auth/verify', requireAuthJson, (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'Senha não configurada no servidor.' });
  if (safeEqual(password, ADMIN_PASSWORD)) return res.json({ ok: true });
  return res.status(401).json({ error: 'Senha incorreta.' });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('system_token');
  res.clearCookie('bling_token');
  res.clearCookie('bling_refresh');
  res.json({ ok: true });
});

// ── OAuth Bling ──────────────────────────────────────────────────────

app.get('/api/auth/url', requireAuthJson, (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: BLING_CLIENT_ID,
    redirect_uri: BLING_REDIRECT_URI,
    state: 'estoque_max',
  });
  res.json({ authUrl: `https://www.bling.com.br/Api/v3/oauth/authorize?${params}` });
});

app.get(['/api/auth/callback', '/api/webhook/bling'], async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
  if (!code) return res.redirect('/?error=no_code');

  try {
    const creds = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
    const body  = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: BLING_REDIRECT_URI });

    const { data } = await axios.post('https://www.bling.com.br/Api/v3/oauth/token', body.toString(), {
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    setBlingCookies(res, data);

    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('[OAuth]', err.response?.data || err.message);
    res.redirect('/?error=token_exchange_failed');
  }
});

// Firebase Authentication endpoint
app.post('/api/auth/firebase', async (req, res) => {
  const { idToken, email } = req.body || {};

  if (!idToken || !email) {
    return sendErrorResponse(res, 400, 'ID token e email são obrigatórios');
  }

  if (!ADMIN_EMAIL || !JWT_SECRET) {
    return sendErrorResponse(res, 500, 'Configuração incompleta: ADMIN_EMAIL ou JWT_SECRET não definidos');
  }

  try {
    // Try to verify Firebase token with Admin SDK
    const admin = getAdmin();
    let firebaseUser = null;

    if (admin) {
      try {
        firebaseUser = await admin.auth().verifyIdToken(idToken);
      } catch (err) {
        console.error('[Firebase Auth]', err.message);
        return sendErrorResponse(res, 401, 'Token do Firebase inválido ou expirado');
      }
    }

    // Check if email matches authorized user
    if (!safeEqual(email, ADMIN_EMAIL)) {
      return sendErrorResponse(res, 403, 'Email não autorizado. Entre em contato com o administrador.');
    }

    // Create JWT token for app
    clearLoginFailures(req);
    const token = jwt.sign({ email: ADMIN_EMAIL, provider: 'firebase' }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('system_token', token, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 3600 * 1000,
    });
    res.json({ success: true });
  } catch (err) {
    sendErrorResponse(res, 500, 'Erro ao autenticar', err.message);
  }
});

// ── OAuth Mercado Livre ───────────────────────────────────────────────

// In-memory cache for ML access_token (TTL ~6h) to avoid Firestore round-trips
let _mlTokenCache = { token: null, expiresAt: 0, sellerId: null };

async function saveMLTokens(accessToken, refreshToken, sellerId, expiresIn) {
  _mlTokenCache = { token: accessToken, expiresAt: Date.now() + (expiresIn - 60) * 1000, sellerId };
  const admin = getAdmin();
  if (!admin) return;
  try {
    await admin.firestore().collection('ml_auth').doc('tokens').set({
      accessToken, refreshToken, sellerId: String(sellerId || ''),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.error('[saveMLTokens]', e.message); }
}

async function refreshMLToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token', client_id: ML_CLIENT_ID,
    client_secret: ML_CLIENT_SECRET, refresh_token: refreshToken,
  });
  const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  });
  return data;
}

async function ensureMLToken() {
  if (_mlTokenCache.token && Date.now() < _mlTokenCache.expiresAt) return _mlTokenCache;
  const admin = getAdmin();
  if (!admin) return null;
  try {
    const doc = await admin.firestore().collection('ml_auth').doc('tokens').get();
    if (!doc.exists) return null;
    const { accessToken, refreshToken, sellerId } = doc.data();
    if (!refreshToken) return null;
    const data = await refreshMLToken(refreshToken);
    await saveMLTokens(data.access_token, data.refresh_token || refreshToken, data.user_id || sellerId, data.expires_in || 21600);
    return _mlTokenCache;
  } catch (e) { console.error('[ensureMLToken]', e.message); return null; }
}

function mlHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

app.get('/api/ml/auth/url', requireAuthJson, (req, res) => {
  if (!ML_CLIENT_ID) return res.status(400).json({ error: 'ML_CLIENT_ID não configurado' });
  const params = new URLSearchParams({ response_type: 'code', client_id: ML_CLIENT_ID, redirect_uri: ML_REDIRECT_URI, state: 'estoque_max_ml' });
  res.json({ authUrl: `https://auth.mercadolivre.com.br/authorization?${params}` });
});

app.get('/api/ml/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/dashboard.html?ml_error=${encodeURIComponent(error)}`);
  if (!code) return res.redirect('/dashboard.html?ml_error=no_code');
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code', client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET, code, redirect_uri: ML_REDIRECT_URI,
    });
    const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    });
    await saveMLTokens(data.access_token, data.refresh_token, data.user_id, data.expires_in || 21600);
    res.redirect('/dashboard.html?ml_connected=1');
  } catch (err) {
    console.error('[ML OAuth]', err.response?.data || err.message);
    res.redirect('/dashboard.html?ml_error=token_exchange_failed');
  }
});

app.get('/api/ml/status', requireAuthJson, async (req, res) => {
  const ml = await ensureMLToken();
  if (!ml?.token) return res.json({ connected: false });
  try {
    const { data } = await axios.get('https://api.mercadolibre.com/users/me', { headers: mlHeaders(ml.token) });
    res.json({ connected: true, sellerId: ml.sellerId, apelido: data.nickname, nome: data.first_name + ' ' + data.last_name, pontuacao: data.seller_reputation?.power_seller_status || null, pais: data.country_id || 'BR' });
  } catch (e) { res.json({ connected: true, sellerId: ml.sellerId }); }
});

app.get('/api/ml/perguntas', requireAuthJson, async (req, res) => {
  const ml = await ensureMLToken();
  if (!ml?.token) return res.status(401).json({ error: 'ML não conectado', code: 'ML_NOT_CONNECTED' });
  try {
    const { data } = await axios.get(`https://api.mercadolibre.com/questions/search?seller_id=${ml.sellerId}&status=UNANSWERED&limit=50&api_version=4`, { headers: mlHeaders(ml.token) });
    const qs = (data.questions || []).map(q => ({
      id: q.id, itemId: q.item_id, texto: q.text,
      data: q.date_created, comprador: q.from?.nickname || '—',
    }));
    res.json({ perguntas: qs, total: data.total || qs.length });
  } catch (e) { sendErrorResponse(res, 500, 'Erro ao buscar perguntas', e.message); }
});

app.post('/api/ml/perguntas/:id/responder', requireAuthJson, async (req, res) => {
  const ml = await ensureMLToken();
  if (!ml?.token) return res.status(401).json({ error: 'ML não conectado', code: 'ML_NOT_CONNECTED' });
  const { resposta } = req.body;
  if (!resposta?.trim()) return res.status(400).json({ error: 'Resposta é obrigatória' });
  try {
    await axios.post('https://api.mercadolibre.com/answers', { question_id: Number(req.params.id), text: resposta.trim() }, { headers: mlHeaders(ml.token) });
    res.json({ ok: true });
  } catch (e) { sendErrorResponse(res, 500, 'Erro ao responder pergunta', e.message); }
});

app.get('/api/ml/anuncios', requireAuthJson, async (req, res) => {
  const ml = await ensureMLToken();
  if (!ml?.token) return res.status(401).json({ error: 'ML não conectado', code: 'ML_NOT_CONNECTED' });
  try {
    const status = req.query.status || 'active';
    const { data: searchData } = await axios.get(`https://api.mercadolibre.com/users/${ml.sellerId}/items/search?status=${status}&limit=50`, { headers: mlHeaders(ml.token) });
    const ids = (searchData.results || []).slice(0, 20);
    if (!ids.length) return res.json({ anuncios: [] });
    const { data: itemsData } = await axios.get(`https://api.mercadolibre.com/items?ids=${ids.join(',')}&attributes=id,title,price,available_quantity,status,thumbnail,permalink`, { headers: mlHeaders(ml.token) });
    const anuncios = (itemsData || []).map(r => r.body || r).filter(Boolean).map(it => ({
      id: it.id, titulo: it.title, preco: it.price, qtd: it.available_quantity,
      situacao: it.status, thumb: it.thumbnail, link: it.permalink,
    }));
    res.json({ anuncios, total: searchData.paging?.total || anuncios.length });
  } catch (e) { sendErrorResponse(res, 500, 'Erro ao buscar anúncios', e.message); }
});

app.get('/api/ml/metricas', requireAuthJson, async (req, res) => {
  const ml = await ensureMLToken();
  if (!ml?.token) return res.status(401).json({ error: 'ML não conectado', code: 'ML_NOT_CONNECTED' });
  try {
    const [rep, orders] = await Promise.allSettled([
      axios.get(`https://api.mercadolibre.com/users/${ml.sellerId}`, { headers: mlHeaders(ml.token) }),
      axios.get(`https://api.mercadolibre.com/orders/search?seller=${ml.sellerId}&sort=date_desc&limit=10`, { headers: mlHeaders(ml.token) }),
    ]);
    const seller = rep.status === 'fulfilled' ? rep.value.data : {};
    const recentOrders = orders.status === 'fulfilled' ? (orders.value.data?.results || []) : [];
    const repSeller = seller.seller_reputation || {};
    const transactions = repSeller.transactions || {};
    const ratings = transactions.ratings || {};
    const totalRatings = (ratings.positive || 0) + (ratings.negative || 0) + (ratings.neutral || 0);
    const txCancelamentos = repSeller.metrics?.claims?.rate != null
      ? (repSeller.metrics.claims.rate * 100)
      : null;
    const txReclamacoes = repSeller.metrics?.delayed_handling_time?.rate != null
      ? (repSeller.metrics.delayed_handling_time.rate * 100)
      : null;
    res.json({
      pontuacao: repSeller.power_seller_status || null,
      nivelVendedor: repSeller.level_id || null,
      vendas30d: transactions.completed || null,
      avaliacaoPositiva: totalRatings ? Math.round((ratings.positive || 0) / totalRatings * 100) : null,
      txCancelamentos,
      txReclamacoes,
      ultimosPedidos: recentOrders.slice(0, 5).map(o => ({
        id: o.id, total: o.total_amount, status: o.status, data: o.date_created,
        statusPT: { paid: 'Pago', pending: 'Pendente', cancelled: 'Cancelado', partially_refunded: 'Estornado' }[o.status] || o.status,
      })),
    });
  } catch (e) { sendErrorResponse(res, 500, 'Erro ao buscar métricas ML', e.message); }
});

// ── Produtos ─────────────────────────────────────────────────────────

app.get('/api/produtos', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });

  try {
    // Fetch up to 500 products (paginated)
    const limit = 100;
    let page = 1;
    let allProducts = [];
    let hasMore = true;

    while (hasMore && page <= 5) {
      const { data } = await axios.get('https://www.bling.com.br/Api/v3/produtos', {
        headers: { Authorization: `Bearer ${token}` },
        params: { limite: limit, pagina: page },
      });
      const items = Array.isArray(data?.data) ? data.data : [];
      allProducts = allProducts.concat(items);
      hasMore = items.length === limit;
      page++;
    }

    const products = allProducts.map(p => ({
      id:         p.id,
      nome:       p.nome       || 'Sem nome',
      codigo:     p.codigo     || '',
      preco:      typeof p.preco === 'number' ? p.preco : 0,
      precoCusto: typeof p.precoCusto === 'number' ? p.precoCusto : 0,
      estoque:    typeof p.estoque === 'object' ? (p.estoque?.saldoVirtualTotal ?? 0) : (p.estoque ?? 0),
      tipo:       p.tipo || 'P',
      unidade:    p.unidade || 'un',
      peso:       p.pesoBruto || 0,
      descricao:  p.descricaoComplementar || p.descricao || '',
      categoria:  p.categoria?.descricao || '',
      situacao:   String(p.situacao?.valor || p.situacao || 'A'),
      imagemUrl:  p.imagem?.link || p.imageThumbnailURL || '',
    }));

    res.json({ total: products.length, products });
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token Bling expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, 500, 'Erro ao buscar produtos', err.message);
  }
});

// Busca produto completo (para editor)
app.get('/api/produtos/:id', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });
  try {
    const produtoId = validateNumericId(req.params.id, 'ID do produto');
    const { data } = await axios.get(`https://www.bling.com.br/Api/v3/produtos/${produtoId}`, {
      headers: blingHeaders(token),
    });
    res.json(data?.data || {});
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    if (err.response?.status === 404) return res.status(404).json({ error: 'Produto não encontrado' });
    sendErrorResponse(res, 500, 'Erro ao buscar produto', err.message);
  }
});

// Criar produto novo
app.post('/api/produtos', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });
  try {
    const { data } = await axios.post('https://www.bling.com.br/Api/v3/produtos', req.body, {
      headers: blingHeaders(token),
    });
    const criado = data?.data || data;
    changeLog.push({
      id: changeLog.length + 1, produto_id: criado?.id || '—',
      produto_nome: req.body.nome || 'Novo produto', campo: 'criação',
      valor_anterior: '—', valor_novo: req.body.nome || '—',
      timestamp: new Date().toISOString(),
    });
    res.json(criado);
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.response?.data || err.message;
    sendErrorResponse(res, 500, 'Erro ao criar produto', detail);
  }
});

// Busca pedidos de venda num intervalo (paginado)
async function fetchPedidos(token, inicio, fim, maxPg = 3) {
  let all = [];
  for (let pg = 1; pg <= maxPg; pg++) {
    const { data } = await axios.get('https://www.bling.com.br/Api/v3/pedidos/vendas', {
      headers: { Authorization: `Bearer ${token}` },
      params: { limite: 100, pagina: pg, dataInicial: inicio, dataFinal: fim },
    });
    const items = Array.isArray(data?.data) ? data.data : [];
    all = all.concat(items);
    if (items.length < 100) break;
  }
  return all;
}

const categorizePedido = s => {
  const raw = String(s?.nome || s?.valor || s || '');
  const n = (situacaoPT(raw)).toLowerCase();
  if (n.includes('cancel') || n.includes('devolv') || n.includes('reembolsad') || n.includes('suspenso') || n.includes('falhou')) return 'cancelado';
  if (n.includes('atend') || n.includes('conclui') || n.includes('entregue') || n.includes('faturad') || n.includes('despachad') || n.includes('enviado') || n.includes('encerrad')) return 'concluido';
  return 'pendente';
};
const valorPedido = p => p.totalVenda || p.totalProdutos || 0;

// Calcula o intervalo imediatamente anterior, de mesma duração
function periodoAnterior(inicio, fim) {
  const dI = new Date(inicio + 'T12:00:00'), dF = new Date(fim + 'T12:00:00');
  const dur = dF - dI;
  const prevFim = new Date(dI.getTime() - 86400000);
  const prevIni = new Date(prevFim.getTime() - dur);
  const iso = d => d.toISOString().split('T')[0];
  return { inicio: iso(prevIni), fim: iso(prevFim) };
}

// Resumo financeiro com suporte a períodos + comparativo
app.get('/api/financeiro', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });
  try {
    const { inicio, fim, period } = resolvePeriodo(req.query.period, req.query.startDate, req.query.endDate);
    const prev = periodoAnterior(inicio, fim);

    // Período atual (3 págs) + período anterior (2 págs) em paralelo
    const [allPedidos, prevPedidos] = await Promise.all([
      fetchPedidos(token, inicio, fim, 3),
      fetchPedidos(token, prev.inicio, prev.fim, 2).catch(() => []),
    ]);

    const categorize = categorizePedido;
    const concluidos = allPedidos.filter(p => categorize(p.situacao) === 'concluido');
    const cancelados = allPedidos.filter(p => categorize(p.situacao) === 'cancelado');
    const pendentes  = allPedidos.filter(p => categorize(p.situacao) === 'pendente');

    const sum = (arr, fn) => arr.reduce((a, p) => a + (fn(p) || 0), 0);
    const totalBruto       = sum(allPedidos, valorPedido);
    const receitaConcluida = sum(concluidos,  valorPedido);
    const totalCancelado   = sum(cancelados,  valorPedido);
    const totalPendente    = sum(pendentes,   valorPedido);
    const totalFrete       = sum(allPedidos, p => p.totalFrete || p.frete);
    const totalDesconto    = sum(allPedidos, p => p.desconto);

    // Comparativo com período anterior (faturamento concluído)
    const prevConcluidos = prevPedidos.filter(p => categorize(p.situacao) === 'concluido');
    const prevReceita = sum(prevConcluidos, valorPedido);
    const variacao = prevReceita > 0 ? ((receitaConcluida - prevReceita) / prevReceita) * 100 : null;

    // Série diária para gráfico (apenas pedidos concluídos = receita real)
    const byDay = {};
    concluidos.forEach(p => {
      const day = String(p.data || p.dataPedido || '').substring(0, 10);
      if (day) byDay[day] = (byDay[day] || 0) + valorPedido(p);
    });

    res.json({
      periodo: { inicio, fim, period },
      totalBruto, receitaConcluida, totalCancelado, totalPendente,
      totalFrete, totalDesconto,
      totalPedidos: allPedidos.length,
      concluidos: concluidos.length,
      cancelados: cancelados.length,
      pendentes: pendentes.length,
      ticketMedio: concluidos.length > 0 ? receitaConcluida / concluidos.length : 0,
      comparativo: { receitaAnterior: prevReceita, variacao, inicio: prev.inicio, fim: prev.fim },
      byDay,
    });
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, 500, 'Erro ao buscar dados financeiros', err.message);
  }
});

app.patch('/api/produtos/:id', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });

  try {
    const id = validateNumericId(req.params.id, 'ID do produto');
    const { estoque, preco, precoCusto, nome_produto, valor_anterior, _fullUpdate } = req.body;

    // Atualização completa via drawer editor
    if (_fullUpdate) {
      try {
      // Converte imagemUrl (campo frontend) para formato Bling
      const payload = { ..._fullUpdate };
      if (payload.imagemUrl !== undefined) {
        if (payload.imagemUrl) payload.imagem = { link: payload.imagemUrl };
        delete payload.imagemUrl;
      }
      await axios.put(`https://www.bling.com.br/Api/v3/produtos/${id}`, payload, {
        headers: blingHeaders(token),
      });
      if (estoque !== undefined) {
        const depositoId = await getDepositoId(token);
        await axios.post('https://www.bling.com.br/Api/v3/estoques',
          { produto: { id: Number(id) }, deposito: { id: depositoId }, operacao: 'B', quantidade: Number(estoque) },
          { headers: blingHeaders(token) }
        );
      }
      changeLog.push({
        id: changeLog.length + 1, produto_id: id,
        produto_nome: _fullUpdate.nome || `#${id}`, campo: 'edição completa',
        valor_anterior: '—', valor_novo: 'campos atualizados',
        timestamp: new Date().toISOString(),
      });
      return res.json({ success: true });
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.response?.data || err.message;
      return sendErrorResponse(res, 500, 'Erro ao salvar produto', detail);
    }
  }

  try {
    if (preco !== undefined) {
      // Busca o produto completo antes de atualizar (Bling exige objeto completo no PUT)
      const { data: current } = await axios.get(
        `https://www.bling.com.br/Api/v3/produtos/${id}`,
        { headers: blingHeaders(token) }
      );
      const prod = current?.data || {};
      await axios.put(
        `https://www.bling.com.br/Api/v3/produtos/${id}`,
        { ...prod, preco: Number(preco) },
        { headers: blingHeaders(token) }
      );
      changeLog.push({
        id: changeLog.length + 1, produto_id: id,
        produto_nome: nome_produto || `#${id}`, campo: 'preço',
        valor_anterior: valor_anterior || '—',
        valor_novo: `R$ ${Number(preco).toFixed(2)}`,
        timestamp: new Date().toISOString(),
      });
    }
    if (precoCusto !== undefined) {
      const { data: current } = await axios.get(
        `https://www.bling.com.br/Api/v3/produtos/${id}`,
        { headers: blingHeaders(token) }
      );
      const prod = current?.data || {};
      await axios.put(
        `https://www.bling.com.br/Api/v3/produtos/${id}`,
        { ...prod, precoCusto: Number(precoCusto) },
        { headers: blingHeaders(token) }
      );
      changeLog.push({
        id: changeLog.length + 1, produto_id: id,
        produto_nome: nome_produto || `#${id}`, campo: 'custo',
        valor_anterior: valor_anterior || '—',
        valor_novo: `R$ ${Number(precoCusto).toFixed(2)}`,
        timestamp: new Date().toISOString(),
      });
    }
    if (estoque !== undefined) {
      const depositoId = await getDepositoId(token);
      await axios.post('https://www.bling.com.br/Api/v3/estoques',
        { produto: { id: Number(id) }, deposito: { id: depositoId }, operacao: 'B', quantidade: Number(estoque) },
        { headers: blingHeaders(token) }
      );
      const { motivo } = req.body;
      changeLog.push({
        id: changeLog.length + 1, produto_id: id,
        produto_nome: nome_produto || `#${id}`, campo: 'estoque',
        valor_anterior: valor_anterior || '—',
        valor_novo: `${Number(estoque)} un.${motivo ? ' — ' + motivo : ''}`,
        timestamp: new Date().toISOString(),
      });
    }
    res.json({ success: true });
    } catch (err) {
      console.error('[Update]', err.response?.data || err.message);
      const detail = err.response?.data?.error?.message || err.response?.data || err.message;
      sendErrorResponse(res, 500, 'Erro ao atualizar produto', detail);
    }
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    console.error('[Update]', err.message);
    sendErrorResponse(res, 500, 'Erro ao processar requisição', err.message);
  }
});

app.delete('/api/produtos/:id', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });

  try {
    const id = validateNumericId(req.params.id, 'ID do produto');
    const nomeProduto = req.body?.nome_produto || `#${id}`;
    await axios.delete(`https://www.bling.com.br/Api/v3/produtos/${id}`, { headers: blingHeaders(token) });
    changeLog.push({
      id: changeLog.length + 1, produto_id: id,
      produto_nome: nomeProduto, campo: 'exclusão',
      valor_anterior: 'produto ativo', valor_novo: 'excluído',
      timestamp: new Date().toISOString(),
    });
    res.json({ success: true });
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    const detail = err.response?.data?.error?.message || err.response?.data || err.message;
    sendErrorResponse(res, 500, 'Erro ao excluir produto', detail);
  }
});

app.post('/api/produtos/:id/duplicar', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });

  try {
    const id = validateNumericId(req.params.id, 'ID do produto');
    const { data } = await axios.get(`https://www.bling.com.br/Api/v3/produtos/${id}`, { headers: blingHeaders(token) });
    const prod = data?.data || {};
    const payload = { ...prod };
    delete payload.id;
    payload.nome = `${prod.nome || 'Produto'} (cópia)`;
    payload.codigo = prod.codigo ? `${prod.codigo}-COPIA${Date.now().toString().slice(-5)}` : undefined;
    const { data: created } = await axios.post('https://www.bling.com.br/Api/v3/produtos', payload, { headers: blingHeaders(token) });
    changeLog.push({
      id: changeLog.length + 1, produto_id: created?.data?.id || '—',
      produto_nome: payload.nome, campo: 'duplicação',
      valor_anterior: `origem #${id}`, valor_novo: 'produto criado',
      timestamp: new Date().toISOString(),
    });
    res.json({ success: true, id: created?.data?.id });
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    const detail = err.response?.data?.error?.message || err.response?.data || err.message;
    sendErrorResponse(res, 500, 'Erro ao duplicar produto', detail);
  }
});

// Importação em lote via CSV
app.post('/api/produtos/importar', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });

  const { produtos } = req.body || {};
  if (!Array.isArray(produtos) || !produtos.length)
    return res.status(400).json({ error: 'Nenhum produto enviado' });

  let success = 0;
  const errors = [];

  for (const p of produtos) {
    try {
      if (p.preco !== undefined && p.preco !== '') {
        await axios.put(`https://www.bling.com.br/Api/v3/produtos/${p.id}`,
          { preco: Number(p.preco) },
          { headers: blingHeaders(token) }
        );
      }
      if (p.estoque !== undefined && p.estoque !== '') {
        const depositoId = await getDepositoId(token);
        await axios.post('https://www.bling.com.br/Api/v3/estoques',
          { produto: { id: Number(p.id) }, deposito: { id: depositoId }, operacao: 'B', quantidade: Number(p.estoque) },
          { headers: blingHeaders(token) }
        );
      }
      changeLog.push({
        id: changeLog.length + 1,
        produto_id: p.id,
        produto_nome: p.nome || `#${p.id}`,
        campo: 'importação CSV',
        valor_anterior: '—',
        valor_novo: `preço=${p.preco ?? '—'}, estoque=${p.estoque ?? '—'}`,
        timestamp: new Date().toISOString(),
      });
      success++;
    } catch (err) {
      errors.push({ id: p.id, nome: p.nome, error: err.response?.data?.error?.message || err.message });
    }
  }

  res.json({ success, errors, total: produtos.length });
});

// ── Pedidos ──────────────────────────────────────────────────────────

app.get('/api/pedidos', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });

  try {
    const { inicio, fim } = req.query;
    let raw;
    if (inicio && fim) {
      raw = await fetchPedidos(token, inicio, fim, 5);
    } else {
      const { data } = await axios.get('https://www.bling.com.br/Api/v3/pedidos/vendas', {
        headers: { Authorization: `Bearer ${token}` },
        params: { limite: 100, pagina: 1 },
      });
      raw = Array.isArray(data?.data) ? data.data : [];
    }

    const pedidos = raw.map(p => ({
      id:        p.id,
      numero:    p.numero,
      data:      p.data,
      valor:     Number(p.totalProdutos) || Number(p.totalVenda) || Number(p.total) || 0,
      situacao:  situacaoPT(p.situacao?.nome || p.situacao?.valor || p.situacao),
      contato:   p.contato?.nome || '—',
    }));

    res.json({ total: pedidos.length, pedidos });
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, 500, 'Erro ao buscar pedidos', err.message);
  }
});

app.get('/api/pedidos/:id', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });

  try {
    const id = validateNumericId(req.params.id, 'ID do pedido');
    const { data } = await axios.get(`https://www.bling.com.br/Api/v3/pedidos/vendas/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const p = data?.data || data || {};
    const itens = (Array.isArray(p.itens) ? p.itens : []).map(it => ({
      codigo:    it.codigo || it.produto?.codigo || '',
      descricao: it.descricao || it.produto?.nome || 'Item',
      qtd:       Number(it.quantidade) || 0,
      valor:     Number(it.valor) || 0,
      total:     (Number(it.quantidade) || 0) * (Number(it.valor) || 0),
    }));

    res.json({
      id:          p.id,
      numero:      p.numero,
      data:        p.data,
      situacao:    situacaoPT(p.situacao?.nome || p.situacao?.valor || p.situacao),
      contato:     p.contato?.nome || '—',
      contatoDoc:  p.contato?.numeroDocumento || '',
      contatoTel:  p.contato?.celular || p.contato?.telefone || '',
      observacoes: p.observacoes || p.observacoesInternas || '',
      total:       Number(p.totalProdutos) || Number(p.totalVenda) || Number(p.total) || 0,
      frete:            Number(p.transporte?.frete) || Number(p.transporte?.valorFrete) || 0,
      transportadora:   p.transporte?.transportadora?.nome || _TRANSP_TIPO[p.transporte?.tipo] || '',
      desconto:         Number(p.desconto) || 0,
      itens,
    });
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, err.response?.status === 404 ? 404 : 500, 'Erro ao buscar detalhe do pedido', err.message);
  }
});

// ── Notas Fiscais ─────────────────────────────────────────────────────

app.get('/api/notas-fiscais', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });
  try {
    const { data } = await axios.get('https://www.bling.com.br/Api/v3/nfe', {
      headers: { Authorization: `Bearer ${token}` },
      params: { limite: 50, pagina: 1 },
    });
    const notas = (Array.isArray(data?.data) ? data.data : []).map(n => ({
      id:          n.id,
      numero:      n.numero,
      serie:       n.serie || '1',
      dataEmissao: n.dataEmissao || n.data || '',
      total:       n.totalProdutos || n.total || n.valor || 0,
      situacao:    String(n.situacao?.nome || n.situacao?.valor || n.situacao || '—'),
      chave:       n.chaveAcesso || n.chave || '',
      contato:     n.contato?.nome || '—',
    }));
    res.json({ total: notas.length, notas });
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, 500, 'Erro ao buscar NF-e', err.message);
  }
});

app.get('/api/nfe/:id/detalhe', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });
  try {
    const id = validateNumericId(req.params.id, 'ID da NF-e');
    const { data } = await axios.get(`https://www.bling.com.br/Api/v3/nfe/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const n = data?.data || data || {};
    const itens = (Array.isArray(n.itens) ? n.itens : []).map(it => ({
      descricao: it.descricao || it.produto?.nome || 'Item',
      codigo: it.codigo || it.produto?.codigo || '',
      qtd: Number(it.quantidade) || 0,
      valor: Number(it.valor) || 0,
      total: (Number(it.quantidade) || 0) * (Number(it.valor) || 0),
    }));
    res.json({
      id: n.id,
      numero: n.numero,
      serie: n.serie || '1',
      dataEmissao: n.dataEmissao || n.data || '',
      total: n.totalProdutos || n.total || n.valor || 0,
      totalFrete: Number(n.totalFrete || 0),
      totalDesconto: Number(n.totalDesconto || 0),
      situacao: String(n.situacao?.nome || n.situacao?.valor || n.situacao || '—'),
      chave: n.chaveAcesso || n.chave || '',
      contato: n.contato?.nome || '—',
      contatoDoc: n.contato?.numeroDocumento || '',
      natureza: n.naturezaOperacao || '',
      modelo: n.modelo || '55',
      itens,
    });
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, err.response?.status === 404 ? 404 : 500, 'Erro ao buscar NF-e', err.message);
  }
});

app.get('/api/nfe/:id/danfe', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });
  try {
    const id = validateNumericId(req.params.id, 'ID da NF-e');
    const { data } = await axios.get(`https://www.bling.com.br/Api/v3/nfe/${id}/danfe`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const link = data?.data?.link || data?.link;
    if (!link) return res.status(404).json({ error: 'Link da DANFE não disponível' });
    res.json({ link });
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, err.response?.status || 500, 'Erro ao buscar DANFE', err.message);
  }
});

app.post('/api/nfe/emitir', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });
  const { pedidoId, obs } = req.body || {};
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId é obrigatório' });
  try {
    const payload = { pedido: { id: Number(pedidoId) } };
    if (obs) payload.observacoes = obs;
    const { data } = await axios.post('https://www.bling.com.br/Api/v3/nfe', payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    res.json({ ok: true, nfe: data?.data || data });
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    const detail = err.response?.data?.error?.fields?.[0]?.msg
      || err.response?.data?.error?.message
      || err.message;
    sendErrorResponse(res, err.response?.status || 500, 'Erro ao emitir NF-e', detail);
  }
});

app.post('/api/push/subscribe', requireAuthJson, async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token FCM obrigatório' });
  const admin = getAdmin();
  if (!admin) {
    return res.status(503).json({ error: 'Firebase não configurado. Configure FIREBASE_SERVICE_ACCOUNT.' });
  }
  try {
    await admin.firestore().collection('fcm_tokens').doc(token.slice(0, 128)).set({
      token, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true, mode: 'firestore' });
  } catch (e) {
    sendErrorResponse(res, 500, 'Erro ao registrar token FCM', e.message);
  }
});

app.post('/api/push/send', requireAuthJson, async (req, res) => {
  const { title = 'Estoque Max', body = 'Nova notificação', url = '/dashboard.html' } = req.body || {};
  const admin = getAdmin();
  if (!admin) return res.status(503).json({ error: 'Firebase Admin não configurado (FIREBASE_SERVICE_ACCOUNT ausente)' });
  try {
    const snap = await admin.firestore().collection('fcm_tokens').get();
    const tokens = snap.docs.map(d => d.data().token).filter(Boolean);
    if (!tokens.length) return res.json({ ok: true, sent: 0, msg: 'Nenhum dispositivo inscrito' });
    const result = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      webpush: { fcmOptions: { link: url } },
    });
    // Remove tokens inválidos e salva no histórico
    const invalid = result.responses
      .map((r, i) => (!r.success && r.error?.code === 'messaging/registration-token-not-registered') ? tokens[i] : null)
      .filter(Boolean);
    const ops = [];
    if (invalid.length) {
      const batch = admin.firestore().batch();
      invalid.forEach(t => batch.delete(admin.firestore().collection('fcm_tokens').doc(t.slice(0, 128))));
      ops.push(batch.commit());
    }
    ops.push(admin.firestore().collection('notif_history').add({
      title, body, url, action: req.body?.action || null,
      status: 'sent', sent: result.successCount, failed: result.failureCount,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
    await Promise.all(ops);
    res.json({ ok: true, sent: result.successCount, failed: result.failureCount });
  } catch (e) {
    sendErrorResponse(res, 500, 'Erro ao enviar notificações', e.message);
  }
});

// ── Notificações Push ────────────────────────────────────────────────

app.get('/api/notif/history', requireAuthJson, async (req, res) => {
  const admin = getAdmin();
  if (!admin) return res.json({ history: [], subscribers: 0 });
  try {
    const [histSnap, tokSnap] = await Promise.all([
      admin.firestore().collection('notif_history').orderBy('createdAt', 'desc').limit(50).get(),
      admin.firestore().collection('fcm_tokens').get(),
    ]);
    const history = histSnap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        title: data.title,
        body: data.body,
        url: data.url,
        action: data.action,
        status: data.status,
        sent: data.sent ?? null,
        sendAt: data.sendAt?.toDate?.()?.toISOString() ?? data.sendAt ?? null,
        sentAt: data.sentAt?.toDate?.()?.toISOString() ?? null,
        createdAt: data.createdAt?.toDate?.()?.toISOString() ?? null,
      };
    });
    res.json({ history, subscribers: tokSnap.size });
  } catch (e) {
    sendErrorResponse(res, 500, 'Erro ao buscar histórico de notificações', e.message);
  }
});

app.post('/api/notif/schedule', requireAuthJson, async (req, res) => {
  const { title, body, url = '/dashboard.html', action, sendAt } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title e body são obrigatórios' });
  if (!sendAt) return res.status(400).json({ error: 'sendAt é obrigatório' });
  const admin = getAdmin();
  if (!admin) return res.status(503).json({ error: 'Firebase não configurado' });
  try {
    const ref = await admin.firestore().collection('notif_history').add({
      title, body, url, action: action || null,
      sendAt: new Date(sendAt),
      status: 'scheduled',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true, id: ref.id });
  } catch (e) {
    sendErrorResponse(res, 500, 'Erro ao agendar notificação', e.message);
  }
});

app.delete('/api/notif/schedule/:id', requireAuthJson, async (req, res) => {
  const admin = getAdmin();
  if (!admin) return res.status(503).json({ error: 'Firebase não configurado' });
  try {
    await admin.firestore().collection('notif_history').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) {
    sendErrorResponse(res, 500, 'Erro ao deletar notificação agendada', e.message);
  }
});

// ── Notificações automáticas (resumos por horário + alertas) ─────

// Envia push para todos os inscritos e registra no histórico
async function pushParaTodos(admin, { title, body, url = '/dashboard.html', tipo = 'auto' }) {
  const snap = await admin.firestore().collection('fcm_tokens').get();
  const tokens = snap.docs.map(d => d.data().token).filter(Boolean);
  let sent = 0;
  if (tokens.length) {
    const result = await admin.messaging().sendEachForMulticast({
      tokens, notification: { title, body }, webpush: { fcmOptions: { link: url } },
    });
    sent = result.successCount;
    const invalid = result.responses
      .map((r, i) => (!r.success && r.error?.code === 'messaging/registration-token-not-registered') ? tokens[i] : null)
      .filter(Boolean);
    if (invalid.length) {
      const batch = admin.firestore().batch();
      invalid.forEach(t => batch.delete(admin.firestore().collection('fcm_tokens').doc(t.slice(0, 128))));
      await batch.commit();
    }
  }
  await admin.firestore().collection('notif_history').add({
    title, body, url, tipo, status: 'sent', sent,
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return sent;
}

// Busca produtos do Bling p/ margem média e alertas de estoque
async function fetchResumoProdutos(token, maxPg = 3) {
  let all = [];
  for (let pg = 1; pg <= maxPg; pg++) {
    const { data } = await axios.get('https://www.bling.com.br/Api/v3/produtos', {
      headers: { Authorization: `Bearer ${token}` }, params: { limite: 100, pagina: pg },
    });
    const items = Array.isArray(data?.data) ? data.data : [];
    all = all.concat(items);
    if (items.length < 100) break;
  }
  const prods = all.map(p => ({
    preco: typeof p.preco === 'number' ? p.preco : 0,
    custo: typeof p.precoCusto === 'number' ? p.precoCusto : 0,
    estoque: typeof p.estoque === 'object' ? (p.estoque?.saldoVirtualTotal ?? 0) : (p.estoque ?? 0),
  }));
  const comCusto = prods.filter(p => p.preco > 0 && p.custo > 0);
  const margem = comCusto.length ? comCusto.reduce((a, p) => a + (p.preco - p.custo) / p.preco, 0) / comCusto.length : 0;
  return {
    margem,
    zerados: prods.filter(p => p.estoque <= 0).length,
    criticos: prods.filter(p => p.estoque > 0 && p.estoque <= 5).length,
  };
}

function horaBR() { return (new Date().getUTCHours() - 3 + 24) % 24; }
function slotAtual() {
  const h = horaBR();
  if (h < 11) return 'manha';
  if (h < 14) return 'almoco';
  if (h < 18) return 'tarde';
  return 'jantar';
}
function checkCronSecret(req) {
  if (!process.env.CRON_SECRET) return true; // sem secret configurado, libera (uso interno)
  return req.headers['x-cron-secret'] === process.env.CRON_SECRET || req.query.secret === process.env.CRON_SECRET;
}
function montaResumo(slot, { fat, lucro, nv, zerados, brl, temMargem }) {
  const lucroTxt = temMargem ? ` · lucro estimado ${brl(lucro)}` : '';
  const semVenda = nv === 0;
  if (slot === 'manha') return {
    title: '☀️ Bom dia! Resumo de ontem',
    body: semVenda ? 'Ontem não houve vendas concluídas. Bora pra cima hoje! 💪'
      : `Ontem: ${nv} venda(s), ${brl(fat)} faturado${lucroTxt}. Vamos superar hoje! 🚀`,
  };
  if (slot === 'almoco') return {
    title: '🍽️ Parcial do almoço',
    body: semVenda ? 'Ainda sem vendas hoje. Que tal aquecer as ofertas? 📣'
      : `Hoje até agora: ${nv} venda(s), ${brl(fat)}${lucroTxt}.`,
  };
  if (slot === 'tarde') return {
    title: '☕ Resumo da tarde',
    body: semVenda ? 'Tarde sem vendas até agora. Hora de divulgar! 📲'
      : `Parcial de hoje: ${nv} venda(s), ${brl(fat)}${lucroTxt}.${zerados ? ` ⚠️ ${zerados} zerado(s).` : ''}`,
  };
  return {
    title: '🌙 Fechamento do dia',
    body: semVenda ? 'Dia sem vendas concluídas. Amanhã viramos o jogo! 🌅'
      : `Hoje: ${nv} venda(s), ${brl(fat)} faturado${lucroTxt}. Bom descanso! 🌙`,
  };
}

// Cron: resumo de lucro/vendas por horário
app.get('/api/cron/resumo', async (req, res) => {
  if (!checkCronSecret(req)) return res.status(401).json({ error: 'unauthorized' });
  const admin = getAdmin();
  if (!admin) return res.json({ ok: true, skipped: 'Firebase não configurado' });
  const token = await getCronBlingToken();
  if (!token) return res.json({ ok: true, skipped: 'Bling não conectado (sem refresh salvo)' });
  const slot = req.query.slot || slotAtual();
  try {
    const ref = new Date();
    if (slot === 'manha') ref.setDate(ref.getDate() - 1);
    const dia = ref.toISOString().split('T')[0];
    const [pedidos, prod] = await Promise.all([
      fetchPedidos(token, dia, dia, 2),
      fetchResumoProdutos(token, 3).catch(() => ({ margem: 0, zerados: 0, criticos: 0 })),
    ]);
    const concl = pedidos.filter(p => categorizePedido(p.situacao) === 'concluido');
    const fat = concl.reduce((a, p) => a + valorPedido(p), 0);
    const brl = v => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const { title, body } = montaResumo(slot, { fat, lucro: fat * prod.margem, nv: concl.length, zerados: prod.zerados, brl, temMargem: prod.margem > 0 });
    const sent = await pushParaTodos(admin, { title, body, tipo: 'resumo' });
    res.json({ ok: true, slot, sent, fat, nv: concl.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cron: alerta de estoque zerado/crítico
app.get('/api/cron/estoque', async (req, res) => {
  if (!checkCronSecret(req)) return res.status(401).json({ error: 'unauthorized' });
  const admin = getAdmin();
  if (!admin) return res.json({ ok: true, skipped: 'Firebase não configurado' });
  const token = await getCronBlingToken();
  if (!token) return res.json({ ok: true, skipped: 'Bling não conectado' });
  try {
    const prod = await fetchResumoProdutos(token, 5);
    if (!prod.zerados && !prod.criticos) return res.json({ ok: true, sent: 0, msg: 'sem alertas' });
    const body = `${prod.zerados} produto(s) zerado(s)` + (prod.criticos ? ` e ${prod.criticos} crítico(s) (≤5)` : '') + '. Toque para repor.';
    const sent = await pushParaTodos(admin, { title: '⚠️ Alerta de estoque', body, tipo: 'estoque' });
    res.json({ ok: true, sent, zerados: prod.zerados, criticos: prod.criticos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cron: processa notificações agendadas (chamado pelo Vercel Cron a cada minuto)
app.get('/api/cron/push', async (req, res) => {
  if (!checkCronSecret(req)) return res.status(401).json({ error: 'unauthorized' });
  const admin = getAdmin();
  if (!admin) return res.json({ ok: true, skipped: 'Firebase não configurado' });
  try {
    const now = new Date();
    const snap = await admin.firestore().collection('notif_history')
      .where('status', '==', 'scheduled')
      .where('sendAt', '<=', now)
      .get();
    if (snap.empty) return res.json({ ok: true, sent: 0 });
    const tokSnap = await admin.firestore().collection('fcm_tokens').get();
    const tokens = tokSnap.docs.map(d => d.data().token).filter(Boolean);
    let sent = 0;
    const batch = admin.firestore().batch();
    for (const doc of snap.docs) {
      const { title, body, url = '/dashboard.html', action } = doc.data();
      try {
        let successCount = 0;
        if (tokens.length) {
          const msg = { tokens, notification: { title, body }, webpush: { fcmOptions: { link: url } } };
          if (action) msg.webpush.notification = { actions: [{ action: 'open', title: action }] };
          const result = await admin.messaging().sendEachForMulticast(msg);
          successCount = result.successCount;
        }
        batch.update(doc.ref, { status: 'sent', sent: successCount, sentAt: admin.firestore.FieldValue.serverTimestamp() });
        sent++;
      } catch (e) {
        batch.update(doc.ref, { status: 'error', error: e.message });
      }
    }
    await batch.commit();
    res.json({ ok: true, sent });
  } catch (e) {
    sendErrorResponse(res, 500, 'Erro no cron de notificações', e.message);
  }
});

// ── Contas a pagar / receber ──────────────────────────────────────

// Normaliza situação de conta Bling (1=aberto, 2=recebido/pago, 3=parcial, 4=cancelado/baixado)
function contaEmAberto(situacao) {
  const n = String(situacao?.valor ?? situacao?.nome ?? situacao ?? '').toLowerCase();
  if (n === '1' || n.includes('aberto') || n.includes('pendente')) return true;
  if (n === '3' || n.includes('parcial')) return true;
  return false;
}

async function fetchContas(token, tipo) {
  // tipo: 'receber' | 'pagar'
  let all = [];
  try {
    for (let pg = 1; pg <= 3; pg++) {
      const { data } = await axios.get(`https://www.bling.com.br/Api/v3/contas/${tipo}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { limite: 100, pagina: pg },
      });
      const items = Array.isArray(data?.data) ? data.data : [];
      all = all.concat(items);
      if (items.length < 100) break;
    }
  } catch (e) {
    return { ok: false, total: 0, count: 0, vencidas: 0, vencidasValor: 0, itens: [], erro: e.response?.status || e.message };
  }
  const hoje = new Date().toISOString().split('T')[0];
  let total = 0, count = 0, vencidas = 0, vencidasValor = 0;
  const itens = [];
  for (const c of all) {
    if (!contaEmAberto(c.situacao)) continue;
    const valor = Number(c.valor || c.saldo || 0);
    const venc = String(c.vencimento || c.dataVencimento || '').substring(0, 10);
    total += valor; count++;
    const isVencida = venc && venc < hoje;
    if (isVencida) { vencidas++; vencidasValor += valor; }
    itens.push({
      id: c.id, valor, vencimento: venc, vencida: isVencida,
      contato: c.contato?.nome || c.historico || '—',
    });
  }
  itens.sort((a, b) => (a.vencimento || '9999').localeCompare(b.vencimento || '9999'));
  return { ok: true, total, count, vencidas, vencidasValor, itens: itens.slice(0, 30) };
}

app.get('/api/contas/:tipo', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });
  const tipo = req.params.tipo === 'pagar' ? 'pagar' : 'receber';
  const data = await fetchContas(token, tipo);
  res.json(data);
});

// ── Dashboard consolidado (primeira aba) ──────────────────────────────

app.get('/api/dashboard', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });

  const { inicio, fim, period } = resolvePeriodo(req.query.period, req.query.startDate, req.query.endDate);

  const categorize = s => categorizePedido(s);

  try {
    // Pedidos do período + período anterior + contas, em paralelo
    const prev = periodoAnterior(inicio, fim);
    const [pedRes, prevRes, receberRes, pagarRes] = await Promise.allSettled([
      fetchPedidos(token, inicio, fim, 2),
      fetchPedidos(token, prev.inicio, prev.fim, 1),
      fetchContas(token, 'receber'),
      fetchContas(token, 'pagar'),
    ]);

    if (pedRes.status === 'rejected') {
      if (pedRes.reason?.response?.status === 401) {
        res.clearCookie('bling_token');
        return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
      }
      throw pedRes.reason;
    }

    const allPedidos = pedRes.value || [];
    const valorOf = p => p.totalVenda || p.totalProdutos || 0;
    const concluidos = allPedidos.filter(p => categorize(p.situacao) === 'concluido');
    const pendentes  = allPedidos.filter(p => categorize(p.situacao) === 'pendente');
    const cancelados = allPedidos.filter(p => categorize(p.situacao) === 'cancelado');
    const sum = (arr) => arr.reduce((a, p) => a + valorOf(p), 0);

    const faturamento = sum(concluidos);
    const totalBruto  = sum(allPedidos);
    const aReceberPedidos = sum(pendentes);

    // Custos detalhados (frete, descontos) dos pedidos concluídos
    const freteTotal = concluidos.reduce((a, p) => a + (Number(p.transporte?.frete) || Number(p.transporte?.valorFrete) || 0), 0);
    const descontoTotal = concluidos.reduce((a, p) => a + (Number(p.desconto) || 0), 0);

    // Comparativo de faturamento com o período anterior
    const prevPedidos = prevRes.status === 'fulfilled' ? (prevRes.value || []) : [];
    const prevFat = prevPedidos.filter(p => categorize(p.situacao) === 'concluido').reduce((a, p) => a + valorOf(p), 0);
    const variacao = prevFat > 0 ? ((faturamento - prevFat) / prevFat) * 100 : null;

    // Série diária (vendas concluídas) p/ mini-gráfico
    const byDay = {};
    concluidos.forEach(p => {
      const day = String(p.data || p.dataPedido || '').substring(0, 10);
      if (day) byDay[day] = (byDay[day] || 0) + valorOf(p);
    });

    const receber = receberRes.status === 'fulfilled' ? receberRes.value : { ok: false, total: 0, count: 0, vencidas: 0 };
    const pagar   = pagarRes.status === 'fulfilled' ? pagarRes.value : { ok: false, total: 0, count: 0, vencidas: 0 };

    res.json({
      periodo: { inicio, fim, period },
      vendas: {
        faturamento, totalBruto, aReceberPedidos,
        totalPedidos: allPedidos.length,
        concluidos: concluidos.length,
        pendentes: pendentes.length,
        cancelados: cancelados.length,
        ticketMedio: concluidos.length ? faturamento / concluidos.length : 0,
        variacao,
        byDay,
        freteTotal,
        descontoTotal,
      },
      contasReceber: { total: receber.total, count: receber.count, vencidas: receber.vencidas, vencidasValor: receber.vencidasValor || 0, ok: receber.ok, itens: receber.itens || [] },
      contasPagar:   { total: pagar.total,   count: pagar.count,   vencidas: pagar.vencidas,   vencidasValor: pagar.vencidasValor || 0,   ok: pagar.ok,   itens: pagar.itens || [] },
    });
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, 500, 'Erro ao montar dashboard', err.message);
  }
});

// ── Clientes (CRM) ────────────────────────────────────────────────

app.get('/api/clientes', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });
  try {
    // Busca contatos (até 3 páginas) e pedidos dos últimos 90 dias para cruzar
    const hoje = new Date();
    const ini = new Date(hoje); ini.setDate(ini.getDate() - 90);
    const iso = d => d.toISOString().split('T')[0];

    const contatosPromise = (async () => {
      let all = [];
      for (let pg = 1; pg <= 3; pg++) {
        const { data } = await axios.get('https://www.bling.com.br/Api/v3/contatos', {
          headers: { Authorization: `Bearer ${token}` }, params: { limite: 100, pagina: pg },
        });
        const items = Array.isArray(data?.data) ? data.data : [];
        all = all.concat(items);
        if (items.length < 100) break;
      }
      return all;
    })();

    const [contatos, pedidos] = await Promise.all([
      contatosPromise,
      fetchPedidos(token, iso(ini), iso(hoje), 3).catch(() => []),
    ]);

    // Agrega gasto/pedidos por contato
    const agg = {};
    pedidos.forEach(p => {
      const key = p.contato?.id || p.contato?.nome;
      if (!key) return;
      if (!agg[key]) agg[key] = { gasto: 0, pedidos: 0, ultimo: '' };
      agg[key].gasto += valorPedido(p);
      agg[key].pedidos += 1;
      const d = String(p.data || '').substring(0, 10);
      if (d > agg[key].ultimo) agg[key].ultimo = d;
    });

    const clientes = contatos.map(c => {
      const a = agg[c.id] || agg[c.nome] || { gasto: 0, pedidos: 0, ultimo: '' };
      const end = c.endereco?.geral || c.endereco || {};
      return {
        id: c.id,
        nome: c.nome || 'Sem nome',
        documento: c.numeroDocumento || '',
        email: c.email || '',
        telefone: c.celular || c.telefone || c.fone || '',
        municipio: end.municipio || end.cidade || '',
        uf: end.uf || end.estado || '',
        tipo: c.tipo === 'J' ? 'PJ' : c.tipo === 'F' ? 'PF' : (c.tipo || ''),
        totalGasto: a.gasto,
        numPedidos: a.pedidos,
        ultimoPedido: a.ultimo,
      };
    });
    // Ordena por valor gasto (ranking)
    clientes.sort((x, y) => y.totalGasto - x.totalGasto);

    res.json({ total: clientes.length, clientes });
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    res.status(500).json({ error: 'Erro ao buscar clientes', detail: err.message });
  }
});

// ── Histórico ────────────────────────────────────────────────────

app.get('/api/historico', requireAuthJson, (req, res) => {
  res.json({ history: changeLog.slice().reverse().slice(0, 300) });
});

// ── Contas Customizadas (Despesas, Receitas, Controle de Caixa) ──────

app.get('/api/contas/custom', requireAuthJson, (req, res) => {
  const tipo = req.query.tipo; // 'pagar', 'receber', ou undefined para todas
  let filtered = customContas;
  if (tipo) filtered = filtered.filter(c => c.tipo === tipo);
  res.json({ contas: filtered });
});

app.post('/api/contas/custom', requireAuthJson, (req, res) => {
  const { tipo, descricao, valor, dataVencimento, categoria, observacao } = req.body;

  if (!tipo || !['pagar', 'receber'].includes(tipo)) {
    return sendErrorResponse(res, 400, 'Tipo inválido: use "pagar" ou "receber"');
  }
  if (!descricao || !valor) {
    return sendErrorResponse(res, 400, 'Descrição e valor são obrigatórios');
  }

  const id = contaIdCounter++;
  const conta = {
    id,
    tipo,
    descricao,
    valor: Number(valor),
    dataVencimento: dataVencimento || new Date().toISOString().split('T')[0],
    categoria: categoria || 'Outras',
    observacao: observacao || '',
    status: 'pendente',
    criada_em: new Date().toISOString(),
    atualizada_em: new Date().toISOString(),
  };

  customContas.push(conta);
  changeLog.push({
    id: changeLog.length + 1,
    produto_id: `conta_${id}`,
    produto_nome: descricao,
    campo: `conta ${tipo}`,
    valor_anterior: '—',
    valor_novo: `${tipo === 'pagar' ? '-' : '+'}R$ ${valor}`,
    timestamp: new Date().toISOString(),
  });

  res.json(conta);
});

app.put('/api/contas/custom/:id', requireAuthJson, (req, res) => {
  try {
    const id = Number(req.params.id);
    const conta = customContas.find(c => c.id === id);

    if (!conta) return res.status(404).json({ error: 'Conta não encontrada' });

    const { descricao, valor, dataVencimento, categoria, observacao, status } = req.body;

    if (descricao) conta.descricao = descricao;
    if (valor !== undefined) conta.valor = Number(valor);
    if (dataVencimento) conta.dataVencimento = dataVencimento;
    if (categoria) conta.categoria = categoria;
    if (observacao !== undefined) conta.observacao = observacao;
    if (status) conta.status = status;

    conta.atualizada_em = new Date().toISOString();

    changeLog.push({
      id: changeLog.length + 1,
      produto_id: `conta_${id}`,
      produto_nome: conta.descricao,
      campo: 'edição de conta',
      valor_anterior: '—',
      valor_novo: `status: ${status || conta.status}`,
      timestamp: new Date().toISOString(),
    });

    res.json(conta);
  } catch (err) {
    sendErrorResponse(res, 500, 'Erro ao atualizar conta', err.message);
  }
});

app.delete('/api/contas/custom/:id', requireAuthJson, (req, res) => {
  try {
    const id = Number(req.params.id);
    const idx = customContas.findIndex(c => c.id === id);

    if (idx === -1) return res.status(404).json({ error: 'Conta não encontrada' });

    const conta = customContas[idx];
    customContas.splice(idx, 1);

    changeLog.push({
      id: changeLog.length + 1,
      produto_id: `conta_${id}`,
      produto_nome: conta.descricao,
      campo: 'exclusão de conta',
      valor_anterior: conta.status,
      valor_novo: 'excluída',
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true });
  } catch (err) {
    sendErrorResponse(res, 500, 'Erro ao deletar conta', err.message);
  }
});

// ── Calendário (Eventos, Feriados, Datas Importantes) ──────────────────

app.get('/api/calendario', requireAuthJson, (req, res) => {
  const mes = req.query.mes; // filtrar por mês (YYYY-MM)
  let filtered = calendarEvents;
  if (mes) filtered = filtered.filter(e => e.data.startsWith(mes));
  res.json({ eventos: filtered });
});

app.post('/api/calendario', requireAuthJson, (req, res) => {
  const { tipo, titulo, descricao, data, contaId } = req.body;

  if (!tipo || !['feriado', 'comemorativo', 'vencimento', 'recebimento', 'evento'].includes(tipo)) {
    return sendErrorResponse(res, 400, 'Tipo de evento inválido');
  }
  if (!titulo || !data) {
    return sendErrorResponse(res, 400, 'Título e data são obrigatórios');
  }

  const id = eventIdCounter++;
  const evento = {
    id,
    tipo,
    titulo,
    descricao: descricao || '',
    data,
    contaId: contaId || null,
    criado_em: new Date().toISOString(),
  };

  calendarEvents.push(evento);
  res.json(evento);
});

app.delete('/api/calendario/:id', requireAuthJson, (req, res) => {
  try {
    const id = Number(req.params.id);
    const idx = calendarEvents.findIndex(e => e.id === id);

    if (idx === -1) return res.status(404).json({ error: 'Evento não encontrado' });

    calendarEvents.splice(idx, 1);
    res.json({ success: true });
  } catch (err) {
    sendErrorResponse(res, 500, 'Erro ao deletar evento', err.message);
  }
});

// ── Webhook (Bling notificações) ──────────────────────────────────────

app.post('/api/webhook/bling', async (req, res) => {
  res.json({ received: true }); // responde rápido (Bling espera 200)
  try {
    const admin = getAdmin();
    if (!admin) return;
    const evt = req.body || {};
    const tipo = String(evt.event || evt.tipo || evt.type || evt.data?.tipo || '').toLowerCase();
    let title, body;
    if (tipo.includes('order') || tipo.includes('pedido') || tipo.includes('venda')) {
      title = '🛒 Novo pedido!';
      body = 'Um novo pedido foi registrado no Bling. Toque para ver.';
    } else if (tipo.includes('nf') || tipo.includes('nota')) {
      const erro = tipo.includes('rejei') || tipo.includes('erro') || tipo.includes('deneg');
      title = erro ? '❌ Nota fiscal com erro' : '🧾 Nota fiscal atualizada';
      body = erro ? 'Uma NF-e foi rejeitada/denegada. Verifique no sistema.' : 'O status de uma NF-e mudou no Bling.';
    } else {
      return; // evento não mapeado — não notifica (evita spam)
    }
    await pushParaTodos(admin, { title, body, url: '/dashboard.html', tipo: 'evento' });
  } catch (e) { console.error('[webhook bling]', e.message); }
});

// ── Enhanced Order Sync (Real-time Status) ───────────────────────────

app.get('/api/pedidos/sync/status', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });

  try {
    const { data } = await axios.get('https://www.bling.com.br/Api/v3/pedidos/vendas', {
      headers: { Authorization: `Bearer ${token}` },
      params: { limite: 150, pagina: 1 },
    });
    const raw = Array.isArray(data?.data) ? data.data : [];

    const pedidos = raw.map(p => ({
      id:         p.id,
      numero:     p.numero,
      data:       p.data,
      valor:      Number(p.totalVenda || p.totalProdutos || 0),
      situacao:   situacaoPT(p.situacao?.nome || p.situacao?.valor || p.situacao),
      contato:    p.contato?.nome || '—',
      status:     p.situacao?.valor || p.situacao,
      frete:      Number(p.transporte?.frete || p.frete || 0),
      desconto:   Number(p.desconto || 0),
      observ:     p.observacoes || '',
      lastSync:   new Date().toISOString(),
    }));

    res.json({
      total: pedidos.length,
      pedidos,
      sincronizado: true,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, 500, 'Erro ao sincronizar pedidos', err.message);
  }
});

// ── Enhanced Invoice Sync ────────────────────────────────────────────

app.get('/api/notas-fiscais/sync/status', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });

  try {
    let all = [];
    for (let pg = 1; pg <= 3; pg++) {
      const { data } = await axios.get('https://www.bling.com.br/Api/v3/nfes', {
        headers: { Authorization: `Bearer ${token}` },
        params: { limite: 100, pagina: pg },
      });
      const items = Array.isArray(data?.data) ? data.data : [];
      all = all.concat(items);
      if (items.length < 100) break;
    }

    const notas = all.map(n => ({
      id:         n.id,
      numero:     n.numero,
      serie:      n.serie || '1',
      data:       n.dataEmissao || n.data,
      valor:      Number(n.totalNota || n.total || 0),
      situacao:   n.situacao?.nome || n.situacao || '—',
      contato:    n.destinatario?.nome || n.cliente?.nome || '—',
      chave:      n.chave || n.numeroNFe || '—',
      status:     n.situacao?.valor || n.situacao,
      lastSync:   new Date().toISOString(),
    }));

    res.json({
      total: notas.length,
      notas,
      sincronizado: true,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, 500, 'Erro ao sincronizar notas', err.message);
  }
});

// ── Financial Forecasting ────────────────────────────────────────────

app.get('/api/financeiro/previsao', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });

  try {
    const hoje = new Date();
    const proximoMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1);
    const fimProxMes = new Date(hoje.getFullYear(), hoje.getMonth() + 2, 0);

    const [recRes, pagRes] = await Promise.allSettled([
      fetchContas(token, 'receber'),
      fetchContas(token, 'pagar'),
    ]);

    const receber = recRes.status === 'fulfilled' ? recRes.value : { total: 0, vencidas: 0, vencidasValor: 0, count: 0 };
    const pagar = pagRes.status === 'fulfilled' ? pagRes.value : { total: 0, vencidas: 0, vencidasValor: 0, count: 0 };

    const fluxoLiquido = receber.total - pagar.total;

    res.json({
      proximos30dias: {
        aReceber: receber.total,
        aPagar: pagar.total,
        fluxoLiquido,
      },
      alertas: {
        recebedoresVencidas: receber.vencidas,
        recebedoresVencinValor: receber.vencidasValor,
        pagadoresVencidas: pagar.vencidas,
        pagadoresVencidoValor: pagar.vencidasValor,
      },
      recomendacoes: [
        receber.vencidas > 0 ? `⚠️ ${receber.vencidas} conta(s) a receber vencida(s)` : null,
        pagar.vencidas > 0 ? `⚠️ ${pagar.vencidas} conta(s) a pagar vencida(s)` : null,
        fluxoLiquido < 0 ? '⚠️ Fluxo de caixa negativo nos próximos 30 dias' : null,
      ].filter(Boolean),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    sendErrorResponse(res, 500, 'Erro ao prever financeiro', err.message);
  }
});

// ── Integrations Management ──────────────────────────────────────────

app.get('/api/integracoes/status', requireAuthJson, async (req, res) => {
  const blingToken = await ensureBlingToken(req, res);
  const ml = await ensureMLToken();
  const mlToken = ml?.token || null;

  res.json({
    bling: {
      conectado: !!blingToken,
      tipo: 'ERP',
      descricao: 'Integração com Bling ERP v3',
      status: blingToken ? 'ativo' : 'inativo',
      features: ['Pedidos', 'NFe', 'Estoque', 'Clientes'],
    },
    mercadoLivre: {
      conectado: !!mlToken,
      tipo: 'Marketplace',
      descricao: 'Integração com Mercado Livre',
      status: mlToken ? 'ativo' : 'inativo',
      features: ['Anúncios', 'Pedidos', 'Perguntas', 'Métricas'],
    },
    firebase: {
      conectado: !!process.env.FIREBASE_SERVICE_ACCOUNT,
      tipo: 'Notificações',
      descricao: 'Firebase Admin SDK',
      status: process.env.FIREBASE_SERVICE_ACCOUNT ? 'ativo' : 'inativo',
      features: ['Push Notifications', 'Histórico'],
    },
  });
});

// ── Enhanced Dashboard ───────────────────────────────────────────────

app.get('/api/dashboard/enhanced', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });

  const { inicio, fim, period } = resolvePeriodo(req.query.period, req.query.startDate, req.query.endDate);

  try {
    const prev = periodoAnterior(inicio, fim);

    const [pedRes, prevRes, receberRes, pagarRes, prodRes] = await Promise.allSettled([
      fetchPedidos(token, inicio, fim, 2),
      fetchPedidos(token, prev.inicio, prev.fim, 1),
      fetchContas(token, 'receber'),
      fetchContas(token, 'pagar'),
      fetchResumoProdutos(token, 1),
    ]);

    const allPedidos = pedRes.status === 'fulfilled' ? (pedRes.value || []) : [];
    const valorOf = p => p.totalVenda || p.totalProdutos || 0;
    const concluidos = allPedidos.filter(p => categorizePedido(p.situacao) === 'concluido');
    const pendentes = allPedidos.filter(p => categorizePedido(p.situacao) === 'pendente');
    const cancelados = allPedidos.filter(p => categorizePedido(p.situacao) === 'cancelado');

    const sum = arr => arr.reduce((a, p) => a + valorOf(p), 0);
    const faturamento = sum(concluidos);
    const margem = concluidos.reduce((a, p) => a + ((Number(p.totalProdutos) || 0) - (Number(p.totalCusto) || 0)), 0);

    const receber = receberRes.status === 'fulfilled' ? receberRes.value : { total: 0, count: 0, vencidas: 0 };
    const pagar = pagarRes.status === 'fulfilled' ? pagarRes.value : { total: 0, count: 0, vencidas: 0 };
    const produtos = prodRes.status === 'fulfilled' ? prodRes.value : { margem: 0, zerados: 0, criticos: 0 };

    const prevPedidos = prevRes.status === 'fulfilled' ? (prevRes.value || []) : [];
    const fatAnterior = prevPedidos.filter(p => categorizePedido(p.situacao) === 'concluido').reduce((a, p) => a + valorOf(p), 0);
    const variacao = fatAnterior > 0 ? ((faturamento - fatAnterior) / fatAnterior) * 100 : null;

    res.json({
      periodo: { inicio, fim, period },
      vendas: {
        total: sum(allPedidos),
        faturamento,
        pendente: sum(pendentes),
        cancelado: sum(cancelados),
        ticket_medio: concluidos.length > 0 ? faturamento / concluidos.length : 0,
        quantidade: allPedidos.length,
      },
      margens: {
        bruta: margem,
        percentual: faturamento > 0 ? (margem / faturamento) * 100 : 0,
        media: produtos.margem ? (produtos.margem * 100) : 0,
      },
      contas: {
        aReceber: { total: receber.total, quantidade: receber.count, vencidas: receber.vencidas },
        aPagar: { total: pagar.total, quantidade: pagar.count, vencidas: pagar.vencidas },
        fluxoLiquido: receber.total - pagar.total,
      },
      estoque: {
        zerados: produtos.zerados,
        criticos: produtos.criticos,
      },
      comparativo: {
        fatAnterior,
        variacao,
      },
      custom: {
        contasTotal: customContas.length,
        eventosAgendados: calendarEvents.length,
      },
    });
  } catch (err) {
    sendErrorResponse(res, 500, 'Erro ao buscar dashboard', err.message);
  }
});

// ── 404 ──────────────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// ── Error Handler ────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err);
  sendErrorResponse(res, 500, 'Erro interno do servidor', NODE_ENV === 'development' ? err.message : undefined);
});

// ── Start ─────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => {
    console.log(`✅ Servidor iniciado em http://localhost:${process.env.PORT || 3000}`);
    console.log(`📝 Ambiente: ${NODE_ENV}`);
  });
}

module.exports = app;
