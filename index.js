require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeBlingOrder, orderDiscount } = require('./lib/bling-order');
const { aggregateSalesFacts, buildSalesFact, normalizeSku } = require('./lib/sales-ledger');

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
let _fbAdminProjectId = null; // exposto em /api/diagnostico p/ conferir se bate com o projeto do login.html
let _fbAdminInitError = null;
function getAdmin() {
  if (_fbAdmin) return _fbAdmin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const { cert, getApp, getApps, initializeApp } = require('firebase-admin/app');
    const { FieldValue, GeoPoint, Timestamp, getFirestore } = require('firebase-admin/firestore');
    const { getAuth } = require('firebase-admin/auth');
    const { getMessaging } = require('firebase-admin/messaging');
    const cred = JSON.parse(raw);
    const firebaseApp = getApps().length ? getApp() : initializeApp({ credential: cert(cred) });
    _fbAdminProjectId = cred.project_id || null;
    // Erro "5 NOT_FOUND" no ping = o banco "(default)" não existe no projeto.
    // Acontece quando o banco foi criado com ID personalizado no console.
    // FIRESTORE_DB_ID permite apontar para esse banco nomeado sem recriar:
    // redirecionamos admin.firestore() para o banco certo, preservando
    // FieldValue/Timestamp usados no resto do código.
    const dbId = process.env.FIRESTORE_DB_ID;
    const db = dbId && dbId !== '(default)'
      ? getFirestore(firebaseApp, dbId)
      : getFirestore(firebaseApp);
    const firestore = () => db;
    firestore.FieldValue = FieldValue;
    firestore.Timestamp = Timestamp;
    firestore.GeoPoint = GeoPoint;
    const admin = {
      app: () => firebaseApp,
      firestore,
      auth: () => getAuth(firebaseApp),
      messaging: () => getMessaging(firebaseApp),
    };
    if (dbId && dbId !== '(default)') console.log(`[Firestore] usando banco nomeado "${dbId}" (FIRESTORE_DB_ID)`);
    _fbAdmin = admin;
  } catch (e) {
    _fbAdminInitError = e.message;
    console.error('⚠️  Firebase Admin init error:', e.message);
  }
  return _fbAdmin;
}

const app = express();
// Confia no 1º proxy da cadeia (Vercel/Render) para req.ip refletir o IP real do cliente
app.set('trust proxy', 1);
const DATA_DIR = path.join(__dirname, 'data');
const AUDIT_LOG_PATH = path.join(DATA_DIR, 'audit-log.jsonl');
const IS_VERCEL = Boolean(process.env.VERCEL);
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map();

// O filesystem do bundle publicado na Vercel é somente leitura. Nesse
// ambiente, a auditoria continua disponível em memória durante a execução;
// a persistência em arquivo fica restrita aos servidores com disco gravável.
if (!IS_VERCEL) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Cabeçalhos de segurança. A app é same-origin (frontend e API no mesmo
// domínio), então não há CORS aberto — a API deixa de ser invocável por
// qualquer site de terceiros com Access-Control-Allow-Origin: *.
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  if (NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

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
function loadAuditLog() {
  if (IS_VERCEL) return [];
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return [];
    return fs.readFileSync(AUDIT_LOG_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .slice(-1000);
  } catch (error) {
    console.error('[audit:load]', error.message);
    return [];
  }
}

let changeLog = loadAuditLog();
const pushAuditEntry = Array.prototype.push.bind(changeLog);

// Contas customizadas e eventos de calendário: cache em memória com
// persistência no Firestore (quando FIREBASE_SERVICE_ACCOUNT configurado).
// Sem Firestore, funcionam em memória e se perdem no restart — comportamento
// anterior preservado como fallback.
let customContas = [];
let contaIdCounter = 1;
let calendarEvents = [];
let eventIdCounter = 1;
let _persistLoaded = false;
// Identidade visual do sistema (nome + ícone) — editável em Configurações,
// refletida na aba do Chrome, no app instalável, no login e no menu lateral.
let appConfig = { nome: 'Estoque Max', iniciais: 'EM', cor: '#4f46e5' };

async function loadPersistedData() {
  if (_persistLoaded) return;
  _persistLoaded = true;
  const admin = getAdmin();
  if (!admin) return;
  try {
    const doc = await admin.firestore().collection('app_state').doc('data').get();
    const d = doc.exists ? (doc.data() || {}) : {};
    if (Array.isArray(d.customContas)) customContas = d.customContas;
    if (Array.isArray(d.calendarEvents)) calendarEvents = d.calendarEvents;
    if (Array.isArray(d.changeLog)) changeLog = d.changeLog;
    if (d.appConfig && typeof d.appConfig === 'object') appConfig = { ...appConfig, ...d.appConfig };
    try {
      const accountsSnap = await admin.firestore().collection('finance_accounts').get();
      if (!accountsSnap.empty) customContas = accountsSnap.docs.map(account => ({ ...account.data(), id: Number(account.id) || account.data().id }));
    } catch (e) { console.error('[finance_accounts load]', e.message); }
    contaIdCounter = customContas.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0) + 1;
    eventIdCounter = calendarEvents.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0) + 1;
    console.log(`[Persistência] ${customContas.length} conta(s), ${calendarEvents.length} evento(s) e ${changeLog.length} log(s) restaurados do Firestore`);
  } catch (e) {
    console.error('[loadPersistedData]', e.message);
  }
}

// Grava o estado em memória no Firestore, com debounce para agrupar
// mutações consecutivas. Sem Firestore configurado é um no-op seguro
// (mantém o comportamento apenas-memória).
let _saveTimer = null;
function saveInMemoryData() {
  const admin = getAdmin();
  if (!admin) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    admin.firestore().collection('app_state').doc('data').set({
      customContas,
      calendarEvents,
      changeLog: changeLog.slice(-500),
      appConfig,
      updatedAt: new Date().toISOString(),
    }).catch(e => console.error('[saveInMemoryData]', e.message));
  }, 1500);
}

function manifestIconSvg(size, iniciais, cor) {
  const fontSize = Math.round(size * 0.47);
  const y = Math.round(size * 0.68);
  const rx = Math.round(size * 0.2);
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${size} ${size}'><rect width='${size}' height='${size}' rx='${rx}' fill='${cor}'/><text x='${size / 2}' y='${y}' text-anchor='middle' font-size='${fontSize}' font-weight='700' fill='white' font-family='Inter,sans-serif'>${iniciais}</text></svg>`)}`;
}

// Config pública (sem autenticação) — o login precisa da identidade visual
// antes de haver sessão.
app.get('/api/config', async (req, res) => {
  await loadPersistedData();
  const admin = getAdmin();
  let temIcone = false, temLogo = false;
  if (admin) {
    try {
      const [iconeDoc, logoDoc] = await Promise.all([
        admin.firestore().collection('app_assets').doc('icone').get(),
        admin.firestore().collection('app_assets').doc('logo').get(),
      ]);
      temIcone = iconeDoc.exists;
      temLogo = logoDoc.exists;
    } catch (e) { console.error('[api/config assets]', e.message); }
  }
  res.json({ ...appConfig, temIcone, temLogo });
});

app.put('/api/config', requireAuthJson, async (req, res) => {
  await loadPersistedData();
  const { nome, iniciais, cor } = req.body || {};
  if (nome !== undefined) {
    const n = String(nome).trim().slice(0, 40);
    if (!n) return sendErrorResponse(res, 400, 'Nome não pode ser vazio');
    appConfig.nome = n;
  }
  if (iniciais !== undefined) {
    const i = String(iniciais).trim().toUpperCase().slice(0, 3);
    if (!i) return sendErrorResponse(res, 400, 'Iniciais não podem ser vazias');
    appConfig.iniciais = i;
  }
  if (cor !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(cor)) return sendErrorResponse(res, 400, 'Cor inválida (use #RRGGBB)');
    appConfig.cor = cor;
  }
  saveInMemoryData();
  res.json(appConfig);
});

// Ícone (favicon/app instalável) e logo (marca exibida no menu lateral e no
// login) são imagens SEPARADAS, cada uma enviada por upload e persistida no
// Firestore — mesmo padrão já usado para imagem de produto (produto_imagens).
function saveAssetImage(collection, docId) {
  return async (req, res) => {
    const admin = getAdmin();
    if (!admin) return res.status(503).json({ error: 'Armazenamento indisponível (FIREBASE_SERVICE_ACCOUNT ausente)' });
    try {
      const m = String(req.body?.dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/);
      if (!m) return res.status(400).json({ error: 'Envie um dataURL de imagem JPG, PNG, WEBP ou SVG' });
      const [, mime, b64] = m;
      if (b64.length > 950_000) return res.status(413).json({ error: 'Imagem grande demais mesmo após compressão (máx ~700KB)' });
      await admin.firestore().collection(collection).doc(docId).set({
        data: b64, mime, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.json({ ok: true, url: `/img/${docId}?v=${Date.now()}` });
    } catch (err) {
      sendErrorResponse(res, 500, 'Erro ao salvar imagem', err.message);
    }
  };
}
function deleteAssetImage(collection, docId) {
  return async (req, res) => {
    const admin = getAdmin();
    if (!admin) return res.status(503).json({ error: 'Armazenamento indisponível (FIREBASE_SERVICE_ACCOUNT ausente)' });
    try {
      await admin.firestore().collection(collection).doc(docId).delete();
      res.json({ ok: true });
    } catch (err) {
      sendErrorResponse(res, 500, 'Erro ao remover imagem', err.message);
    }
  };
}
app.post('/api/config/icone', requireAuthJson, saveAssetImage('app_assets', 'icone'));
app.delete('/api/config/icone', requireAuthJson, deleteAssetImage('app_assets', 'icone'));
app.post('/api/config/logo', requireAuthJson, saveAssetImage('app_assets', 'logo'));
app.delete('/api/config/logo', requireAuthJson, deleteAssetImage('app_assets', 'logo'));

// Públicas de propósito: favicon/manifest e a tag <img> do login (sem
// sessão) precisam carregar essas imagens sem cookie.
app.get('/img/:asset', async (req, res) => {
  if (req.params.asset !== 'icone' && req.params.asset !== 'logo') return res.status(404).end();
  const admin = getAdmin();
  if (!admin) return res.status(404).end();
  try {
    const doc = await admin.firestore().collection('app_assets').doc(req.params.asset).get();
    if (!doc.exists) return res.status(404).end();
    const { data, mime } = doc.data();
    res.set('Content-Type', mime || 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(data, 'base64'));
  } catch { res.status(500).end(); }
});

app.get('/manifest.json', async (req, res) => {
  await loadPersistedData();
  const { nome, iniciais, cor } = appConfig;
  const admin = getAdmin();
  let temIcone = false;
  if (admin) {
    try { temIcone = (await admin.firestore().collection('app_assets').doc('icone').get()).exists; } catch {}
  }
  const icons = temIcone
    ? [
        { src: `/img/icone?v=${Date.now()}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `/img/icone?v=${Date.now()}`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ]
    : [
        { src: manifestIconSvg(192, iniciais, cor), sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
        { src: manifestIconSvg(512, iniciais, cor), sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
      ];
  res.json({
    name: nome,
    short_name: nome.length > 12 ? iniciais : nome,
    description: 'Gestão de estoque e produtos integrado ao Bling ERP',
    start_url: '/dashboard.html',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui', 'browser'],
    background_color: '#0f172a',
    theme_color: cor,
    orientation: 'portrait-primary',
    categories: ['business', 'productivity'],
    lang: 'pt-BR',
    icons,
    shortcuts: [
      { name: 'Produtos', short_name: 'Produtos', description: 'Ver e gerenciar produtos', url: '/dashboard.html#produtos', icons: [{ src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='18' fill='%234f46e5'/><rect x='18' y='32' width='60' height='42' rx='6' stroke='white' stroke-width='5' fill='none'/><path d='M36 32V26a12 12 0 0 1 24 0v6' stroke='white' stroke-width='5' fill='none' stroke-linecap='round'/></svg>", sizes: '96x96' }] },
      { name: 'Pedidos', short_name: 'Pedidos', description: 'Ver pedidos pendentes', url: '/dashboard.html#pedidos', icons: [{ src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='18' fill='%2310b981'/><path d='M24 48l16 16L72 28' stroke='white' stroke-width='6' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>", sizes: '96x96' }] },
      { name: 'Financeiro', short_name: 'Financeiro', description: 'Painel financeiro', url: '/dashboard.html#financeiro', icons: [{ src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='18' fill='%23f59e0b'/><text x='48' y='64' text-anchor='middle' font-size='54' font-weight='700' fill='white' font-family='sans-serif'>$</text></svg>", sizes: '96x96' }] },
    ],
  });
});

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

function getRequestActor(req) {
  try {
    const payload = jwt.verify(req.cookies?.system_token || '', JWT_SECRET);
    return payload?.email || 'sistema';
  } catch {
    return 'sistema';
  }
}

async function recordAudit(entry) {
  const item = {
    id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  pushAuditEntry(item);
  if (changeLog.length > 1000) changeLog.shift();
  if (!IS_VERCEL) {
    try {
      await fs.promises.appendFile(AUDIT_LOG_PATH, `${JSON.stringify(item)}\n`, 'utf8');
    } catch (error) {
      console.error('[audit:append]', error.message);
    }
  }
  return item;
}

changeLog.push = (...entries) => {
  entries.forEach(entry => {
    recordAudit(entry).catch(error => console.error('[audit:proxy]', error.message));
  });
  return changeLog.length;
};

function pruneLoginAttempts() {
  const now = Date.now();
  for (const [key, value] of loginAttempts.entries()) {
    if (value.resetAt <= now) loginAttempts.delete(key);
  }
}

function loginAttemptKey(req, email = '') {
  return `${req.ip || 'unknown'}::${String(email).trim().toLowerCase()}`;
}

function ensureCsrfCookie(req, res) {
  const existing = req.cookies?.csrf_token;
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('hex');
  res.cookie('csrf_token', token, {
    secure: NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 3600 * 1000,
  });
  return token;
}

function requireCsrf(req, res, next) {
  const cookieToken = req.cookies?.csrf_token;
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    return res.status(403).json({ error: 'CSRF token inválido' });
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
  try {
    jwt.verify(req.cookies?.system_token || '', JWT_SECRET);
    ensureCsrfCookie(req, res);
    next();
  } catch {
    res.clearCookie('system_token');
    res.clearCookie('csrf_token');
    res.redirect('/login');
  }
}

function requireAuthJson(req, res, next) {
  try {
    jwt.verify(req.cookies?.system_token || '', JWT_SECRET);
    ensureCsrfCookie(req, res);
    next();
  } catch {
    res.clearCookie('system_token');
    res.clearCookie('csrf_token');
    res.status(401).json({ error: 'Não autenticado' });
  }
}

function blingHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Axios config with timeout to prevent hanging requests
const AXIOS_TIMEOUT = 15000; // 15 segundos
axios.defaults.timeout = AXIOS_TIMEOUT;

// ── Proteção contra rate-limit do Bling (≈3 req/s) ───────────────────
// O painel dispara várias chamadas em paralelo; sem espaçamento, o Bling
// devolve 429 e a UI mostra "Erro ao buscar produtos/montar dashboard".
// 1) Espaça as requisições ao Bling em ~350ms dentro da instância.
let _blingNextSlot = 0;
axios.interceptors.request.use(async (cfg) => {
  if (String(cfg.url || '').includes('bling.com.br/Api')) {
    const now = Date.now();
    const wait = Math.max(0, _blingNextSlot - now);
    _blingNextSlot = Math.max(now, _blingNextSlot) + 350;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  return cfg;
});
// 2) Reenvia automaticamente (backoff exponencial) quando ainda assim vier
// 429/503 ou timeout — o usuário não deve ver erro por limite momentâneo.
axios.interceptors.response.use(undefined, async (error) => {
  const cfg = error.config;
  const url = String(cfg?.url || '');
  const st = error.response?.status;
  // Token do Bling rejeitado: invalida o access em cache/Firestore na hora,
  // senão o token morto continuaria sendo servido até a validade "teórica".
  if (st === 401 && url.includes('bling.com.br/Api') && !url.includes('/oauth/')) {
    invalidateBlingAccess();
  }
  const retriable = st === 429 || st === 503 || error.code === 'ECONNABORTED';
  const isApiExterna = url.includes('bling.com.br') || url.includes('mercadolibre.com');
  if (!cfg || !retriable || !isApiExterna) throw error;
  cfg._retry = (cfg._retry || 0) + 1;
  if (cfg._retry > 3) throw error;
  await new Promise(r => setTimeout(r, 500 * Math.pow(2, cfg._retry - 1) + Math.random() * 300));
  return axios(cfg);
});

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
  }
  // Persiste o par completo no Firestore (fire-and-forget) — na Vercel cada
  // requisição pode cair numa instância nova, então cookie sozinho não basta.
  saveBlingTokens(data);
}

// Guarda access + refresh do Bling no Firestore. O refresh_token do Bling é
// DE USO ÚNICO: guardar também o access com a validade evita renovar à toa
// (cada renovação desnecessária é uma chance de corrida que derruba a conexão).
async function saveBlingTokens(data) {
  const admin = getAdmin();
  if (!admin || !data?.refresh_token) return;
  try {
    await admin.firestore().collection('bling_auth').doc('tokens').set({
      refreshToken: data.refresh_token,
      accessToken: data.access_token || null,
      accessExpiresAt: Date.now() + ((data.expires_in || 21600) - 120) * 1000,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.error('[saveBlingTokens]', e.message); }
}

async function refreshBlingToken(refreshToken) {
  const creds = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const { data } = await axios.post('https://www.bling.com.br/Api/v3/oauth/token', body.toString(), {
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return data;
}

// Cache em memória + trava de renovação única: várias chamadas simultâneas
// (o painel dispara produtos+pedidos+financeiro juntos) compartilham UMA
// renovação em vez de queimar o mesmo refresh_token em corrida.
let _blingCache = { token: null, expiresAt: 0 };
let _blingRefreshing = null;

// Descarta o access token atual (memória + Firestore) sem tocar no refresh —
// a próxima chamada renova. Usado quando o Bling responde 401 ao access.
function invalidateBlingAccess() {
  _blingCache = { token: null, expiresAt: 0 };
  const admin = getAdmin();
  if (!admin) return;
  admin.firestore().collection('bling_auth').doc('tokens')
    .set({ accessExpiresAt: 0 }, { merge: true })
    .catch(e => console.error('[invalidateBlingAccess]', e.message));
}

async function _blingRefreshShared(refreshToken) {
  if (!_blingRefreshing) {
    _blingRefreshing = (async () => {
      try {
        const data = await refreshBlingToken(refreshToken);
        _blingCache = { token: data.access_token, expiresAt: Date.now() + ((data.expires_in || 21600) - 120) * 1000 };
        await saveBlingTokens(data);
        return data;
      } finally { _blingRefreshing = null; }
    })();
  }
  return _blingRefreshing;
}

// Retorna um access_token válido, tentando nesta ordem:
// cookie → cache da instância → access salvo no Firestore → renovação via
// refresh_token (única por vez). Só desconecta de verdade se o Bling
// REJEITAR o refresh (400/401) — erro de rede/limite não derruba a sessão.
async function ensureBlingToken(req, res) {
  const cookieTok = req?.cookies?.bling_token;
  if (cookieTok) return cookieTok;
  if (_blingCache.token && Date.now() < _blingCache.expiresAt) return _blingCache.token;

  const admin = getAdmin();
  let stored = null;
  if (admin) {
    try {
      const doc = await admin.firestore().collection('bling_auth').doc('tokens').get();
      stored = doc.exists ? doc.data() : null;
    } catch (e) { console.error('[ensureBlingToken] Firestore:', e.message); }
  }

  if (stored?.accessToken && stored.accessExpiresAt && Date.now() < stored.accessExpiresAt) {
    _blingCache = { token: stored.accessToken, expiresAt: stored.accessExpiresAt };
    if (res) res.cookie('bling_token', stored.accessToken, { ...BLING_COOKIE_OPTS, maxAge: Math.max(60000, stored.accessExpiresAt - Date.now()) });
    return stored.accessToken;
  }

  const cookieRefresh = req?.cookies?.bling_refresh;
  const candidates = [...new Set([stored?.refreshToken, cookieRefresh].filter(Boolean))];
  if (!candidates.length) return null;

  for (const refresh of candidates) {
    try {
      const data = await _blingRefreshShared(refresh);
      if (res) setBlingCookies(res, data);
      return data.access_token;
    } catch (e) {
      const st = e.response?.status;
      console.error('[Bling refresh]', st || '', e.response?.data || e.message);
      // 400/401 = refresh inválido → tenta o próximo candidato; outros erros
      // (rede, 429, 5xx) são transitórios: não desconecta, só falha a chamada.
      if (st !== 400 && st !== 401) return null;
    }
  }
  // Todos os refresh tokens foram rejeitados: sessão realmente acabou.
  if (res) res.clearCookie('bling_refresh');
  return null;
}

// Gera um access_token válido a partir do estado salvo (usado pelos crons)
async function getCronBlingToken() {
  return ensureBlingToken(null, null);
}

// ── Error Response Helper ────────────────────────────────────────────
function sendErrorResponse(res, statusCode, errorMessage, detail = null) {
  const response = { error: errorMessage };

  // Este painel é autenticado e de um único usuário (o dono da conta) — sempre
  // inclui o motivo real (ex.: erro devolvido pelo Bling), não só em dev.
  // Sem isso, uma edição rejeitada pelo Bling aparecia como "erro genérico"
  // sem pista nenhuma de qual foi o problema real.
  if (detail) {
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
// IDs padrão de situação de pedido de venda no Bling (o endpoint de listagem
// costuma mandar só { id, valor } — sem esse mapa a UI mostrava "1"/"2" ou
// até "[object Object]" na coluna de status).
const _BLING_SIT_ID = {
  6: 'Em aberto', 9: 'Atendido', 12: 'Cancelado', 15: 'Em andamento',
  18: 'Venda agenciada', 21: 'Em digitação', 24: 'Verificado',
};
function situacaoPT(s) {
  if (s && typeof s === 'object') {
    s = s.nome
      || _BLING_SIT_ID[s.id]
      || (typeof s.valor === 'string' ? s.valor : _BLING_SIT_ID[s.valor])
      || s.descricao || null;
  }
  if (typeof s === 'number') s = _BLING_SIT_ID[s] || s;
  const raw = String(s || '—');
  return _SIT_PT_MAP[raw.toLowerCase().replace(/\s+/g,'_')] || raw;
}

// Situação de NF-e no Bling v3 vem como NÚMERO — este é o mapa oficial.
// Sem ele a UI mostrava o número cru (ou "[object Object]").
const _BLING_NFE_SIT = {
  1: 'Pendente', 2: 'Cancelada', 3: 'Aguardando recibo', 4: 'Rejeitada',
  5: 'Autorizada', 6: 'Emitida DANFE', 7: 'Registrada', 8: 'Aguardando protocolo',
  9: 'Denegada', 10: 'Consultando situação', 11: 'Bloqueada',
};
function nfeSituacaoPT(s) {
  if (s && typeof s === 'object') s = s.nome ?? s.valor ?? s.id;
  if (typeof s === 'number' || /^\d+$/.test(String(s ?? ''))) {
    return _BLING_NFE_SIT[Number(s)] || `Situação ${s}`;
  }
  return String(s || '—');
}

// Datas SEMPRE no fuso do negócio (Brasil), nunca em UTC do servidor.
// Servidores da Vercel rodam em UTC: às 21h de Brasília, toISOString() já
// devolve o dia SEGUINTE — o filtro "Hoje" passava a buscar pedidos de
// amanhã e o faturamento do dia "zerava" à noite.
const APP_TZ = process.env.APP_TZ || 'America/Sao_Paulo';
const _isoTZ = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function isoLocal(d = new Date()) { return _isoTZ.format(d); } // YYYY-MM-DD no fuso local
function isoLocalDiasAtras(dias) { return isoLocal(new Date(Date.now() - dias * 86400000)); }

// Resolve intervalo de datas a partir do período (today | 7d | 30d | custom)
function resolvePeriodo(period, startDate, endDate) {
  const hoje = isoLocal();
  let inicio, fim;
  if (period === 'today') {
    inicio = fim = hoje;
  } else if (period === 'yesterday') {
    inicio = fim = isoLocalDiasAtras(1);
  } else if (period === '7d') {
    inicio = isoLocalDiasAtras(6); fim = hoje;
  } else if (period === '90d') {
    inicio = isoLocalDiasAtras(89); fim = hoje;
  } else if (period === 'year') {
    inicio = `${hoje.slice(0, 4)}-01-01`; fim = hoje;
  } else if (period === 'custom' && startDate && endDate) {
    inicio = startDate; fim = endDate;
  } else {
    inicio = isoLocalDiasAtras(29); fim = hoje;
    period = '30d';
  }
  return { inicio, fim, period: period || '30d' };
}

// ── Páginas ──────────────────────────────────────────────────────────

// Identifica exatamente qual deploy está no ar (Vercel/Render expõem o SHA
// do commit em variáveis próprias). Aparece no rodapé do painel e em /health
// — serve para confirmar se uma atualização realmente chegou ao servidor,
// em vez de adivinhar por cache do navegador/CDN.
const BUILD_SHA = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.RENDER_GIT_COMMIT || 'dev').slice(0, 7);
const BUILD_TIME = new Date().toISOString();

// HTML nunca deve ficar em cache — sem isso, navegador e CDN podem seguir
// servindo uma versão antiga do painel mesmo depois de um novo deploy.
function noCache(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
}

app.get('/login', (req, res) => { noCache(res); ensureCsrfCookie(req, res); res.sendFile(__dirname + '/public/login.html'); });
app.get('/', requireAuth, (req, res) => { noCache(res); res.sendFile(__dirname + '/public/index.html'); });
app.get('/index.html', requireAuth, (req, res) => { noCache(res); res.sendFile(__dirname + '/public/index.html'); });
app.get('/dashboard.html', requireAuth, (req, res) => { noCache(res); res.sendFile(__dirname + '/public/dashboard.html'); });
app.get('/health', (req, res) => res.json({ status: 'OK', history: changeLog.length, environment: NODE_ENV, build: BUILD_SHA, buildTime: BUILD_TIME }));

// Diagnóstico ao vivo: mostra o que o servidor REALMENTE tem configurado
// agora, sem expor segredos — só para descobrir na hora onde uma
// integração está travando (env var ausente, redirect_uri errado, etc).
app.get('/api/diagnostico', requireAuthJson, async (req, res) => {
  let blingConectado = false, mlConectado = false, firestoreOk = false;
  try { blingConectado = !!(await ensureBlingToken(req, res)); } catch {}
  try { mlConectado = !!(await ensureMLToken())?.token; } catch {}
  const admin = getAdmin();
  let firestoreErro = null;
  if (admin) {
    try { await admin.firestore().collection('_diag').doc('ping').set({ t: Date.now() }); firestoreOk = true; }
    catch (e) { firestoreOk = false; firestoreErro = e.message; }
  }
  res.json({
    build: BUILD_SHA,
    buildTime: BUILD_TIME,
    ambiente: NODE_ENV,
    host: req.get('host'),
    bling: {
      clientIdConfigurado: !!BLING_CLIENT_ID,
      redirectUriConfigurada: BLING_REDIRECT_URI || null,
      urlEsperadaPeloRequest: `${req.protocol}://${req.get('host')}/api/auth/callback`,
      conectado: blingConectado,
    },
    mercadoLivre: {
      clientIdConfigurado: !!ML_CLIENT_ID,
      redirectUriConfigurada: ML_REDIRECT_URI || null,
      urlEsperadaPeloRequest: `${req.protocol}://${req.get('host')}/api/ml/callback`,
      conectado: mlConectado,
    },
    firebase: {
      configurado: !!admin,
      firestoreRespondendo: firestoreOk,
      bancoDeDados: process.env.FIRESTORE_DB_ID || '(default)',
      // Sem Firestore NADA persiste entre requisições na Vercel: tokens do
      // Bling/ML somem, notificações e estado do app não salvam. O erro cru
      // aqui aponta a causa (API desabilitada, permissão, projeto errado).
      firestoreErro,
      // Precisa ser exatamente "erp-max-sistema" (mesmo projeto do
      // firebase.initializeApp em login.html) — se o FIREBASE_SERVICE_ACCOUNT
      // configurado no servidor for de outro projeto Firebase, o login com
      // Google falha sempre com "Token do Firebase inválido ou expirado",
      // mesmo com tudo aparentemente certo.
      projetoConfigurado: _fbAdminProjectId,
      projetoEsperado: 'erp-max-sistema',
      projetoBate: admin ? (_fbAdminProjectId === 'erp-max-sistema') : null,
      erroInicializacao: _fbAdminInitError,
    },
    adminEmailConfigurado: !!ADMIN_EMAIL,
    jwtSecretConfigurado: !!JWT_SECRET,
  });
});

// Arquivos estáticos (fontes, imagens) — vem DEPOIS das rotas de página
// para que /index.html e /dashboard.html passem pela autenticação acima
app.use(express.static('public', { index: false, maxAge: NODE_ENV === 'production' ? '1d' : 0 }));

app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path === '/webhook/bling') return next();
  return requireCsrf(req, res, next);
});

// ── Login ────────────────────────────────────────────────────────────

app.post('/api/auth/login', loginRateLimit, requireCsrf, async (req, res) => {
  const { email, password } = req.body || {};
  pruneLoginAttempts();
  const attemptKey = loginAttemptKey(req, email);
  const currentAttempt = loginAttempts.get(attemptKey);
  if (currentAttempt && currentAttempt.count >= LOGIN_MAX_ATTEMPTS && currentAttempt.resetAt > Date.now()) {
    const retryAfterSec = Math.ceil((currentAttempt.resetAt - Date.now()) / 1000);
    res.set('Retry-After', String(retryAfterSec));
    return sendErrorResponse(res, 429, 'Muitas tentativas de login. Tente novamente em alguns minutos.');
  }
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
    const nextCount = (currentAttempt?.count || 0) + 1;
    loginAttempts.set(attemptKey, {
      count: nextCount,
      resetAt: currentAttempt?.resetAt && currentAttempt.resetAt > Date.now()
        ? currentAttempt.resetAt
        : Date.now() + LOGIN_WINDOW_MS,
    });
    await recordAudit({
      type: 'auth.login_failed',
      actor: String(email).trim().toLowerCase() || 'desconhecido',
      ip: req.ip,
      source: 'login',
      detail: `tentativa ${nextCount}/${LOGIN_MAX_ATTEMPTS}`,
    });
    return sendErrorResponse(res, 401, 'Email ou senha incorretos');
  }

  try {
    clearLoginFailures(req);
    loginAttempts.delete(attemptKey);
    const token = jwt.sign({ email: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('system_token', token, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 3600 * 1000,
    });
    ensureCsrfCookie(req, res);
    await recordAudit({
      type: 'auth.login_success',
      actor: ADMIN_EMAIL,
      ip: req.ip,
      source: 'login',
    });
    res.json({ success: true });
  } catch (e) {
    sendErrorResponse(res, 500, 'Erro ao gerar token. Verifique JWT_SECRET nas variáveis de ambiente.', e.message);
  }
});

// Reconfirma a senha (para liberar áreas/ações sensíveis, estilo Shopee)
app.post('/api/auth/verify', requireAuthJson, requireCsrf, async (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'Senha não configurada no servidor.' });
  if (safeEqual(password, ADMIN_PASSWORD)) {
    await recordAudit({ type: 'auth.password_verify_success', actor: getRequestActor(req), ip: req.ip, source: 'verify' });
    return res.json({ ok: true });
  }
  await recordAudit({ type: 'auth.password_verify_failed', actor: getRequestActor(req), ip: req.ip, source: 'verify' });
  return res.status(401).json({ error: 'Senha incorreta.' });
});

app.post('/api/auth/logout', requireAuthJson, requireCsrf, async (req, res) => {
  res.clearCookie('system_token');
  res.clearCookie('bling_token');
  res.clearCookie('bling_refresh');
  res.clearCookie('csrf_token');
  await recordAudit({ type: 'auth.logout', actor: getRequestActor(req), ip: req.ip, source: 'logout' });
  res.json({ ok: true });
});

// ── OAuth Bling ──────────────────────────────────────────────────────

app.get('/api/auth/url', requireAuthJson, (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  res.cookie('bling_oauth_state', state, {
    httpOnly: true,
    secure: NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
  });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: BLING_CLIENT_ID,
    redirect_uri: BLING_REDIRECT_URI,
    state,
  });
  res.json({ authUrl: `https://www.bling.com.br/Api/v3/oauth/authorize?${params}` });
});

app.get('/api/auth/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
  if (!code) return res.redirect('/?error=no_code');
  if (!state || !req.cookies?.bling_oauth_state || !safeEqual(state, req.cookies.bling_oauth_state)) {
    return res.redirect('/?error=invalid_request');
  }

  try {
    const creds = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
    const body  = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: BLING_REDIRECT_URI });

    const { data } = await axios.post('https://www.bling.com.br/Api/v3/oauth/token', body.toString(), {
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    setBlingCookies(res, data);
    res.clearCookie('bling_oauth_state');
    await recordAudit({ type: 'oauth.bling_connected', actor: getRequestActor(req), ip: req.ip, source: 'oauth' });

    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('[OAuth]', err.response?.data || err.message);
    res.redirect('/?error=token_exchange_failed');
  }
});

// Firebase Authentication endpoint
app.post('/api/auth/firebase', loginRateLimit, async (req, res) => {
  const { idToken } = req.body || {};

  if (!idToken) {
    return sendErrorResponse(res, 400, 'ID token é obrigatório');
  }

  if (!ADMIN_EMAIL || !JWT_SECRET) {
    return sendErrorResponse(res, 500, 'Configuração incompleta: ADMIN_EMAIL ou JWT_SECRET não definidos');
  }

  // Sem o Admin SDK não há como verificar a assinatura do token — recusar
  // em vez de confiar cegamente no que o cliente enviou.
  const admin = getAdmin();
  if (!admin) {
    return sendErrorResponse(res, 503,
      'Login com Google indisponível: FIREBASE_SERVICE_ACCOUNT não configurado no servidor. Use email e senha.');
  }

  try {
    let firebaseUser;
    try {
      firebaseUser = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      console.error('[Firebase Auth]', err.message);
      registerLoginFailure(req);
      return sendErrorResponse(res, 401, 'Token do Firebase inválido ou expirado');
    }

    // A autorização usa o email DE DENTRO do token verificado — nunca o que
    // o cliente alega no body. Qualquer conta Google que não seja a do
    // administrador é recusada aqui.
    const verifiedEmail = String(firebaseUser.email || '').toLowerCase();
    if (!firebaseUser.email_verified || !safeEqual(verifiedEmail, String(ADMIN_EMAIL).toLowerCase())) {
      console.error(`[Firebase Auth] Login recusado: conta Google "${verifiedEmail || '—'}" (verificado=${!!firebaseUser.email_verified}) não é o ADMIN_EMAIL configurado no servidor.`);
      registerLoginFailure(req);
      // Devolve o email que a PESSOA MESMA usou (não o ADMIN_EMAIL) — ajuda
      // a perceber na hora se entrou com a conta Google errada, sem vazar
      // qual é o email do administrador para quem estiver só tentando a esmo.
      return sendErrorResponse(res, 403,
        verifiedEmail
          ? `A conta Google "${verifiedEmail}" não é a administradora deste sistema. Entre com a conta correta ou use email e senha.`
          : 'Email não autorizado. Entre em contato com o administrador.');
    }

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

// Informações da sessão atual (para a aba Configurações → Conta)
app.get('/api/auth/me', requireAuthJson, (req, res) => {
  try {
    const payload = jwt.verify(req.cookies?.system_token || '', JWT_SECRET);
    res.json({
      email: payload.email,
      provider: payload.provider || 'senha',
      expiraEm: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
    });
  } catch {
    res.status(401).json({ error: 'Não autenticado' });
  }
});

// ── OAuth Mercado Livre ───────────────────────────────────────────────

// In-memory cache for ML access_token (TTL ~6h) to avoid Firestore round-trips
let _mlTokenCache = { token: null, expiresAt: 0, sellerId: null };

// Retorna true se persistiu no Firestore. Sem persistência a conexão do ML
// morre junto com a instância serverless — quem chama precisa saber disso.
async function saveMLTokens(accessToken, refreshToken, sellerId, expiresIn) {
  const expiresAt = Date.now() + ((expiresIn || 21600) - 120) * 1000;
  _mlTokenCache = { token: accessToken, expiresAt, sellerId };
  const admin = getAdmin();
  if (!admin) { console.error('[saveMLTokens] Firebase Admin indisponível — token só em memória'); return false; }
  try {
    await admin.firestore().collection('ml_auth').doc('tokens').set({
      accessToken, refreshToken, sellerId: String(sellerId || ''),
      accessExpiresAt: expiresAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log('[ML OAuth] tokens persistidos no Firestore (seller', String(sellerId || '?') + ')');
    return true;
  } catch (e) { console.error('[saveMLTokens] Firestore falhou:', e.message); return false; }
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

// O refresh_token do ML também é DE USO ÚNICO. A versão antiga renovava a
// CADA instância nova do servidor — em chamadas simultâneas o mesmo refresh
// era usado duas vezes, o ML invalidava tudo e a conexão "caía sozinha"
// logo depois de conectar. Agora: usa o access salvo enquanto for válido e,
// quando precisar renovar, renova UMA vez só (single-flight).
let _mlRefreshing = null;
async function ensureMLToken() {
  if (!ML_CLIENT_ID || !ML_CLIENT_SECRET) return null;
  if (_mlTokenCache.token && Date.now() < _mlTokenCache.expiresAt) return _mlTokenCache;
  const admin = getAdmin();
  if (!admin) return null;
  try {
    const doc = await admin.firestore().collection('ml_auth').doc('tokens').get();
    if (!doc.exists) return null;
    const { accessToken, refreshToken, sellerId, accessExpiresAt } = doc.data();
    if (accessToken && accessExpiresAt && Date.now() < accessExpiresAt) {
      _mlTokenCache = { token: accessToken, expiresAt: accessExpiresAt, sellerId };
      return _mlTokenCache;
    }
    if (!refreshToken) return null;
    if (!_mlRefreshing) {
      _mlRefreshing = (async () => {
        try {
          const data = await refreshMLToken(refreshToken);
          await saveMLTokens(data.access_token, data.refresh_token || refreshToken, data.user_id || sellerId, data.expires_in || 21600);
          return _mlTokenCache;
        } finally { _mlRefreshing = null; }
      })();
    }
    return await _mlRefreshing;
  } catch (e) { console.error('[ensureMLToken]', e.response?.data || e.message); return null; }
}

function mlHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

app.get('/api/ml/auth/url', requireAuthJson, async (req, res) => {
  if (!ML_CLIENT_ID) return res.status(400).json({ error: 'ML_CLIENT_ID não configurado' });
  // PKCE (obrigatório nos apps novos do ML): sem code_verifier a troca do
  // código falha com "code_verifier is a required parameter".
  // O verifier fica em DOIS lugares: cookie httpOnly (caminho normal) e
  // Firestore indexado pelo state aleatório (sobrevive a cookie bloqueado,
  // troca de navegador no meio do fluxo ou instância nova do serverless).
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = 'emx_' + crypto.randomBytes(16).toString('base64url');
  res.cookie('ml_pkce', verifier, { httpOnly: true, secure: NODE_ENV === 'production', sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  const admin = getAdmin();
  if (admin) {
    try {
      await admin.firestore().collection('ml_pkce').doc(state).set({ verifier, createdAt: Date.now() });
    } catch (e) { console.error('[ML PKCE] Firestore indisponível, seguindo só com cookie:', e.message); }
  }
  const params = new URLSearchParams({
    response_type: 'code', client_id: ML_CLIENT_ID, redirect_uri: ML_REDIRECT_URI,
    state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  console.log('[ML PKCE] fluxo iniciado, state', state.slice(0, 12) + '…');
  res.json({ authUrl: `https://auth.mercadolivre.com.br/authorization?${params}` });
});

app.get('/api/ml/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.redirect(`/dashboard.html?ml_error=${encodeURIComponent(error)}`);
  if (!code) return res.redirect('/dashboard.html?ml_error=no_code');
  // Aceita o state aleatório novo (emx_…) e o antigo fixo (fluxos já abertos)
  const stateOk = typeof state === 'string' && (state.startsWith('emx_') || state === 'estoque_max_ml');
  if (!stateOk) return res.redirect('/dashboard.html?ml_error=invalid_state');
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code', client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET, code, redirect_uri: ML_REDIRECT_URI,
    });
    // PKCE: recupera o code_verifier — cookie primeiro, Firestore (por state)
    // como reserva quando o cookie não sobreviveu ao redirecionamento.
    let verifier = req.cookies?.ml_pkce || null;
    let origem = verifier ? 'cookie' : null;
    const admin = getAdmin();
    if (!verifier && admin && state.startsWith('emx_')) {
      try {
        const doc = await admin.firestore().collection('ml_pkce').doc(state).get();
        if (doc.exists) { verifier = doc.data().verifier; origem = 'firestore'; }
      } catch (e) { console.error('[ML PKCE] lookup falhou:', e.message); }
    }
    if (verifier) {
      params.set('code_verifier', verifier);
      res.clearCookie('ml_pkce');
      if (admin && state.startsWith('emx_')) admin.firestore().collection('ml_pkce').doc(state).delete().catch(() => {});
      console.log(`[ML PKCE] verifier recuperado via ${origem}`);
    } else {
      console.error('[ML PKCE] verifier NÃO encontrado (cookie e Firestore vazios) — a troca vai falhar');
      return res.redirect('/dashboard.html?ml_error=pkce_lost&ml_detail=' + encodeURIComponent('O código de segurança do fluxo se perdeu. Toque em Conectar de novo e conclua no MESMO navegador, sem modo anônimo.'));
    }
    const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    });
    console.log('[ML OAuth] troca de código OK (seller', String(data.user_id || '?') + ')');
    const persisted = await saveMLTokens(data.access_token, data.refresh_token, data.user_id, data.expires_in || 21600);
    // Sem Firestore o token morre com a instância e a conexão "some" em
    // segundos — melhor avisar na hora do que fingir que conectou.
    if (!persisted) return res.redirect('/dashboard.html?ml_error=storage_failed&ml_detail=' + encodeURIComponent('Token obtido, mas o Firestore não gravou — veja Diagnóstico ao vivo (Firestore respondendo).'));
    res.redirect('/dashboard.html?ml_connected=1');
  } catch (err) {
    console.error('[ML OAuth]', err.response?.data || err.message);
    // Devolve o motivo REAL do ML (invalid_client, invalid_grant etc.) para a
    // UI — "token_exchange_failed" seco não diz o que corrigir.
    const motivo = err.response?.data?.message || err.response?.data?.error || err.message || '';
    res.redirect(`/dashboard.html?ml_error=token_exchange_failed&ml_detail=${encodeURIComponent(String(motivo).slice(0, 140))}`);
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

async function fetchMLItemIds(ml, status = 'active', max = 1000) {
  const ids = [];
  for (let offset = 0; offset < max; offset += 50) {
    const { data } = await axios.get(`https://api.mercadolibre.com/users/${ml.sellerId}/items/search`, {
      headers: mlHeaders(ml.token), params: { status, limit: 50, offset },
    });
    const rows = Array.isArray(data?.results) ? data.results : [];
    ids.push(...rows);
    if (rows.length < 50 || ids.length >= Number(data?.paging?.total || max)) break;
  }
  return ids.slice(0, max);
}

async function fetchMLItems(ml, ids) {
  const all = [];
  for (let index = 0; index < ids.length; index += 20) {
    const { data } = await axios.get('https://api.mercadolibre.com/items', {
      headers: mlHeaders(ml.token), params: { ids: ids.slice(index, index + 20).join(',') },
    });
    all.push(...(Array.isArray(data) ? data.map(row => row.body || row).filter(Boolean) : []));
  }
  return all;
}

async function fetchMLOrders(ml, from, max = 1000) {
  const results = [];
  for (let offset = 0; offset < max; offset += 50) {
    const { data } = await axios.get('https://api.mercadolibre.com/orders/search', {
      headers: mlHeaders(ml.token),
      params: { seller: ml.sellerId, 'order.date_created.from': from, sort: 'date_desc', limit: 50, offset },
    });
    const rows = Array.isArray(data?.results) ? data.results : [];
    results.push(...rows);
    if (rows.length < 50 || results.length >= Number(data?.paging?.total || max)) break;
  }
  return results.slice(0, max);
}

function normalizeMLListing(item) {
  return {
    id: item.id, titulo: item.title, preco: item.price, qtd: item.available_quantity,
    initialQuantity: item.initial_quantity, soldQuantity: item.sold_quantity,
    situacao: item.status, subStatus: item.sub_status || [],
    thumb: item.pictures?.[0]?.secure_url || item.pictures?.[0]?.url || item.thumbnail,
    pictures: (item.pictures || []).map(picture => picture.secure_url || picture.url).filter(Boolean),
    link: item.permalink, sku: item.seller_custom_field || null,
    categoryId: item.category_id, condition: item.condition, listingTypeId: item.listing_type_id,
    buyingMode: item.buying_mode, warranty: item.warranty || '', videoId: item.video_id || '',
    catalogProductId: item.catalog_product_id || null, catalogListing: Boolean(item.catalog_listing),
    attributes: item.attributes || [], saleTerms: item.sale_terms || [],
    dateCreated: item.date_created, lastUpdated: item.last_updated,
  };
}

app.get('/api/ml/anuncios', requireAuthJson, async (req, res) => {
  const ml = await ensureMLToken();
  if (!ml?.token) return res.status(401).json({ error: 'ML não conectado', code: 'ML_NOT_CONNECTED' });
  try {
    const status = req.query.status || 'active';
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(1, Math.min(50, Number(req.query.pageSize) || 50));
    const allIds = await fetchMLItemIds(ml, status, 1000);
    const ids = allIds.slice((page - 1) * pageSize, page * pageSize);
    if (!ids.length) return res.json({ anuncios: [] });
    // "pictures" vem na mesma chamada em lote (sem custo extra de requisição)
    // e traz a foto em alta do anúncio; "thumbnail" sozinho é a miniatura
    // comprimida que o ML usa nos resultados de busca, sempre baixa qualidade.
    const items = await fetchMLItems(ml, ids);
    const anuncios = items.map(normalizeMLListing);
    res.json({ anuncios, total: allIds.length, page, pageSize, pages: Math.ceil(allIds.length / pageSize) });
  } catch (e) { sendErrorResponse(res, 500, 'Erro ao buscar anúncios', e.message); }
});

app.get('/api/ml/anuncios/:id', requireAuthJson, async (req, res) => {
  const ml = await ensureMLToken();
  if (!ml?.token) return res.status(401).json({ error: 'ML não conectado' });
  try {
    const { data: item } = await axios.get(`https://api.mercadolibre.com/items/${encodeURIComponent(req.params.id)}`, { headers: mlHeaders(ml.token) });
    let categoryAttributes = [];
    if (item.category_id) {
      try {
        const { data } = await axios.get(`https://api.mercadolibre.com/categories/${item.category_id}/attributes`, { headers: mlHeaders(ml.token) });
        categoryAttributes = Array.isArray(data) ? data : [];
      } catch { /* atributos são enriquecimento opcional */ }
    }
    res.json({ item: normalizeMLListing(item), categoryAttributes });
  } catch (err) { sendErrorResponse(res, 500, 'Erro ao buscar anúncio', err.message); }
});

// Edita preço e/ou estoque de um anúncio e MANDA a alteração de volta para
// o Mercado Livre (PUT /items/:id) — até aqui só existia leitura de
// anúncios; não havia como editar e enviar dados para o ML, só para o Bling.
app.patch('/api/ml/anuncios/:id', requireAuthJson, async (req, res) => {
  const ml = await ensureMLToken();
  if (!ml?.token) return res.status(401).json({ error: 'ML não conectado', code: 'ML_NOT_CONNECTED' });
  const { preco, estoque, titulo_produto, sku, garantia, videoId, condicao, titulo, atributos, termosVenda, imagens } = req.body || {};
  const payload = {};
  if (preco !== undefined) {
    const p = Number(preco);
    if (!(p > 0)) return res.status(400).json({ error: 'Preço inválido' });
    payload.price = p;
  }
  if (estoque !== undefined) {
    const q = Number(estoque);
    if (!(q >= 0) || !Number.isFinite(q)) return res.status(400).json({ error: 'Estoque inválido' });
    payload.available_quantity = q;
  }
  if (sku !== undefined) payload.seller_custom_field = String(sku).trim().slice(0, 100);
  if (garantia !== undefined) payload.warranty = String(garantia).trim().slice(0, 255);
  if (videoId !== undefined) payload.video_id = String(videoId).trim().slice(0, 80) || null;
  if (condicao !== undefined && ['new', 'used', 'not_specified'].includes(condicao)) payload.condition = condicao;
  if (titulo !== undefined) payload.title = String(titulo).trim().slice(0, 60);
  if (Array.isArray(atributos)) payload.attributes = atributos.slice(0, 100);
  if (Array.isArray(termosVenda)) payload.sale_terms = termosVenda.slice(0, 50);
  if (Array.isArray(imagens)) payload.pictures = imagens.filter(Boolean).slice(0, 12).map(source => ({ source }));
  if (!Object.keys(payload).length) return res.status(400).json({ error: 'Nenhum campo editável informado' });
  try {
    // Não reenvia campos iguais. Alguns anúncios com vendas/catálogo bloqueiam
    // título, condição ou fotos; reenviar o mesmo valor faria até uma simples
    // alteração de preço falhar por causa de um campo que não mudou.
    const { data: current } = await axios.get(`https://api.mercadolibre.com/items/${req.params.id}`, { headers: mlHeaders(ml.token) });
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    if (Number(payload.price) === Number(current.price)) delete payload.price;
    if (Number(payload.available_quantity) === Number(current.available_quantity)) delete payload.available_quantity;
    if (payload.title === current.title) delete payload.title;
    if (payload.seller_custom_field === (current.seller_custom_field || '')) delete payload.seller_custom_field;
    if (payload.warranty === (current.warranty || '')) delete payload.warranty;
    if ((payload.video_id || null) === (current.video_id || null)) delete payload.video_id;
    if (payload.condition === current.condition) delete payload.condition;
    if (same(payload.attributes, current.attributes)) delete payload.attributes;
    if (same(payload.sale_terms, current.sale_terms)) delete payload.sale_terms;
    if (payload.pictures && same(payload.pictures.map(p => p.source), (current.pictures || []).map(p => p.secure_url || p.url))) delete payload.pictures;
    if (!Object.keys(payload).length) return res.json({ success: true, unchanged: true, item: normalizeMLListing(current) });
    const { data } = await axios.put(`https://api.mercadolibre.com/items/${req.params.id}`, payload, { headers: mlHeaders(ml.token) });
    changeLog.push({
      id: changeLog.length + 1, produto_id: `ml_${req.params.id}`,
      produto_nome: titulo_produto || req.params.id, campo: 'Mercado Livre',
      valor_anterior: '—',
      valor_novo: [preco !== undefined ? `preço R$ ${Number(preco).toFixed(2)}` : null, estoque !== undefined ? `${Number(estoque)} un.` : null].filter(Boolean).join(' · '),
      timestamp: new Date().toISOString(),
    });
    saveInMemoryData();
    res.json({ success: true, item: normalizeMLListing(data) });
  } catch (err) {
    // A API do ML retorna o motivo da rejeição em cause[] (ex: preço abaixo do mínimo, item pausado etc.)
    const detail = err.response?.data?.cause?.[0]?.message || err.response?.data?.message || err.message;
    sendErrorResponse(res, err.response?.status || 500, 'Erro ao atualizar anúncio no Mercado Livre', detail);
  }
});

// O Bling permanece como fonte do saldo. A conciliação nunca dá uma segunda
// baixa no Bling: ela apenas replica para o anúncio ML o saldo atual do SKU,
// registrando cada ajuste para auditoria e evitando movimentação duplicada.
async function reconcileMLStock(blingToken, ml, { dryRun = false } = {}) {
  const catalog = await loadProductCostCatalog(blingToken);
  const storeLinks = await fetchProductStoreLinks(blingToken).catch(() => ({}));
  const catalogByProductId = new Map(Object.entries(catalog).map(([sku, product]) => [String(product.productId), { sku, ...product }]));
  const productByListingId = new Map();
  Object.entries(storeLinks).forEach(([productId, links]) => {
    const product = catalogByProductId.get(String(productId));
    if (!product) return;
    (links || []).forEach(link => { if (link.listingId) productByListingId.set(String(link.listingId).toUpperCase(), product); });
  });
  const ids = await fetchMLItemIds(ml, 'active', 1000);
  const listings = await fetchMLItems(ml, ids);
  const admin = getAdmin();
  const result = { checked: listings.length, linked: 0, autoLinked: 0, updated: 0, missingSku: 0, notFound: 0, errors: [] };
  for (const item of listings) {
    let sku = normalizeSku(item.seller_custom_field);
    let product = catalog[sku];
    if (!sku) {
      product = productByListingId.get(String(item.id).toUpperCase());
      if (product) { sku = product.sku; result.autoLinked++; }
      else { result.missingSku++; continue; }
    }
    if (!product) { result.notFound++; continue; }
    result.linked++;
    if (admin) {
      const skuKey = crypto.createHash('sha256').update(sku).digest('hex').slice(0, 32);
      await admin.firestore().collection('ml_sku_map').doc(skuKey).set({
        sku, itemIds: admin.firestore.FieldValue.arrayUnion(item.id), updatedAt: Date.now(),
      }, { merge: true });
    }
    const target = Math.max(0, Number(product.stock) || 0);
    const current = Math.max(0, Number(item.available_quantity) || 0);
    if (target === current && item.seller_custom_field) continue;
    try {
      const update = { available_quantity: target };
      if (!item.seller_custom_field && sku) update.seller_custom_field = sku;
      if (!dryRun) await axios.put(`https://api.mercadolibre.com/items/${item.id}`, update, { headers: mlHeaders(ml.token) });
      result.updated++;
      if (admin) {
        const eventId = crypto.createHash('sha256').update(`${item.id}|${sku}|${current}|${target}`).digest('hex').slice(0, 32);
        await admin.firestore().collection('stock_sync_events').doc(eventId).set({
          itemId: item.id, productId: product.productId, sku, from: current, to: target,
          source: 'bling', target: 'mercado_livre', dryRun, createdAt: Date.now(),
        }, { merge: true });
      }
    } catch (error) {
      result.errors.push({ itemId: item.id, sku, error: error.response?.data?.message || error.message });
    }
  }
  return result;
}

app.post('/api/sync/estoque', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  const ml = await ensureMLToken();
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });
  if (!ml?.token) return res.status(401).json({ error: 'Mercado Livre não conectado' });
  try { res.json(await reconcileMLStock(token, ml, { dryRun: req.body?.dryRun === true })); }
  catch (err) { sendErrorResponse(res, 500, 'Erro ao conciliar estoque', err.message); }
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

// ==========================================
// CONTATOS / FORNECEDORES (BLING v3)
// ==========================================

app.get('/api/fornecedores', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });
  try {
    const query = req.query.pesquisa || '';
    let url = 'https://www.bling.com.br/Api/v3/contatos?criterio=3&tipos=F,J';
    if (query) url += '&pesquisa=' + encodeURIComponent(query);
    const { data } = await axios.get(url, { headers: blingHeaders(token) });
    res.json({ fornecedores: data.data || [] });
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    sendErrorResponse(res, 500, 'Erro ao buscar fornecedores', err.message);
  }
});

app.post('/api/fornecedores', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });
  try {
    const { nome, numeroDocumento, telefone, email } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
    
    const isCnpj = numeroDocumento && numeroDocumento.replace(/\D/g, '').length > 11;
    const tipoContato = isCnpj ? 'J' : 'F';
    const payload = { nome, tipo: tipoContato };
    if (numeroDocumento) payload.numeroDocumento = numeroDocumento;
    if (telefone) payload.telefone = telefone;
    if (email) payload.email = email;
    
    const { data } = await axios.post('https://www.bling.com.br/Api/v3/contatos', payload, { headers: blingHeaders(token) });
    res.json({ success: true, id: data.data.id, fornecedor: data.data });
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    const detail = err.response?.data?.error?.message || err.response?.data || err.message;
    sendErrorResponse(res, 500, 'Erro ao criar fornecedor', detail);
  }
});

// ── Produtos ─────────────────────────────────────────────────────────

const BLING_API = 'https://www.bling.com.br/Api/v3';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Paginação completa e limitada por segurança. A versão anterior cortava
// produtos/pedidos depois de poucas páginas e silenciosamente gerava totais
// incorretos. O intervalo a cada três chamadas respeita o limite do Bling.
async function fetchBlingPaged(token, resource, params = {}, maxPages = 100) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await axios.get(`${BLING_API}/${resource}`, {
      headers: blingHeaders(token), params: { limite: 100, pagina: page, ...params },
    });
    const items = Array.isArray(data?.data) ? data.data : [];
    all.push(...items);
    if (items.length < 100) break;
    if (page % 3 === 0) await wait(1050);
  }
  return all;
}

async function fetchBlingProducts(token) {
  return fetchBlingPaged(token, 'produtos', {}, 100);
}

let _channelCache = { at: 0, map: {} };
async function getBlingChannels(token, force = false) {
  if (!force && Date.now() - _channelCache.at < 30 * 60 * 1000 && Object.keys(_channelCache.map).length) return _channelCache.map;
  const admin = getAdmin();
  if (!force && admin) {
    try {
      const snap = await admin.firestore().collection('bling_config').doc('channels').get();
      const saved = snap.exists ? snap.data() : null;
      if (saved?.map && Date.now() - Number(saved.cachedAt || 0) < 24 * 60 * 60 * 1000) {
        _channelCache = { at: Date.now(), map: saved.map };
        return saved.map;
      }
    } catch (e) { console.error('[canais] cache:', e.message); }
  }
  try {
    const channels = await fetchBlingPaged(token, 'canais-venda', {}, 20);
    const map = {};
    channels.forEach(channel => {
      const id = channel?.id || channel?.loja?.id;
      if (!id) return;
      map[String(id)] = channel?.descricao || channel?.nome || channel?.loja?.nome || `Canal ${id}`;
    });
    _channelCache = { at: Date.now(), map };
    if (admin) admin.firestore().collection('bling_config').doc('channels').set({ map, cachedAt: Date.now() }, { merge: true }).catch(() => {});
    return map;
  } catch (e) {
    console.error('[canais] Bling:', e.response?.data || e.message);
    return _channelCache.map;
  }
}

async function fetchProductStoreLinks(token, force = false) {
  const admin = getAdmin();
  if (!force && admin) {
    try {
      const snap = await admin.firestore().collection('bling_config').doc('product_store_links').get();
      const saved = snap.exists ? snap.data() : null;
      if (saved?.links && Date.now() - Number(saved.cachedAt || 0) < 6 * 60 * 60 * 1000) return saved.links;
    } catch (e) { console.error('[produto lojas] cache:', e.message); }
  }
  try {
    const [rows, channels] = await Promise.all([
      fetchBlingPaged(token, 'produtos/lojas', {}, 100),
      getBlingChannels(token, force),
    ]);
    const links = {};
    for (const row of rows) {
      const productId = row?.produto?.id || row?.idProduto || row?.produtoId;
      const storeId = row?.loja?.id || row?.canalVenda?.id || row?.idLoja || row?.idCanalVenda;
      if (!productId || !storeId) continue;
      const entry = {
        id: String(storeId),
        name: row?.loja?.nome || row?.canalVenda?.descricao || row?.canalVenda?.nome || channels[String(storeId)] || `Canal ${storeId}`,
        listingId: row?.id || row?.codigo || row?.idProdutoLoja || null,
        sku: row?.codigo || row?.sku || row?.produto?.codigo || '',
        price: Number(row?.preco) || 0,
        stock: Number(row?.estoque) || 0,
        active: row?.situacao !== 'I',
      };
      if (!links[String(productId)]) links[String(productId)] = [];
      if (!links[String(productId)].some(existing => existing.id === entry.id && existing.listingId === entry.listingId)) links[String(productId)].push(entry);
    }
    if (admin) await admin.firestore().collection('bling_config').doc('product_store_links').set({ links, cachedAt: Date.now() }, { merge: true });
    return links;
  } catch (e) {
    console.error('[produto lojas] Bling:', e.response?.data || e.message);
    return {};
  }
}

app.get('/api/produtos/lojas-vinculadas', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });
  const links = await fetchProductStoreLinks(token, req.query.force === '1');
  res.json({ links, totalProdutos: Object.keys(links).length, source: 'bling' });
});

function publicProductImageUrl(req, docId, version = Date.now()) {
  return `${req.protocol}://${req.get('host')}/img/produto/${docId}.jpg?v=${version}`;
}

async function getPersistedProductImages(req, produtoId, max = 12) {
  const admin = getAdmin();
  if (!admin) return [];
  const refs = Array.from({ length: max }, (_, i) =>
    admin.firestore().collection('produto_imagens').doc(i ? `${produtoId}_${i}` : String(produtoId))
  );
  try {
    const docs = await admin.firestore().getAll(...refs);
    return docs.filter(d => d.exists).map(d => publicProductImageUrl(req, d.id, d.updateTime?.toMillis() || Date.now()));
  } catch (e) {
    console.error('[produto imagens] leitura:', e.message);
    return [];
  }
}

async function prunePersistedProductImages(produtoId, keptUrls, max = 12) {
  const admin = getAdmin();
  if (!admin) return;
  const kept = new Set((keptUrls || []).map(url => {
    const match = String(url).match(/\/img\/produto\/(\d+(?:_\d+)?)(?:\.[a-z]+)?/i);
    return match?.[1] || null;
  }).filter(Boolean));
  const refs = Array.from({ length: max }, (_, index) => admin.firestore().collection('produto_imagens').doc(index ? `${produtoId}_${index}` : String(produtoId)));
  const docs = await admin.firestore().getAll(...refs);
  const batch = admin.firestore().batch();
  let changed = false;
  docs.forEach(doc => {
    if (doc.exists && !kept.has(doc.id)) { batch.delete(doc.ref); changed = true; }
  });
  if (changed) await batch.commit();
}

app.get('/api/produtos', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });

  try {
    const allProducts = await fetchBlingProducts(token);

    const products = allProducts.map(p => ({
      id:         p.id,
      nome:       p.nome       || 'Sem nome',
      codigo:     p.codigo     || '',
      preco:      typeof p.preco === 'number' ? p.preco : 0,
      // Bling guarda o custo em fornecedor.precoCusto — o campo solto na
      // raiz nem sempre vem preenchido no GET, então cai pro aninhado.
      precoCusto: getProductCusto(p),
      estoque:    typeof p.estoque === 'object' ? (p.estoque?.saldoVirtualTotal ?? 0) : (p.estoque ?? 0),
      tipo:       p.tipo || 'P',
      unidade:    p.unidade || 'un',
      peso:       p.pesoBruto || 0,
      descricao:  p.descricaoComplementar || p.descricao || '',
      categoria:  p.categoria?.descricao || '',
      situacao:   String((typeof p.situacao === 'object' ? (p.situacao?.valor || p.situacao?.nome) : p.situacao) || 'A'),
      // A listagem do Bling v3 traz a miniatura em `imagemURL`; o detalhe traz
      // `midia.imagens.{internas,externas}[].link`. Os campos antigos
      // (imagem.link / imageThumbnailURL) NÃO existem — por isso todos os
      // produtos apareciam com placeholder mesmo tendo foto no Bling.
      imagemUrl:  (p.imagemURL
               || p.midia?.imagens?.internas?.[0]?.link
               || p.midia?.imagens?.externas?.[0]?.link
               || p.imagem?.link || '').replace(/^http:\/\//i, 'https://'),
      hasFornecedor: !!(p.fornecedor?.id || p.fornecedorId),
    }));

    // Imagens enviadas pelo próprio painel têm prioridade (aparecem na hora,
    // sem esperar o Bling processar a URL externa). Só os metadados são
    // lidos (select) — o base64 pesado fica fora desta consulta.
    const admin = getAdmin();
    if (admin) {
      try {
        const snap = await admin.firestore().collection('produto_imagens').select('updatedAt').get();
        const overrides = new Map();
        snap.docs.forEach(d => {
          const productId = d.id.split('_')[0];
          if (!overrides.has(productId) || d.id === productId) overrides.set(productId, { id: d.id, version: d.updateTime?.toMillis() || Date.now() });
        });
        if (overrides.size) {
          for (const prod of products) {
            const v = overrides.get(String(prod.id));
            if (v) prod.imagemUrl = publicProductImageUrl(req, v.id, v.version);
          }
        }
      } catch (e) { console.error('[produtos] override de imagens:', e.message); }
      
      try {
        const snapOcultos = await admin.firestore().collection('produtos_ocultos').get();
        const ocultosSet = new Set(snapOcultos.docs.map(d => d.id));
        for (const prod of products) {
          if (ocultosSet.has(String(prod.id))) prod.oculto = true;
        }
      } catch (e) { console.error('[produtos] override de ocultos:', e.message); }

      try {
        const snapOverrides = await admin.firestore().collection('produto_overrides').get();
        const map = new Map(snapOverrides.docs.map(d => [d.id, d.data()]));
        for (const prod of products) {
          const saved = map.get(String(prod.id));
          if (!saved) continue;
          if (saved.fornecedor?.id) {
            prod.fornecedor = saved.fornecedor;
            prod.hasFornecedor = true;
          }
          if (Number(saved.precoCusto) >= 0) prod.precoCusto = Number(saved.precoCusto);
        }
      } catch (e) { console.error('[produtos] override persistente:', e.message); }
    }

    res.json({ total: products.length, products });
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token Bling expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, 500, 'Erro ao buscar produtos', err.message);
  }
});

const _vendasRankingCache = new Map();
const VENDAS_RANKING_AMOSTRA_MAX = 30; // ~30 × 350ms ≈ 10s — mesmo raciocínio do TAXAS_AMOSTRA_MAX

// Ranking de quantidade vendida por SKU — usado pra ordenar "mais vendido"/
// "menos vendas" na aba Produtos. O Bling não expõe isso na listagem de
// produtos nem de pedidos (só no detalhe por ID), então é uma AMOSTRA dos
// pedidos mais recentes do período — não a contagem exata quando há muitos
// pedidos (mesma limitação já assumida no "Top 5" do Financeiro/Dashboard).
app.get('/api/produtos/vendas-ranking', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });
  const dias = Math.min(Math.max(parseInt(req.query.dias) || 90, 1), 365);
  const fim = isoLocal();
  const inicio = isoLocalDiasAtras(dias);
  const key = `${inicio}|${fim}`;
  const hit = _vendasRankingCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60000 && !req.query.force) return res.json(hit.payload);
  try {
    const ledgerFacts = await getLedgerFacts(inicio, fim);
    if (ledgerFacts.length) {
      const porCodigo = {}, devolucoesPorCodigo = {};
      ledgerFacts.forEach(fact => {
        const target = fact.statusCategory === 'cancelado' ? devolucoesPorCodigo : porCodigo;
        (fact.items || []).forEach(item => { if (item.sku) target[item.sku] = (target[item.sku] || 0) + (Number(item.quantity) || 0); });
      });
      const payload = { periodo: { inicio, fim, dias }, vendasPorCodigo: porCodigo, devolucoesPorCodigo, amostra: ledgerFacts.length, dePedidos: ledgerFacts.length, exata: true, source: 'sales_ledger' };
      _vendasRankingCache.set(key, { at: Date.now(), payload });
      return res.json(payload);
    }
    const lista = await fetchPedidos(token, inicio, fim, 3);
    const validos = lista.filter(p => categorizePedido(p.situacao) !== 'cancelado');
    const devolvidos = lista.filter(p => situacaoPT(p.situacao).toLowerCase().includes('devolv'));
    
    // Mesclar amostra de válidos e devolvidos, limitando para não estourar o tempo de request
    const amostra = [...validos.slice(0, VENDAS_RANKING_AMOSTRA_MAX), ...devolvidos.slice(0, 15)];
    const porCodigo = {};
    const devolucoesPorCodigo = {};
    let detalhados = 0;
    
    for (const p of amostra) {
      try {
        const isReturn = situacaoPT(p.situacao).toLowerCase().includes('devolv');
        const { data } = await axios.get(`https://www.bling.com.br/Api/v3/pedidos/vendas/${p.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = data?.data || data || {};
        const itens = Array.isArray(d.itens) ? d.itens : [];
        for (const it of itens) {
          const codigo = it.codigo || it.produto?.codigo || '';
          if (!codigo) continue;
          if (isReturn) {
            devolucoesPorCodigo[codigo] = (devolucoesPorCodigo[codigo] || 0) + (Number(it.quantidade) || 0);
          } else {
            porCodigo[codigo] = (porCodigo[codigo] || 0) + (Number(it.quantidade) || 0);
          }
        }
        detalhados++;
      } catch { /* um pedido falhou; os demais seguem */ }
    }
    
    const payload = {
      periodo: { inicio, fim, dias },
      vendasPorCodigo: porCodigo,
      devolucoesPorCodigo,
      amostra: detalhados,
      dePedidos: validos.length,
      exata: detalhados >= validos.length,
    };
    _vendasRankingCache.set(key, { at: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, 500, 'Erro ao calcular ranking de vendas', err.message);
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
    const produto = data?.data || {};
    const admin = getAdmin();
    if (admin) {
      try {
        const saved = await admin.firestore().collection('produto_overrides').doc(String(produtoId)).get();
        if (saved.exists) {
          const override = saved.data();
          if (override.fornecedor?.id && !produto.fornecedor?.id) produto.fornecedor = override.fornecedor;
          if (Number(override.precoCusto) >= 0 && !(getProductCusto(produto) > 0)) {
            produto.precoCusto = Number(override.precoCusto);
            produto.fornecedor = { ...(produto.fornecedor || override.fornecedor || {}), precoCusto: Number(override.precoCusto) };
          }
        }
      } catch (e) { console.error('[produto] override persistente:', e.message); }
    }
    const persistidas = await getPersistedProductImages(req, produtoId);
    const bling = [
      ...(produto.midia?.imagens?.internas || []),
      ...(produto.midia?.imagens?.externas || []),
    ].map(i => i?.link).filter(Boolean).map(url => String(url).replace(/^http:\/\//i, 'https://'));
    produto.imagemUrls = [...new Set([...persistidas, ...bling])];
    if (produto.imagemUrls[0]) produto.imagemUrl = produto.imagemUrls[0];
    const storeLinks = await fetchProductStoreLinks(token).catch(() => ({}));
    produto.canaisVenda = storeLinks[String(produtoId)] || [];
    res.json(produto);
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
    const body = { ...req.body };
    if (body.imagemUrls && Array.isArray(body.imagemUrls)) {
      const externas = body.imagemUrls.filter(Boolean).map(link => ({ link }));
      if (externas.length > 0) body.midia = { imagens: { externas } };
      delete body.imagemUrls;
    } else if (body.imagemUrl) { 
      body.midia = { imagens: { externas: [{ link: body.imagemUrl }] } }; 
      delete body.imagemUrl; 
    }
    // Custo vai em fornecedor.precoCusto — ver stripReadOnlyProdutoFields/PATCH.
    if (body.precoCusto !== undefined) body.fornecedor = { ...(body.fornecedor || {}), precoCusto: Number(body.precoCusto) };
    const { data } = await axios.post('https://www.bling.com.br/Api/v3/produtos', body, {
      headers: blingHeaders(token),
    });
    const criado = data?.data || data;
    changeLog.push({
      id: changeLog.length + 1, produto_id: criado?.id || '—',
      produto_nome: req.body.nome || 'Novo produto', campo: 'criação',
      valor_anterior: '—', valor_novo: req.body.nome || '—',
      timestamp: new Date().toISOString(),
    });
    saveInMemoryData();
    res.json(criado);
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.response?.data || err.message;
    sendErrorResponse(res, 500, 'Erro ao criar produto', detail);
  }
});

// ── Upload de imagem de produto ─────────────────────────────────────
// O Bling v3 só aceita imagem por URL pública (midia.imagens.externas), não
// upload binário. Fluxo: o editor comprime no navegador (canvas), manda o
// dataURL para cá, guardamos no Firestore e servimos numa URL pública que
// também é cadastrada no Bling. Nada de campo de URL manual.
const IMG_MIMES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

app.post('/api/produtos/:id/imagem', requireAuthJson, async (req, res) => {
  const admin = getAdmin();
  if (!admin) return res.status(503).json({ error: 'Armazenamento indisponível (FIREBASE_SERVICE_ACCOUNT ausente)' });
  try {
    const produtoId = validateNumericId(req.params.id, 'ID do produto');
    const index = req.body.index !== undefined ? Number(req.body.index) : 0;
    const docId = index === 0 ? String(produtoId) : `${produtoId}_${index}`;
    const m = String(req.body?.dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return res.status(400).json({ error: 'Envie um dataURL de imagem JPG, PNG ou WEBP' });
    const [, mime, b64] = m;
    // Firestore limita o documento a ~1MB — o front comprime bem abaixo disso
    if (b64.length > 950_000) return res.status(413).json({ error: 'Imagem grande demais mesmo após compressão (máx ~700KB)' });
    await admin.firestore().collection('produto_imagens').doc(docId).set({
      data: b64, mime, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // URL pública (com cache-buster) que o navegador e o Bling vão usar
    const url = publicProductImageUrl(req, docId);
    res.json({ url });
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    sendErrorResponse(res, 500, 'Erro ao salvar imagem', err.message);
  }
});

// Público de propósito: o Bling e as tags <img> precisam acessar sem cookie.
// Imagem de produto de e-commerce não é dado sensível.
app.get('/img/produto/:id', async (req, res) => {
  const admin = getAdmin();
  if (!admin) return res.status(404).end();
  try {
    const rawId = req.params.id;
    const cleanId = rawId.includes('.') ? rawId.split('.')[0] : rawId;
    if (!/^\d+(_\d+)?$/.test(cleanId)) return res.status(400).end();
    const doc = await admin.firestore().collection('produto_imagens').doc(String(cleanId)).get();
    if (!doc.exists) return res.status(404).end();
    const { data, mime } = doc.data();
    res.set('Content-Type', mime || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(data, 'base64'));
  } catch { res.status(500).end(); }
});

// Ocultar / Restaurar Produtos
app.post('/api/produtos/:id/ocultar', requireAuthJson, async (req, res) => {
  const admin = getAdmin();
  if (!admin) return res.status(503).json({ error: 'Armazenamento indisponível' });
  try {
    const produtoId = validateNumericId(req.params.id, 'ID do produto');
    await admin.firestore().collection('produtos_ocultos').doc(String(produtoId)).set({
      oculto: true, updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true });
  } catch (err) {
    sendErrorResponse(res, 500, 'Erro ao ocultar', err.message);
  }
});
app.delete('/api/produtos/:id/ocultar', requireAuthJson, async (req, res) => {
  const admin = getAdmin();
  if (!admin) return res.status(503).json({ error: 'Armazenamento indisponível' });
  try {
    const produtoId = validateNumericId(req.params.id, 'ID do produto');
    await admin.firestore().collection('produtos_ocultos').doc(String(produtoId)).delete();
    res.json({ ok: true });
  } catch (err) {
    sendErrorResponse(res, 500, 'Erro ao restaurar', err.message);
  }
});

// Busca pedidos de venda num intervalo (paginado)
async function fetchPedidos(token, inicio, fim, maxPg = 100) {
  return fetchBlingPaged(token, 'pedidos/vendas', { dataInicial: inicio, dataFinal: fim }, maxPg);
}

const _pedidoDetalheCache = new Map();
const PEDIDO_DETALHE_TTL_MS = 30 * 60 * 1000;
const PEDIDO_DETALHE_PERSIST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PEDIDOS_EXATOS_MAX = 150;

async function fetchPedidoDetalheCached(token, id) {
  const key = String(id);
  const hit = _pedidoDetalheCache.get(key);
  if (hit && Date.now() - hit.at < PEDIDO_DETALHE_TTL_MS) return hit.data;
  const admin = getAdmin();
  if (admin) {
    try {
      const snap = await admin.firestore().collection('bling_pedido_detalhes').doc(key).get();
      const saved = snap.exists ? snap.data() : null;
      if (saved?.detail && Date.now() - Number(saved.cachedAt || 0) < PEDIDO_DETALHE_PERSIST_TTL_MS) {
        _pedidoDetalheCache.set(key, { at: Date.now(), data: saved.detail });
        return saved.detail;
      }
    } catch (e) { console.error('[pedido cache] leitura:', e.message); }
  }
  const { data } = await axios.get(`https://www.bling.com.br/Api/v3/pedidos/vendas/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const detail = data?.data || data || {};
  _pedidoDetalheCache.set(key, { at: Date.now(), data: detail });
  if (admin) {
    admin.firestore().collection('bling_pedido_detalhes').doc(key).set({
      detail, cachedAt: Date.now(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(e => console.error('[pedido cache] gravação:', e.message));
  }
  return detail;
}

async function fetchPedidosDetalhados(token, pedidos, max = PEDIDOS_EXATOS_MAX) {
  const selecionados = pedidos.slice(0, max);
  const details = [];
  let failed = 0;
  // Uma leitura em lote no Firestore substitui até 150 leituras sequenciais.
  // Isso é o que faz trocar datas responder de imediato depois que os pedidos
  // já foram sincronizados ao menos uma vez.
  const admin = getAdmin();
  if (admin && selecionados.length) {
    try {
      const refs = selecionados.map(p => admin.firestore().collection('bling_pedido_detalhes').doc(String(p.id)));
      const docs = await admin.firestore().getAll(...refs);
      docs.forEach(doc => {
        const saved = doc.exists ? doc.data() : null;
        if (saved?.detail && Date.now() - Number(saved.cachedAt || 0) < PEDIDO_DETALHE_PERSIST_TTL_MS) {
          _pedidoDetalheCache.set(doc.id, { at: Date.now(), data: saved.detail });
        }
      });
    } catch (e) { console.error('[pedido cache] lote:', e.message); }
  }
  // Pedidos já sincronizados são retornados imediatamente. Só os ausentes
  // entram nas janelas limitadas da API — antes havia uma espera de 1 segundo
  // até quando todos os 150 detalhes já estavam no cache.
  const missing = [];
  for (const pedido of selecionados) {
    const hit = _pedidoDetalheCache.get(String(pedido.id));
    if (hit && Date.now() - hit.at < PEDIDO_DETALHE_PERSIST_TTL_MS) details.push(hit.data);
    else missing.push(pedido);
  }
  for (let index = 0; index < missing.length; index += 3) {
    const lote = missing.slice(index, index + 3);
    const resultados = await Promise.allSettled(lote.map(p => fetchPedidoDetalheCached(token, p.id)));
    resultados.forEach(r => { if (r.status === 'fulfilled') details.push(r.value); else failed++; });
    if (index + 3 < missing.length) await wait(1050);
  }
  return {
    details,
    failed,
    requested: selecionados.length,
    total: pedidos.length,
    exact: details.length === pedidos.length && failed === 0,
  };
}

const categorizePedido = s => {
  const n = situacaoPT(s).toLowerCase();
  if (n.includes('cancel') || n.includes('devolv') || n.includes('reembolsad') || n.includes('suspenso') || n.includes('falhou')) return 'cancelado';
  if (n.includes('atend') || n.includes('conclui') || n.includes('entregue') || n.includes('faturad') || n.includes('despachad') || n.includes('enviado') || n.includes('encerrad')) return 'concluido';
  return 'pendente';
};
// Receita efetiva da mercadoria, igual ao "Valor Base R$" do Bling. O frete
// cobrado do comprador é informativo/pass-through e não infla o faturamento.
const valorPedido = p => normalizeBlingOrder(p).salesBase;
const valorTotalPedido = p => normalizeBlingOrder(p).customerTotal;
const BLING_LOJA_NOMES = {
  '205944878': 'Max Renovação Google Shop',
  '205751409': 'Max Renovação ML',
  '205940466': 'Max Renovação Shopify',
  '205943400': 'Max Renovação Tiktok Shop',
  '205751424': 'Max Renovação Yampi',
  '205940026': 'TM Logistica',
};
const nomeLojaPedido = p => {
  const id = String(p?.loja?.id || '');
  return p?.loja?.nome || _channelCache.map[id] || BLING_LOJA_NOMES[id] || null;
};

async function loadProductCostCatalog(token) {
  const products = await fetchBlingProducts(token);
  const bySku = {};
  for (const product of products) {
    const sku = normalizeSku(product?.codigo);
    if (!sku) continue;
    bySku[sku] = {
      productId: product.id,
      cost: getProductCusto(product),
      price: Number(product.preco) || 0,
      stock: typeof product.estoque === 'object' ? Number(product.estoque?.saldoVirtualTotal) || 0 : Number(product.estoque) || 0,
      imageUrl: String(product.imagemURL || '').replace(/^http:\/\//i, 'https://'),
      name: product.nome || sku,
    };
  }
  const admin = getAdmin();
  if (admin) {
    try {
      const snap = await admin.firestore().collection('produto_overrides').get();
      const byId = new Map(products.map(product => [String(product.id), normalizeSku(product.codigo)]));
      snap.forEach(doc => {
        const sku = byId.get(doc.id);
        const saved = doc.data() || {};
        if (sku && bySku[sku] && Number(saved.precoCusto) >= 0) bySku[sku].cost = Number(saved.precoCusto);
      });
    } catch (e) { console.error('[custos catálogo]', e.message); }
  }
  return bySku;
}

async function getLedgerFacts(inicio, fim) {
  const admin = getAdmin();
  if (!admin) return [];
  const snap = await admin.firestore().collection('sales_ledger')
    .where('date', '>=', inicio).where('date', '<=', fim).get();
  return snap.docs.map(doc => doc.data()).filter(fact => fact?.date >= inicio && fact?.date <= fim);
}

async function syncSalesLedger(token, { inicio, fim, limit = 120, force = false } = {}) {
  const admin = getAdmin();
  if (!admin) throw new Error('Firestore não configurado');
  const end = fim || isoLocal();
  const start = inicio || isoLocalDiasAtras(365);
  const summaries = await fetchPedidos(token, start, end, 100);
  await getBlingChannels(token).catch(() => ({}));

  const refs = summaries.map(order => admin.firestore().collection('sales_ledger').doc(String(order.id)));
  const existing = new Map();
  for (let index = 0; index < refs.length; index += 400) {
    const docs = await admin.firestore().getAll(...refs.slice(index, index + 400));
    docs.forEach(doc => { if (doc.exists) existing.set(doc.id, doc.data()); });
  }
  const missing = summaries.filter(order => force || !existing.has(String(order.id)));
  const selected = missing.slice(0, Math.max(1, Math.min(Number(limit) || 120, 300)));
  const costBySku = selected.length ? await loadProductCostCatalog(token) : {};
  const detailBatch = await fetchPedidosDetalhados(token, selected, selected.length || 1);
  const byId = new Map(detailBatch.details.map(detail => [String(detail.id), detail]));

  let batch = admin.firestore().batch();
  let operations = 0;
  let written = 0;
  const commit = async () => {
    if (!operations) return;
    await batch.commit();
    batch = admin.firestore().batch(); operations = 0;
  };
  for (const summary of summaries) {
    const id = String(summary.id);
    const detail = byId.get(id);
    const statusCategory = categorizePedido(summary.situacao);
    if (!detail && !existing.has(id)) continue;
    const fact = detail
      ? buildSalesFact(detail, { costBySku, channelById: _channelCache.map, status: situacaoPT(summary.situacao), statusCategory })
      : { ...existing.get(id), status: situacaoPT(summary.situacao), statusCategory, channelName: nomeLojaPedido(summary) || existing.get(id)?.channelName || null };
    fact.syncedAt = new Date().toISOString();
    batch.set(admin.firestore().collection('sales_ledger').doc(id), fact, { merge: true });
    batch.delete(admin.firestore().collection('sync_queue').doc(`order_${id}`));
    operations += 2; written++;
    if (operations >= 400) await commit();
  }
  await commit();
  const remaining = Math.max(0, missing.length - detailBatch.details.length);
  await admin.firestore().collection('sync_state').doc('sales').set({
    inicio: start, fim: end, found: summaries.length, written, remaining,
    complete: remaining === 0, syncedAt: Date.now(),
  }, { merge: true });
  return { inicio: start, fim: end, found: summaries.length, written, remaining, complete: remaining === 0, failed: detailBatch.failed };
}

function fixedCostsForPeriod(inicio, fim) {
  return customContas.filter(account => account.tipo === 'fixa' && account.status !== 'cancelada' && account.dataVencimento >= inicio && account.dataVencimento <= fim)
    .reduce((sum, account) => sum + (Number(account.valor) || 0), 0);
}

app.post('/api/sync/vendas', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });
  try {
    const result = await syncSalesLedger(token, {
      inicio: req.body?.inicio, fim: req.body?.fim,
      limit: req.body?.limit || 120, force: req.body?.force === true,
    });
    res.json(result);
  } catch (err) { sendErrorResponse(res, 500, 'Erro ao sincronizar vendas', err.message); }
});

app.delete('/api/produtos/:id/imagem/:index', requireAuthJson, async (req, res) => {
  const admin = getAdmin();
  if (!admin) return res.status(503).json({ error: 'Armazenamento indisponível' });
  try {
    const productId = validateNumericId(req.params.id, 'ID do produto');
    const index = Math.max(0, Math.min(11, Number(req.params.index) || 0));
    const docId = index ? `${productId}_${index}` : String(productId);
    await admin.firestore().collection('produto_imagens').doc(docId).delete();
    res.json({ success: true });
  } catch (err) { sendErrorResponse(res, 500, 'Erro ao remover imagem', err.message); }
});

app.get('/api/analytics/vendas', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });
  const { inicio, fim, period } = resolvePeriodo(req.query.period, req.query.startDate, req.query.endDate);
  try {
    let facts = await getLedgerFacts(inicio, fim);
    let sync = null;
    if (!facts.length && req.query.warm !== '0') {
      sync = await syncSalesLedger(token, { inicio, fim, limit: 45 });
      facts = await getLedgerFacts(inicio, fim);
    }
    await loadPersistedData();
    const fixedCosts = fixedCostsForPeriod(inicio, fim);
    const analytics = aggregateSalesFacts(facts, { fixedCosts, allocationRule: req.query.allocationRule || 'revenue' });
    res.json({ periodo: { inicio, fim, period }, ...analytics, sync, exact: Boolean(facts.length) && facts.every(f => f.costSnapshotComplete), source: 'sales_ledger' });
  } catch (err) { sendErrorResponse(res, 500, 'Erro ao calcular indicadores reais', err.message); }
});

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

    // Paginação completa: os totais não podem cortar silenciosamente depois
    // de 300 pedidos. As duas leituras continuam em paralelo.
    const [allPedidos, prevPedidos] = await Promise.all([
      fetchPedidos(token, inicio, fim, 100),
      fetchPedidos(token, prev.inicio, prev.fim, 100).catch(() => []),
    ]);

    const categorize = categorizePedido;
    const concluidos = allPedidos.filter(p => categorize(p.situacao) === 'concluido');
    const cancelados = allPedidos.filter(p => categorize(p.situacao) === 'cancelado');
    const pendentes  = allPedidos.filter(p => categorize(p.situacao) === 'pendente');
    // "Pedidos feitos": todo pedido que existe no Bling já teve o pagamento
    // confirmado pelo canal de venda — a única exclusão real é cancelamento/
    // devolução. É essa a receita "realizada" do período, não só a fatia
    // com situação de entrega/despacho (que ficava só em "concluídos").
    const feitos = allPedidos.filter(p => categorize(p.situacao) !== 'cancelado');

    const sum = (arr, fn) => arr.reduce((a, p) => a + (fn(p) || 0), 0);
    const totalBruto       = sum(allPedidos, valorPedido);
    const receitaConcluida = sum(feitos,      valorPedido);
    const totalCancelado   = sum(cancelados,  valorPedido);
    const totalPendente    = sum(pendentes,   valorPedido);
    // Bling retorna frete aninhado em transporte.frete (não como campo
    // plano) — ler o caminho errado aqui fazia o total de frete ficar
    // sempre zero, mesmo com pedidos tendo frete cobrado de verdade.
    const totalFrete       = sum(allPedidos, p => normalizeBlingOrder(p).shippingCharged);
    const totalDesconto    = sum(allPedidos, p => orderDiscount(p));

    // Comparativo com período anterior (pedidos feitos)
    const prevFeitos = prevPedidos.filter(p => categorize(p.situacao) !== 'cancelado');
    const prevReceita = sum(prevFeitos, valorPedido);
    const variacao = prevReceita > 0 ? ((receitaConcluida - prevReceita) / prevReceita) * 100 : null;

    // Série diária para gráfico (pedidos feitos = receita real)
    const byDay = {};
    feitos.forEach(p => {
      const day = String(p.data || p.dataPedido || '').substring(0, 10);
      if (day) byDay[day] = (byDay[day] || 0) + valorPedido(p);
    });

    res.json({
      periodo: { inicio, fim, period },
      totalBruto, receitaConcluida, totalCancelado, totalPendente,
      totalFrete, totalDesconto,
      totalPedidos: allPedidos.length,
      concluidos: concluidos.length,
      feitos: feitos.length,
      cancelados: cancelados.length,
      pendentes: pendentes.length,
      ticketMedio: feitos.length > 0 ? receitaConcluida / feitos.length : 0,
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

// ── Taxas reais por canal (comissão + custo de frete dos marketplaces) ──
// A LISTAGEM de pedidos do Bling não traz o bloco `taxas` — ele só vem no
// DETALHE (GET /pedidos/vendas/{id}): { taxaComissao, custoFrete, valorBase }.
// O detalhe contém os números que aparecem na tela do Bling: desconto,
// Valor Base, comissão, custo de frete e valor líquido. Eles são consultados
// respeitando o limite oficial de 3 chamadas/s e guardados em cache.
const _taxasCache = new Map();
app.get('/api/financeiro/taxas', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });
  const { inicio, fim, period } = resolvePeriodo(req.query.period, req.query.startDate, req.query.endDate);
  const key = `${inicio}|${fim}`;
  const hit = _taxasCache.get(key);
  if (hit?.payload?.schemaVersion >= 2 && Date.now() - hit.at < 10 * 60000 && !req.query.force) return res.json(hit.payload);
  const admin = getAdmin();
  const periodDocId = `${inicio}_${fim}`;
  if (admin && !req.query.force) {
    try {
      const saved = await admin.firestore().collection('financeiro_periodos').doc(periodDocId).get();
      const cached = saved.exists ? saved.data() : null;
      if (cached?.payload?.schemaVersion >= 2 && Date.now() - Number(cached.cachedAt || 0) < 24 * 60 * 60 * 1000) {
        _taxasCache.set(key, { at: Date.now(), payload: cached.payload });
        return res.json(cached.payload);
      }
    } catch (e) { console.error('[financeiro cache] leitura:', e.message); }
  }
  try {
    let ledgerFacts = await getLedgerFacts(inicio, fim);
    if (!ledgerFacts.length && !req.query.forceLegacy) {
      await syncSalesLedger(token, { inicio, fim, limit: 30 }).catch(error => console.error('[financeiro warmup]', error.message));
      ledgerFacts = await getLedgerFacts(inicio, fim);
    }
    if (ledgerFacts.length && !req.query.forceLegacy) {
      await loadPersistedData();
      const analytics = aggregateSalesFacts(ledgerFacts, {
        fixedCosts: fixedCostsForPeriod(inicio, fim),
        allocationRule: req.query.allocationRule || 'revenue',
      });
      let syncState = {};
      try {
        const stateDoc = await admin.firestore().collection('sync_state').doc('sales').get();
        syncState = stateDoc.exists ? stateDoc.data() : {};
      } catch { /* estado é apenas informativo */ }
      const payload = {
        schemaVersion: 2,
        source: 'sales_ledger',
        periodo: { inicio, fim, period },
        totais: {
          comissao: analytics.totals.fees,
          custoFrete: analytics.totals.channelShipping,
          freteCobrado: analytics.totals.customerShipping,
          valorBase: analytics.totals.revenue,
          totalVenda: analytics.totals.customerTotal,
          totalProdutos: analytics.totals.revenue + analytics.totals.discount,
          desconto: analytics.totals.discount,
          outrasDespesas: 0,
          valorLiquido: analytics.totals.revenue - analytics.totals.fees - analytics.totals.channelShipping,
          cmv: analytics.totals.cmv,
          custosFixos: analytics.totals.fixedCosts,
          lucroReal: analytics.totals.realProfit,
          pontoEquilibrio: analytics.totals.breakEven,
        },
        estimativaPeriodo: { fator: 1, exata: analytics.costSnapshotComplete, comissao: analytics.totals.fees, custoFrete: analytics.totals.channelShipping, valorBase: analytics.totals.revenue },
        porLoja: analytics.channels.map(channel => ({ lojaId: channel.channelId, lojaNome: channel.channelName, pedidos: channel.orders, comissao: channel.fees, custoFrete: channel.shipping, freteCobrado: 0, valor: channel.revenue, cmv: channel.cmv, lucroReal: channel.profit })),
        topVendidos: analytics.products.slice(0, 5).map(product => ({ codigo: product.sku, nome: product.name, qtd: product.quantity, faturamento: product.revenue, lucroReal: product.realProfit })),
        produtosVendidos: analytics.products.map(product => ({ codigo: product.sku, nome: product.name, qtd: product.quantity, faturamento: product.revenue, cmv: product.cmv, lucroReal: product.realProfit, margemReal: product.realMargin, classeABC: analytics.abc.find(row => row.sku === product.sku)?.classification || 'C', imagemUrl: product.imageUrl || '' })),
        curvaABC: analytics.abc,
        allocationRule: analytics.allocationRule,
        amostra: analytics.orders,
        dePedidos: analytics.orders,
        falhas: 0,
        exact: analytics.costSnapshotComplete,
        syncComplete: Boolean(syncState.complete),
        syncRemaining: Number(syncState.remaining) || 0,
      };
      _taxasCache.set(key, { at: Date.now(), payload });
      return res.json(payload);
    }
    const lista = await fetchPedidos(token, inicio, fim, 2);
    const validos = lista.filter(p => categorizePedido(p.situacao) !== 'cancelado');
    const loteDetalhes = await fetchPedidosDetalhados(token, validos);
    const porLoja = {};
    const produtos = {}; // agregação de itens vendidos, pra "top 5 mais vendidos"
    let comissao = 0, custoFrete = 0, freteCobrado = 0, valorBase = 0;
    let totalVenda = 0, totalProdutos = 0, desconto = 0, outrasDespesas = 0, valorLiquido = 0;
    for (const d of loteDetalhes.details) {
      try {
        const financeiro = normalizeBlingOrder(d);
        const lojaId = String(d.loja?.id || '0');
        const com = financeiro.marketplaceFee;
        const cf = financeiro.marketplaceShippingCost;
        const fc = financeiro.shippingCharged;
        const val = financeiro.salesBase;
        comissao += com;
        custoFrete += cf;
        freteCobrado += fc;
        valorBase += val;
        totalVenda += financeiro.customerTotal;
        totalProdutos += financeiro.productsTotal;
        desconto += financeiro.discount;
        outrasDespesas += financeiro.otherExpenses;
        valorLiquido += financeiro.marketplaceNet;
        if (!porLoja[lojaId]) porLoja[lojaId] = { lojaId, lojaNome: nomeLojaPedido(d), pedidos: 0, comissao: 0, custoFrete: 0, freteCobrado: 0, valor: 0 };
        const l = porLoja[lojaId];
        l.pedidos++; l.comissao += com; l.custoFrete += cf; l.freteCobrado += fc; l.valor += val;
        // Reaproveita a MESMA chamada de detalhe (já paga o custo de API) pra
        // agregar quantidade vendida por produto — evita uma segunda rodada
        // de requisições só pra montar o "top 5 mais vendidos".
        const itensPedido = Array.isArray(d.itens) ? d.itens : [];
        for (const it of itensPedido) {
          const codigo = it.codigo || it.produto?.codigo || '';
          const chave = codigo || (it.descricao || it.produto?.nome || 'Item');
          const qtd = Number(it.quantidade) || 0;
          const valorItem = (Number(it.valor) || 0) * qtd;
          if (!produtos[chave]) produtos[chave] = { codigo, nome: it.descricao || it.produto?.nome || 'Item', qtd: 0, faturamento: 0 };
          produtos[chave].qtd += qtd;
          produtos[chave].faturamento += valorItem;
        }
      } catch { /* um pedido inválido não bloqueia os demais */ }
    }
    const detalhados = loteDetalhes.details.length;
    const exata = loteDetalhes.exact;
    const payload = {
      schemaVersion: 1,
      periodo: { inicio, fim, period },
      totais: { comissao, custoFrete, freteCobrado, valorBase, totalVenda, totalProdutos, desconto, outrasDespesas, valorLiquido },
      estimativaPeriodo: {
        comissao, custoFrete, freteCobrado, valorBase, totalVenda,
        totalProdutos, desconto, outrasDespesas, valorLiquido,
        fator: 1, exata,
      },
      porLoja: Object.values(porLoja).sort((a, b) => b.valor - a.valor),
      topVendidos: Object.values(produtos).sort((a, b) => b.qtd - a.qtd).slice(0, 5),
      // A lista completa da amostra permite ao frontend cruzar cada SKU com
      // o custo cadastrado e calcular o CMV ponderado pelos itens realmente
      // vendidos. O fator sinaliza claramente quando há projeção do período.
      produtosVendidos: Object.values(produtos).sort((a, b) => b.faturamento - a.faturamento),
      amostra: detalhados, dePedidos: validos.length,
      falhas: loteDetalhes.failed,
    };
    _taxasCache.set(key, { at: Date.now(), payload });
    if (admin) {
      admin.firestore().collection('financeiro_periodos').doc(periodDocId).set({
        payload, cachedAt: Date.now(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(e => console.error('[financeiro cache] gravação:', e.message));
    }
    res.json(payload);
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, 500, 'Erro ao buscar taxas por canal', err.message);
  }
});

// Remove do objeto do produto (vindo de um GET do Bling) os campos
// computados/somente-leitura que não fazem parte do payload de escrita —
// reenviá-los num PUT arrisca o Bling rejeitar ou ignorar a atualização
// inteira silenciosamente. O estoque em especial é uma foto ANTIGA de
// quando os dados foram lidos (o saldo real é gerenciado à parte, pelo
// endpoint /estoques) — mandar de volta podia sobrescrever estoque real
// por um valor desatualizado.
function stripReadOnlyProdutoFields(obj) {
  const clean = { ...obj };
  delete clean.id;
  delete clean.estoque;
  delete clean.dataCriacao;
  delete clean.dataAlteracao;
  delete clean.imagem;
  return clean;
}

function getProductCusto(p) {
  if (!p) return 0;
  
  const rawFCusto = p.fornecedor?.precoCusto;
  const rawRCusto = p.precoCusto;
  
  const fCusto = rawFCusto !== undefined && rawFCusto !== null ? Number(rawFCusto) : null;
  const rCusto = rawRCusto !== undefined && rawRCusto !== null ? Number(rawRCusto) : null;
  
  if (p.fornecedor?.id && fCusto !== null && !isNaN(fCusto) && fCusto >= 0) {
    return fCusto;
  }
  if (rCusto !== null && !isNaN(rCusto) && rCusto >= 0) {
    return rCusto;
  }
  if (fCusto !== null && !isNaN(fCusto)) {
    return fCusto;
  }
  if (rCusto !== null && !isNaN(rCusto)) {
    return rCusto;
  }
  return 0;
}

app.put('/api/produtos/:id/fornecedor', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });
  try {
    const id = validateNumericId(req.params.id, 'ID do produto');
    const fornecedorId = validateNumericId(req.body?.fornecedorId, 'ID do fornecedor');
    const nome = String(req.body?.nome || '');
    const precoCusto = Math.max(0, Number(req.body?.precoCusto) || 0);
    const admin = getAdmin();
    let linkError = null;
    try {
      await axios.post('https://www.bling.com.br/Api/v3/produtos/fornecedores', {
        produto: { id }, fornecedor: { id: fornecedorId }, precoCusto, padrao: true,
      }, { headers: blingHeaders(token) });
    } catch (e) {
      linkError = e.response?.data?.error?.message || e.response?.data?.message || e.message;
      console.error('[fornecedor produto] Bling:', e.response?.data || e.message);
    }
    let verified = false;
    try {
      const { data } = await axios.get(`${BLING_API}/produtos/${id}`, { headers: blingHeaders(token) });
      const current = data?.data || {};
      verified = Number(current?.fornecedor?.id) === Number(fornecedorId);
      const savedCost = getProductCusto(current);
      if (verified && Math.abs(savedCost - precoCusto) > 0.005) linkError = `Fornecedor vinculado, mas o custo retornado foi R$ ${savedCost.toFixed(2)}`;
    } catch (verifyError) {
      linkError = linkError || verifyError.message;
    }
    if (admin) {
      await admin.firestore().collection('produto_overrides').doc(String(id)).set({
        fornecedor: { id: fornecedorId, nome }, precoCusto,
        blingLinked: verified, lastBlingError: verified ? null : String(linkError || 'O Bling não confirmou o vínculo'),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    res.json({
      success: verified,
      persisted: true,
      blingLinked: verified,
      fornecedor: { id: fornecedorId, nome }, precoCusto,
      warning: verified ? null : `Fornecedor salvo no sistema, mas o Bling não confirmou o vínculo: ${linkError || 'resposta sem fornecedor'}`,
    });
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    sendErrorResponse(res, 500, 'Erro ao fixar fornecedor', err.message);
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
      // O objeto _fullUpdate vem do editor, que carrega o produto INTEIRO do
      // Bling (GET) e devolve ele quase todo de volta no PUT — stripReadOnlyProdutoFields
      // remove os campos computados/somente-leitura (estoque agregado, timestamps,
      // id) que não fazem parte do payload de escrita e cujo reenvio é o risco
      // real de o Bling rejeitar ou ignorar a atualização inteira silenciosamente.
      // Converte imagemUrl (campo frontend) para o formato do Bling v3:
      // imagens ficam em midia.imagens.externas[].link ("imagem.link" não existe)
      const payload = stripReadOnlyProdutoFields(_fullUpdate);
      const keptImageUrls = Array.isArray(payload.imagemUrls)
        ? payload.imagemUrls.filter(Boolean)
        : (payload.imagemUrl ? [payload.imagemUrl] : null);
      if (payload.imagemUrls && Array.isArray(payload.imagemUrls)) {
        const externas = payload.imagemUrls.filter(Boolean).map(link => ({ link }));
        if (externas.length > 0) payload.midia = { imagens: { externas } };
        else payload.midia = { imagens: { externas: [] } };
        delete payload.imagemUrls;
      } else if (payload.imagemUrl !== undefined) {
        if (payload.imagemUrl) payload.midia = { imagens: { externas: [{ link: payload.imagemUrl }] } };
        delete payload.imagemUrl;
      }
      // Mesmo caso do branch de edição rápida: o custo em si tem que ir
      // dentro de fornecedor.precoCusto pro Bling aceitar a escrita.
      const custoAlvo = payload.precoCusto !== undefined ? Number(payload.precoCusto) : null;
      const fornecedorOriginal = payload.fornecedor || {};
      
      // GET-first to check if supplier is already linked in Bling
      const { data: current } = await axios.get(
        `https://www.bling.com.br/Api/v3/produtos/${id}`,
        { headers: blingHeaders(token) }
      );
      const currentProd = current?.data || {};
      const currentFornId = currentProd.fornecedor?.id;
      const targetFornId = fornecedorOriginal.id;

      // A associação de fornecedor precisa sobreviver mesmo quando o GET do
      // Bling omite o bloco fornecedor. Grava antes do PUT/verificação para
      // que uma resposta incompleta do Bling não faça a escolha desaparecer.
      const admin = getAdmin();
      if (admin && targetFornId) {
        await admin.firestore().collection('produto_overrides').doc(String(id)).set({
          fornecedor: { id: Number(targetFornId), nome: fornecedorOriginal.nome || '' },
          precoCusto: custoAlvo !== null ? custoAlvo : getProductCusto(currentProd),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      
      if (targetFornId && Number(targetFornId) !== Number(currentFornId)) {
        try {
          await axios.post('https://www.bling.com.br/Api/v3/produtos/fornecedores', {
            produto: { id: Number(id) },
            fornecedor: { id: Number(targetFornId) },
            precoCusto: custoAlvo !== null ? custoAlvo : 0,
            padrao: true
          }, { headers: blingHeaders(token) });
        } catch (linkErr) {
          console.error('[Link Supplier Error]', linkErr.response?.data || linkErr.message);
        }
      }

      if (payload.fornecedor === null || (payload.fornecedor && !payload.fornecedor.id)) {
        payload.fornecedor = null;
      } else if (custoAlvo !== null) {
        payload.fornecedor = { ...fornecedorOriginal, precoCusto: custoAlvo };
      }

      await axios.put(`https://www.bling.com.br/Api/v3/produtos/${id}`, payload, {
        headers: blingHeaders(token),
      });
      if (keptImageUrls) await prunePersistedProductImages(id, keptImageUrls);

      if (estoque !== undefined) {
        const depositoId = await getDepositoId(token);
        await axios.post('https://www.bling.com.br/Api/v3/estoques',
          { produto: { id: Number(id) }, deposito: { id: depositoId }, operacao: 'B', quantidade: Number(estoque) },
          { headers: blingHeaders(token) }
        );
      }
      // Não confia no 200 do PUT pro custo: relê e confirma que o Bling
      // realmente gravou, senão devolve erro específico e acionável em vez
      // de "sucesso" falso (ver mesmo padrão no branch de edição rápida).
      if (custoAlvo !== null) {
        const { data: verif } = await axios.get(
          `https://www.bling.com.br/Api/v3/produtos/${id}`,
          { headers: blingHeaders(token) }
        );
        const salvo = verif?.data || {};
        const custoSalvo = getProductCusto(salvo);
        if (custoSalvo === null || Math.abs(custoSalvo - custoAlvo) > 0.005) {
          const semFornecedor = !fornecedorOriginal.id;
          return sendErrorResponse(res, 502, 'Bling aceitou a requisição mas não gravou o custo', semFornecedor
            ? 'Este produto não tem um fornecedor vinculado no Bling. Cadastre um fornecedor para ele lá (Produto → Fornecedores) antes de editar o custo por aqui — é o Bling que exige isso para saber onde gravar o preço de custo.'
            : `O Bling devolveu ${custoSalvo === null ? 'nenhum valor' : `R$ ${custoSalvo.toFixed(2)}`} depois da gravação, em vez de R$ ${custoAlvo.toFixed(2)}.`);
        }
      }
      changeLog.push({
        id: changeLog.length + 1, produto_id: id,
        produto_nome: _fullUpdate.nome || `#${id}`, campo: 'edição completa',
        valor_anterior: '—', valor_novo: 'campos atualizados',
        timestamp: new Date().toISOString(),
      });
    saveInMemoryData();
      return res.json({ success: true });
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.response?.data || err.message;
      return sendErrorResponse(res, 500, 'Erro ao salvar produto', detail);
    }
  }

  try {
    if (preco !== undefined) {
      // Busca o produto completo antes de atualizar (Bling exige objeto completo no PUT).
      // stripReadOnlyProdutoFields remove estoque/id/timestamps computados do GET —
      // reenviá-los é o que fazia o Bling ignorar a atualização silenciosamente.
      const { data: current } = await axios.get(
        `https://www.bling.com.br/Api/v3/produtos/${id}`,
        { headers: blingHeaders(token) }
      );
      const prod = stripReadOnlyProdutoFields(current?.data || {});
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
    saveInMemoryData();
    }
    if (precoCusto !== undefined) {
      const { data: current } = await axios.get(
        `https://www.bling.com.br/Api/v3/produtos/${id}`,
        { headers: blingHeaders(token) }
      );
      const prod = stripReadOnlyProdutoFields(current?.data || {});
      const custoNum = Number(precoCusto);
      const fornecedorAtual = prod.fornecedor || {};
      // O Bling v3 guarda o custo em fornecedor.precoCusto — o campo
      // precoCusto solto na raiz é aceito na LEITURA (por isso o valor
      // aparece certo na lista), mas a ESCRITA (PUT) ignora silenciosamente
      // esse campo solto quando não vem dentro de "fornecedor". Manda nos
      // dois lugares.
      await axios.put(
        `https://www.bling.com.br/Api/v3/produtos/${id}`,
        { ...prod, precoCusto: custoNum, fornecedor: { ...fornecedorAtual, precoCusto: custoNum } },
        { headers: blingHeaders(token) }
      );
      // Não confia no 200 do PUT: o Bling pode aceitar a requisição e
      // ignorar o campo (ex.: produto sem fornecedor.id vinculado, então
      // não sabe em qual fornecedor gravar o custo). Relê o produto e só
      // reporta sucesso se o valor realmente mudou — caso contrário devolve
      // um erro específico e acionável em vez de um "sucesso" falso.
      const { data: verif } = await axios.get(
        `https://www.bling.com.br/Api/v3/produtos/${id}`,
        { headers: blingHeaders(token) }
      );
      const salvo = verif?.data || {};
      const custoSalvo = getProductCusto(salvo);
      if (custoSalvo === null || Math.abs(custoSalvo - custoNum) > 0.005) {
        const semFornecedor = !fornecedorAtual.id;
        return sendErrorResponse(res, 502, 'Bling aceitou a requisição mas não gravou o custo', semFornecedor
          ? 'Este produto não tem um fornecedor vinculado no Bling. Cadastre um fornecedor para ele lá (Produto → Fornecedores) antes de editar o custo por aqui — é o Bling que exige isso para saber onde gravar o preço de custo.'
          : `O Bling devolveu ${custoSalvo === null ? 'nenhum valor' : `R$ ${custoSalvo.toFixed(2)}`} depois da gravação, em vez de R$ ${custoNum.toFixed(2)}.`);
      }
      changeLog.push({
        id: changeLog.length + 1, produto_id: id,
        produto_nome: nome_produto || `#${id}`, campo: 'custo',
        valor_anterior: valor_anterior || '—',
        valor_novo: `R$ ${custoNum.toFixed(2)}`,
        timestamp: new Date().toISOString(),
      });
    saveInMemoryData();
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
    saveInMemoryData();
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
    saveInMemoryData();
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
    payload.codigo = prod.codigo ? `${prod.codigo}-COPIA${Date.now().toString().slice(-5)}` : `COPIA${Date.now().toString().slice(-5)}`;
    
    const cleanPayload = stripReadOnlyProdutoFields(payload);
    
    const { data: created } = await axios.post('https://www.bling.com.br/Api/v3/produtos', cleanPayload, { headers: blingHeaders(token) });
    changeLog.push({
      id: changeLog.length + 1, produto_id: created?.data?.id || '—',
      produto_nome: payload.nome, campo: 'duplicação',
      valor_anterior: `origem #${id}`, valor_novo: 'produto criado',
      timestamp: new Date().toISOString(),
    });
    saveInMemoryData();
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
  const depositoId = await getDepositoId(token);

  for (const p of produtos) {
    try {
      const id = Number(p.id);
      if (isNaN(id) || id <= 0) {
        errors.push({ id: p.id, nome: p.nome, error: 'ID do produto inválido' });
        continue;
      }

      // GET-first pattern for price & cost changes to prevent partial PUT side-effects
      if ((p.preco !== undefined && p.preco !== '') || (p.precoCusto !== undefined && p.precoCusto !== '')) {
        const { data } = await axios.get(`https://www.bling.com.br/Api/v3/produtos/${id}`, { headers: blingHeaders(token) });
        const prod = stripReadOnlyProdutoFields(data?.data || {});
        
        if (p.preco !== undefined && p.preco !== '') {
          prod.preco = Number(p.preco);
        }
        if (p.precoCusto !== undefined && p.precoCusto !== '') {
          const costoNum = Number(p.precoCusto);
          prod.precoCusto = costoNum;
          prod.fornecedor = prod.fornecedor || {};
          prod.fornecedor.precoCusto = costoNum;
        }

        await axios.put(`https://www.bling.com.br/Api/v3/produtos/${id}`, prod, { headers: blingHeaders(token) });
      }

      if (p.estoque !== undefined && p.estoque !== '') {
        await axios.post('https://www.bling.com.br/Api/v3/estoques',
          { produto: { id }, deposito: { id: depositoId }, operacao: 'B', quantidade: Number(p.estoque) },
          { headers: blingHeaders(token) }
        );
      }

      changeLog.push({
        id: Date.now() + Math.floor(Math.random() * 1000),
        produto_id: id,
        produto_nome: p.nome || `#${id}`,
        campo: 'importação CSV',
        valor_anterior: '—',
        valor_novo: `preço=${p.preco ?? '—'}, custo=${p.precoCusto ?? '—'}, estoque=${p.estoque ?? '—'}`,
        timestamp: new Date().toISOString(),
      });
      success++;
    } catch (err) {
      errors.push({ id: p.id, nome: p.nome, error: err.response?.data?.error?.message || err.message });
    }
  }

  saveInMemoryData(); // Save once after the loop
  res.json({ success, errors, total: produtos.length });
});

// ── Pedidos ──────────────────────────────────────────────────────────

app.get('/api/pedidos', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });

  try {
    await getBlingChannels(token).catch(() => ({}));
    const { inicio, fim } = req.query;
    let raw;
    if (inicio && fim) {
      raw = await fetchPedidos(token, inicio, fim, 100);
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
      // Igual ao "Total da venda" do Bling: base após desconto + frete cobrado.
      valor:     valorTotalPedido(p),
      valorBase: valorPedido(p),
      totalProdutos: normalizeBlingOrder(p).productsTotal,
      desconto: normalizeBlingOrder(p).discount,
      frete: normalizeBlingOrder(p).shippingCharged,
      situacao:  situacaoPT(p.situacao),
      contato:   p.contato?.nome || '—',
      // Canal de venda (nome da loja configurada no Bling — ex. "Mercado
      // Livre", "TikTok Shop"). Pode não vir na listagem em massa do Bling
      // (só confirmado no detalhe do pedido); nesse caso fica "—".
      canal:     nomeLojaPedido(p),
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
    await getBlingChannels(token).catch(() => ({}));
    const id = validateNumericId(req.params.id, 'ID do pedido');
    const p = await fetchPedidoDetalheCached(token, id);
    const itens = (Array.isArray(p.itens) ? p.itens : []).map(it => ({
      codigo:    it.codigo || it.produto?.codigo || '',
      descricao: it.descricao || it.produto?.nome || 'Item',
      qtd:       Number(it.quantidade) || 0,
      valor:     Number(it.valor) || 0,
      total:     (Number(it.quantidade) || 0) * (Number(it.valor) || 0),
    }));

    const financeiro = normalizeBlingOrder(p);
    res.json({
      id:          p.id,
      numero:      p.numero,
      data:        p.data,
      situacao:    situacaoPT(p.situacao),
      contato:     p.contato?.nome || '—',
      contatoDoc:  p.contato?.numeroDocumento || '',
      contatoTel:  p.contato?.celular || p.contato?.telefone || '',
      observacoes:         p.observacoes || '',
      observacoesInternas: p.observacoesInternas || '',
      total:            financeiro.customerTotal,
      totalVenda:       financeiro.customerTotal,
      valorBase:        financeiro.salesBase,
      valorLiquidoReceber: financeiro.marketplaceNet,
      totalProdutos:    financeiro.productsTotal,
      frete:            financeiro.shippingCharged,
      transportadora:   p.transporte?.transportadora?.nome || _TRANSP_TIPO[p.transporte?.tipo] || '',
      desconto:         financeiro.discount,
      outrasDespesas:   financeiro.otherExpenses,
      // Valores EXATOS que o Bling recebe do marketplace neste pedido —
      // sem estimativa: é o bloco `taxas` do próprio pedido.
      taxaComissao:     financeiro.marketplaceFee,
      taxaComissaoPercentual: financeiro.marketplaceFeePercent,
      custoFreteCanal:  financeiro.marketplaceShippingCost,
      custoFretePercentual: financeiro.marketplaceShippingPercent,
      totalTaxasPercentual: financeiro.totalMarketplacePercent,
      loja:             p.loja?.id || null,
      // Canal de venda (nome da loja configurada no Bling — ex.: "Mercado
      // Livre", "TikTok Shop"). Igual ao rótulo "Loja" que o próprio Bling
      // exibe no formulário do pedido.
      lojaNome:         nomeLojaPedido(p),
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
      situacao:    nfeSituacaoPT(n.situacao),
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
    // Total dos produtos: os campos de topo (totalProdutos/total/valor) vêm
    // vazios em boa parte das notas retornadas pelo Bling — a soma dos itens
    // (sempre presente e correta) é usada como valor garantido.
    const itensTotal = itens.reduce((a, it) => a + it.total, 0);
    // "naturezaOperacao" é um objeto relacional ({id, descricao}), igual a
    // contato/transportadora/loja em outros recursos do Bling — usar o
    // objeto direto como string produzia "[object Object]" na tela.
    const naturezaDesc = typeof n.naturezaOperacao === 'string'
      ? n.naturezaOperacao
      : (n.naturezaOperacao?.descricao || n.naturezaOperacao?.nome || '');
    res.json({
      id: n.id,
      numero: n.numero,
      serie: n.serie || '1',
      dataEmissao: n.dataEmissao || n.data || '',
      total: Number(n.totalProdutos) || Number(n.total) || Number(n.valor) || itensTotal,
      totalFrete: Number(n.totalFrete) || Number(n.valorFrete) || Number(n.transporte?.frete) || 0,
      totalDesconto: Number(n.totalDesconto) || Number(n.desconto) || 0,
      situacao: nfeSituacaoPT(n.situacao),
      chave: n.chaveAcesso || n.chave || '',
      contato: n.contato?.nome || '—',
      contatoDoc: n.contato?.numeroDocumento || '',
      natureza: naturezaDesc,
      modelo: n.modelo || '55',
      observacoes: n.observacoes || '',
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

// Edita uma NF-e. Assim como em pedidos, o Bling exige o objeto completo no
// PUT — buscamos a nota bruta e alteramos só os campos editados. Notas já
// autorizadas normalmente têm a maior parte dos campos travada por lei
// (usar carta de correção/cancelamento nesse caso); deixamos o Bling
// recusar com o motivo real em vez de bloquear no sistema por adivinhação.
app.put('/api/nfe/:id', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });
  try {
    const id = validateNumericId(req.params.id, 'ID da NF-e');
    const { observacoes, desconto, frete } = req.body || {};
    const { data } = await axios.get(`https://www.bling.com.br/Api/v3/nfe/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const raw = data?.data || data || {};
    if (observacoes !== undefined) raw.observacoes = observacoes;
    if (desconto !== undefined) raw.desconto = Number(desconto) || 0;
    if (frete !== undefined) {
      raw.transporte = raw.transporte || {};
      raw.transporte.frete = Number(frete) || 0;
    }
    await axios.put(`https://www.bling.com.br/Api/v3/nfe/${id}`, raw, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    const detail = err.response?.data?.error?.fields?.[0]?.msg
      || err.response?.data?.error?.message
      || err.message;
    sendErrorResponse(res, err.response?.status || 500, 'Erro ao atualizar NF-e', detail);
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
    custo: getProductCusto(p),
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
  if (!process.env.CRON_SECRET) return false;
  return req.headers['x-cron-secret'] === process.env.CRON_SECRET || req.query.secret === process.env.CRON_SECRET;
}

function validateBlingWebhookRequest(req) {
  const expected = process.env.BLING_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
  if (!expected) return false;
  const provided = req.headers['x-bling-secret']
    || req.headers['x-webhook-secret']
    || req.headers['authorization']?.replace(/^Bearer\s+/i, '')
    || req.query.secret;
  return !!provided && safeEqual(provided, expected);
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
    const dia = slot === 'manha' ? isoLocalDiasAtras(1) : isoLocal();
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
  } catch (e) { sendErrorResponse(res, 500, 'Erro ao gerar resumo no cron', e.message); }
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
  } catch (e) { sendErrorResponse(res, 500, 'Erro ao verificar alerta de estoque no cron', e.message); }
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
    all = await fetchBlingPaged(token, `contas/${tipo}`, {}, 100);
  } catch (e) {
    return { ok: false, total: 0, count: 0, vencidas: 0, vencidasValor: 0, itens: [], erro: e.response?.status || e.message };
  }
  const hoje = isoLocal();
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
    // Pedidos primeiro (duas chamadas simultâneas), contas depois. Isso evita
    // disparar quatro rajadas na mesma fração de segundo e receber 429.
    const prev = periodoAnterior(inicio, fim);
    const [pedRes, prevRes] = await Promise.allSettled([
      fetchPedidos(token, inicio, fim, 100),
      fetchPedidos(token, prev.inicio, prev.fim, 100),
    ]);
    const [receberRes] = await Promise.allSettled([fetchContas(token, 'receber')]);
    const [pagarRes] = await Promise.allSettled([fetchContas(token, 'pagar')]);

    if (pedRes.status === 'rejected') {
      if (pedRes.reason?.response?.status === 401) {
        res.clearCookie('bling_token');
        return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
      }
      throw pedRes.reason;
    }

    const allPedidos = pedRes.value || [];
    const valorOf = valorPedido;
    const concluidos = allPedidos.filter(p => categorize(p.situacao) === 'concluido');
    const pendentes  = allPedidos.filter(p => categorize(p.situacao) === 'pendente');
    const cancelados = allPedidos.filter(p => categorize(p.situacao) === 'cancelado');
    // "Pedidos feitos": a partir do momento em que o pedido existe no Bling
    // (a maioria vem de marketplaces que só criam o pedido após o pagamento
    // já ter sido confirmado pelo cliente), ele conta como faturamento real —
    // a única exclusão é cancelamento/devolução. Isso é mais amplo que só
    // "concluído" (que exigia situação de entrega/despacho).
    const feitos = allPedidos.filter(p => categorize(p.situacao) !== 'cancelado');
    const sum = (arr) => arr.reduce((a, p) => a + valorOf(p), 0);

    const faturamento = sum(feitos);
    const totalBruto  = sum(allPedidos);
    const aReceberPedidos = sum(pendentes);

    // Custos detalhados (frete, descontos) dos pedidos feitos
    const freteTotal = feitos.reduce((a, p) => a + normalizeBlingOrder(p).shippingCharged, 0);
    const descontoTotal = feitos.reduce((a, p) => a + orderDiscount(p), 0);

    // Comparativo de faturamento com o período anterior
    const prevPedidos = prevRes.status === 'fulfilled' ? (prevRes.value || []) : [];
    const prevFat = prevPedidos.filter(p => categorize(p.situacao) !== 'cancelado').reduce((a, p) => a + valorOf(p), 0);
    const variacao = prevFat > 0 ? ((faturamento - prevFat) / prevFat) * 100 : null;

    // Série diária (pedidos feitos) p/ mini-gráfico
    const byDay = {};
    feitos.forEach(p => {
      const day = String(p.data || p.dataPedido || '').substring(0, 10);
      if (day) byDay[day] = (byDay[day] || 0) + valorOf(p);
    });

    const receber = receberRes.status === 'fulfilled' ? receberRes.value : { ok: false, total: 0, count: 0, vencidas: 0, itens: [] };
    const pagar   = pagarRes.status === 'fulfilled' ? pagarRes.value : { ok: false, total: 0, count: 0, vencidas: 0, itens: [] };
    await loadPersistedData();
    const hoje = isoLocal();
    const mergeCustom = (base, tipos) => {
      const rows = customContas.filter(account => tipos.includes(account.tipo) && !['pago', 'recebido', 'cancelada'].includes(account.status));
      const itens = rows.map(account => ({ id: `custom_${account.id}`, valor: Number(account.valor) || 0, vencimento: account.dataVencimento, vencida: account.dataVencimento < hoje, contato: account.descricao, source: 'sistema' }));
      return {
        ...base,
        total: (Number(base.total) || 0) + itens.reduce((sum, item) => sum + item.valor, 0),
        count: (Number(base.count) || 0) + itens.length,
        vencidas: (Number(base.vencidas) || 0) + itens.filter(item => item.vencida).length,
        vencidasValor: (Number(base.vencidasValor) || 0) + itens.filter(item => item.vencida).reduce((sum, item) => sum + item.valor, 0),
        itens: [...(base.itens || []), ...itens].sort((a, b) => String(a.vencimento || '').localeCompare(String(b.vencimento || ''))).slice(0, 30),
        ok: Boolean(base.ok || itens.length),
      };
    };
    const receberIntegrado = mergeCustom(receber, ['receber']);
    const pagarIntegrado = mergeCustom(pagar, ['pagar', 'fixa']);

    res.json({
      periodo: { inicio, fim, period },
      vendas: {
        faturamento, totalBruto, aReceberPedidos,
        totalPedidos: allPedidos.length,
        concluidos: concluidos.length,
        feitos: feitos.length,
        pendentes: pendentes.length,
        cancelados: cancelados.length,
        ticketMedio: feitos.length ? faturamento / feitos.length : 0,
        variacao,
        byDay,
        freteTotal,
        descontoTotal,
      },
      contasReceber: receberIntegrado,
      contasPagar: pagarIntegrado,
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
    const isoHoje = isoLocal(), isoIni = isoLocalDiasAtras(90);

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

    // Cache de contatos do microsserviço pos-venda (mesmo Firestore) — enriquece
    // com e-mail/telefone/endereço quando o /contatos do Bling vier incompleto
    // (motivo original do pos-venda existir: nem todo contato tem e-mail cadastrado).
    const cachePromise = (async () => {
      const admin = getAdmin();
      if (!admin) return {};
      try {
        const snap = await admin.firestore().collection('customers').get();
        const map = {};
        snap.forEach(doc => { map[doc.id] = doc.data(); });
        return map;
      } catch {
        return {};
      }
    })();

    const [contatos, pedidos, cache] = await Promise.all([
      contatosPromise,
      fetchPedidos(token, isoIni, isoHoje, 3).catch(() => []),
      cachePromise,
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
      const docLimpo = String(c.numeroDocumento || '').replace(/\D+/g, '');
      const cached = cache[docLimpo];
      return {
        id: c.id,
        nome: c.nome || cached?.nome || 'Sem nome',
        documento: c.numeroDocumento || '',
        email: c.email || cached?.email || '',
        telefone: c.celular || c.telefone || c.fone || cached?.celular || cached?.telefone || '',
        endereco: end.endereco || cached?.endereco?.logradouro || '',
        numero: end.numero || cached?.endereco?.numero || '',
        bairro: end.bairro || cached?.endereco?.bairro || '',
        municipio: end.municipio || end.cidade || cached?.endereco?.municipio || '',
        uf: end.uf || end.estado || cached?.endereco?.uf || '',
        cep: end.cep || cached?.endereco?.cep || '',
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
    sendErrorResponse(res, 500, 'Erro ao buscar clientes', err.message);
  }
});

// ── Histórico ────────────────────────────────────────────────────

app.get('/api/historico', requireAuthJson, async (req, res) => {
  await loadPersistedData();
  res.json({ history: changeLog.slice().reverse().slice(0, 300) });
});

// ── Contas Customizadas (Despesas, Receitas, Controle de Caixa) ──────

app.get('/api/contas/custom', requireAuthJson, async (req, res) => {
  await loadPersistedData();
  const tipo = req.query.tipo; // 'pagar', 'receber', ou undefined para todas
  let filtered = customContas;
  if (tipo) filtered = filtered.filter(c => c.tipo === tipo);
  res.json({ contas: filtered });
});

const CONTA_FREQ_DIAS = { semanal: 7, quinzenal: 15, mensal: 30, anual: 365 };

app.post('/api/contas/custom', requireAuthJson, async (req, res) => {
  const { tipo, descricao, valor, dataVencimento, categoria, observacao, formaPagamento, parcelamento, frequencia, parcelas } = req.body;

  if (!tipo || !['pagar', 'receber', 'fixa'].includes(tipo)) {
    return sendErrorResponse(res, 400, 'Tipo inválido: use "pagar", "receber" ou "fixa"');
  }
  if (!descricao || !valor) {
    return sendErrorResponse(res, 400, 'Nome e valor são obrigatórios');
  }
  const valorNum = Number(valor);
  if (!(valorNum > 0)) return sendErrorResponse(res, 400, 'Valor deve ser maior que zero');

  const isParcelado = parcelamento === 'parcelado';
  const totalParcelas = isParcelado ? Math.max(1, Math.min(360, parseInt(parcelas, 10) || 1)) : 1;
  const passoDias = CONTA_FREQ_DIAS[frequencia] || 30;
  const grupoParcelamento = isParcelado && totalParcelas > 1 ? `grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : null;
  const baseData = dataVencimento || isoLocal();

  const criadas = [];
  for (let i = 0; i < totalParcelas; i++) {
    const id = contaIdCounter++;
    const venc = new Date(`${baseData}T12:00:00`);
    venc.setDate(venc.getDate() + passoDias * i);
    const conta = {
      id,
      tipo,
      descricao,
      valor: valorNum,
      dataVencimento: isNaN(venc.getTime()) ? baseData : venc.toISOString().slice(0, 10),
      categoria: categoria || 'Outras',
      observacao: observacao || '',
      formaPagamento: formaPagamento || '',
      parcelamento: isParcelado ? 'parcelado' : 'avista',
      frequencia: isParcelado ? (frequencia || 'mensal') : null,
      parcelaAtual: isParcelado ? i + 1 : null,
      parcelaTotal: isParcelado ? totalParcelas : null,
      grupoParcelamento,
      status: 'pendente',
      criada_em: new Date().toISOString(),
      atualizada_em: new Date().toISOString(),
    };
    customContas.push(conta);
    criadas.push(conta);
  }
  saveInMemoryData();
  const admin = getAdmin();
  if (admin) {
    const batch = admin.firestore().batch();
    criadas.forEach(conta => batch.set(admin.firestore().collection('finance_accounts').doc(String(conta.id)), conta));
    await batch.commit();
  }
  changeLog.push({
    id: changeLog.length + 1,
    produto_id: `conta_${criadas[0].id}`,
    produto_nome: descricao,
    campo: `conta ${tipo}`,
    valor_anterior: '—',
    valor_novo: `${tipo === 'pagar' ? '-' : tipo === 'receber' ? '+' : '±'}R$ ${valorNum}${totalParcelas > 1 ? ` × ${totalParcelas}` : ''}`,
    timestamp: new Date().toISOString(),
  });
  saveInMemoryData();

  res.json(totalParcelas > 1 ? { contas: criadas } : criadas[0]);
});

app.put('/api/contas/custom/:id', requireAuthJson, async (req, res) => {
  try {
    const id = validateNumericId(req.params.id, 'ID da conta');
    const conta = customContas.find(c => c.id === id);

    if (!conta) return res.status(404).json({ error: 'Conta não encontrada' });

    const { descricao, valor, dataVencimento, categoria, observacao, status, formaPagamento, tipo } = req.body;

    if (descricao) conta.descricao = descricao;
    if (valor !== undefined) conta.valor = Number(valor);
    if (dataVencimento) conta.dataVencimento = dataVencimento;
    if (categoria) conta.categoria = categoria;
    if (observacao !== undefined) conta.observacao = observacao;
    if (status) conta.status = status;
    if (formaPagamento !== undefined) conta.formaPagamento = formaPagamento;
    if (tipo && ['pagar', 'receber', 'fixa'].includes(tipo)) conta.tipo = tipo;

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
    saveInMemoryData();
    const admin = getAdmin();
    if (admin) await admin.firestore().collection('finance_accounts').doc(String(id)).set(conta, { merge: true });

    res.json(conta);
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    sendErrorResponse(res, 500, 'Erro ao atualizar conta', err.message);
  }
});

app.delete('/api/contas/custom/:id', requireAuthJson, async (req, res) => {
  try {
    const id = validateNumericId(req.params.id, 'ID da conta');
    const idx = customContas.findIndex(c => c.id === id);

    if (idx === -1) return res.status(404).json({ error: 'Conta não encontrada' });

    const conta = customContas[idx];
    customContas.splice(idx, 1);
    saveInMemoryData();
    const admin = getAdmin();
    if (admin) await admin.firestore().collection('finance_accounts').doc(String(id)).delete();

    changeLog.push({
      id: changeLog.length + 1,
      produto_id: `conta_${id}`,
      produto_nome: conta.descricao,
      campo: 'exclusão de conta',
      valor_anterior: conta.status,
      valor_novo: 'excluída',
      timestamp: new Date().toISOString(),
    });
    saveInMemoryData();

    res.json({ success: true });
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    sendErrorResponse(res, 500, 'Erro ao deletar conta', err.message);
  }
});

// ── Calendário (Eventos, Feriados, Datas Importantes) ──────────────────

app.get('/api/calendario', requireAuthJson, async (req, res) => {
  await loadPersistedData();
  const mes = req.query.mes; // filtrar por mês (YYYY-MM)
  let filtered = calendarEvents;
  if (mes) filtered = filtered.filter(e => e.data.startsWith(mes));
  res.json({ eventos: filtered });
});

app.post('/api/calendario', requireAuthJson, (req, res) => {
  const { tipo, titulo, descricao, data, hora, contaId } = req.body;

  if (!tipo || !['feriado', 'comemorativo', 'vencimento', 'recebimento', 'evento', 'tarefa'].includes(tipo)) {
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
    hora: hora || '',
    contaId: contaId || null,
    status: tipo === 'tarefa' ? 'pendente' : null,
    criado_em: new Date().toISOString(),
  };

  calendarEvents.push(evento);
    saveInMemoryData();
  res.json(evento);
});

app.put('/api/calendario/:id', requireAuthJson, (req, res) => {
  try {
    const id = validateNumericId(req.params.id, 'ID do evento');
    const evento = calendarEvents.find(e => e.id === id);
    if (!evento) return res.status(404).json({ error: 'Evento não encontrado' });

    const { titulo, descricao, data, hora, status } = req.body;
    if (titulo) evento.titulo = titulo;
    if (descricao !== undefined) evento.descricao = descricao;
    if (data) evento.data = data;
    if (hora !== undefined) evento.hora = hora;
    if (status) evento.status = status;
    evento.atualizado_em = new Date().toISOString();

    saveInMemoryData();
    res.json(evento);
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    sendErrorResponse(res, 500, 'Erro ao atualizar evento', err.message);
  }
});

app.delete('/api/calendario/:id', requireAuthJson, (req, res) => {
  try {
    const id = validateNumericId(req.params.id, 'ID do evento');
    const idx = calendarEvents.findIndex(e => e.id === id);

    if (idx === -1) return res.status(404).json({ error: 'Evento não encontrado' });

    calendarEvents.splice(idx, 1);
    saveInMemoryData();
    res.json({ success: true });
  } catch (err) {
    if (err.statusCode === 400) return sendErrorResponse(res, 400, err.message);
    sendErrorResponse(res, 500, 'Erro ao deletar evento', err.message);
  }
});

// ── Webhook (Bling notificações) ──────────────────────────────────────

app.post('/api/webhook/bling', async (req, res) => {
  if (!validateBlingWebhookRequest(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ received: true }); // responde rápido (Bling espera 200)
  try {
    const admin = getAdmin();
    if (!admin) return;
    const evt = req.body || {};
    await recordAudit({
      type: 'webhook.bling_received',
      actor: 'bling',
      source: 'webhook',
      detail: String(evt.event || evt.tipo || evt.type || evt.data?.tipo || 'evento-desconhecido'),
    });
    const tipo = String(evt.event || evt.tipo || evt.type || evt.data?.tipo || '').toLowerCase();
    let title, body;
    if (tipo.includes('order') || tipo.includes('pedido') || tipo.includes('venda')) {
      const pedidoId = evt.data?.id || evt.data?.pedido?.id || evt.id;
      if (pedidoId) {
        _pedidoDetalheCache.delete(String(pedidoId));
        _taxasCache.clear();
        admin.firestore().collection('bling_pedido_detalhes').doc(String(pedidoId)).delete().catch(() => {});
        const webhookOrder = evt.data?.pedido || evt.data || {};
        const webhookItems = Array.isArray(webhookOrder.itens) ? webhookOrder.itens : [];
        if (webhookItems.length) {
          const costBySku = {};
          webhookItems.forEach(item => {
            const sku = normalizeSku(item.codigo || item.produto?.codigo);
            if (sku) costBySku[sku] = { cost: Number(item.precoCompra || item.produto?.precoCompra || 0), productId: item.produto?.id || null };
          });
          const fact = buildSalesFact(webhookOrder, {
            costBySku, channelById: _channelCache.map,
            status: situacaoPT(webhookOrder.situacao), statusCategory: categorizePedido(webhookOrder.situacao),
          });
          fact.syncedAt = new Date().toISOString();
          admin.firestore().collection('sales_ledger').doc(String(pedidoId)).set(fact, { merge: true }).catch(() => {});
        } else {
          admin.firestore().collection('sync_queue').doc(`order_${pedidoId}`).set({ type: 'order', id: String(pedidoId), status: 'pending', createdAt: Date.now() }, { merge: true }).catch(() => {});
        }
      }
      title = '🛒 Novo pedido!';
      body = 'Um novo pedido foi registrado no Bling. Toque para ver.';
    } else if (tipo.includes('produto') || tipo.includes('estoque') || tipo.includes('stock')) {
      const product = evt.data?.produto || evt.data || {};
      const sku = normalizeSku(product.codigo || product.sku);
      const balance = Number(product.estoque?.saldoVirtualTotal ?? product.saldoVirtualTotal ?? product.estoque ?? product.saldo);
      if (sku && Number.isFinite(balance)) {
        const skuKey = crypto.createHash('sha256').update(sku).digest('hex').slice(0, 32);
        const mapping = await admin.firestore().collection('ml_sku_map').doc(skuKey).get();
        const ml = await ensureMLToken();
        if (mapping.exists && ml?.token) {
          await Promise.allSettled((mapping.data().itemIds || []).map(itemId => axios.put(
            `https://api.mercadolibre.com/items/${itemId}`,
            { available_quantity: Math.max(0, balance) },
            { headers: mlHeaders(ml.token) }
          )));
        }
      }
      title = '📦 Estoque sincronizado';
      body = sku ? `O saldo do SKU ${sku} foi atualizado nos canais vinculados.` : 'Um produto teve o estoque atualizado no Bling.';
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
      valor:      valorTotalPedido(p),
      valorBase:  valorPedido(p),
      situacao:   situacaoPT(p.situacao),
      contato:    p.contato?.nome || '—',
      status:     p.situacao?.valor || p.situacao,
      frete:      normalizeBlingOrder(p).shippingCharged,
      desconto:   orderDiscount(p),
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
      const { data } = await axios.get('https://www.bling.com.br/Api/v3/nfe', {
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
      situacao:   nfeSituacaoPT(n.situacao),
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
    const valorOf = valorPedido;
    const concluidos = allPedidos.filter(p => categorizePedido(p.situacao) === 'concluido');
    const pendentes = allPedidos.filter(p => categorizePedido(p.situacao) === 'pendente');
    const cancelados = allPedidos.filter(p => categorizePedido(p.situacao) === 'cancelado');

    const receber = receberRes.status === 'fulfilled' ? receberRes.value : { total: 0, count: 0, vencidas: 0 };
    const pagar = pagarRes.status === 'fulfilled' ? pagarRes.value : { total: 0, count: 0, vencidas: 0 };
    const produtos = prodRes.status === 'fulfilled' ? prodRes.value : { margem: 0, zerados: 0, criticos: 0 };

    const sum = arr => arr.reduce((a, p) => a + valorOf(p), 0);
    const faturamento = sum(concluidos);

    const hasCusto = concluidos.some(p => p.totalCusto !== undefined && Number(p.totalCusto) > 0);
    const margem = hasCusto 
      ? concluidos.reduce((a, p) => a + ((Number(p.totalProdutos) || 0) - (Number(p.totalCusto) || 0)), 0)
      : faturamento * (produtos.margem || 0);

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

// ── Integração Mercado Livre Avançada ────────────────────────────────
app.get('/api/ml/pedidos', requireAuthJson, async (req, res) => {
  const ml = await ensureMLToken();
  if (!ml?.token) return res.status(401).json({ error: 'ML não conectado', code: 'ML_NOT_CONNECTED' });
  try {
    const from = new Date(); from.setDate(from.getDate() - 30);
    const fromStr = from.toISOString();
    const orders = await fetchMLOrders(ml, fromStr, 1000);
    res.json(orders);
  } catch (err) {
    sendErrorResponse(res, 500, 'Erro ao buscar pedidos do Mercado Livre', err.message);
  }
});

app.get('/api/ml/dashboard', requireAuthJson, async (req, res) => {
  const ml = await ensureMLToken();
  if (!ml?.token) return res.status(401).json({ error: 'ML não conectado', code: 'ML_NOT_CONNECTED' });

  const days = parseInt(req.query.period) || 30;
  const from = new Date(); from.setDate(from.getDate() - days);
  const fromStr = from.toISOString();

  try {
    const orders = await fetchMLOrders(ml, fromStr, 1000);
    const blingToken = await getCronBlingToken();
    const costBySku = blingToken ? await loadProductCostCatalog(blingToken).catch(() => ({})) : {};

    let faturamento = 0;
    let taxas = 0;
    let frete = 0;
    let cmv = 0;
    let itensSemCusto = 0;
    let concluidoCount = 0;
    let canceladoCount = 0;
    const byDay = {};

    orders.forEach(o => {
      if (o.status === 'cancelled') { canceladoCount++; return; }
      if (o.status === 'paid' || o.status === 'closed' || o.status === 'delivered' || o.status === 'shipped') {
        concluidoCount++;
        faturamento += o.total_amount || 0;
        // Comissão do ML fica em order_items[].sale_fee (por unidade)
        (o.order_items || []).forEach(it => {
          const qty = Number(it.quantity) || 0;
          taxas += (it.sale_fee || 0) * qty;
          const sku = normalizeSku(it.item?.seller_sku || it.item?.seller_custom_field || it.seller_sku);
          const cost = Number(costBySku[sku]?.cost) || 0;
          if (!sku || !(cost > 0)) itensSemCusto += qty;
          cmv += cost * qty;
        });
        // Frete cobrado do comprador fica em payments[].shipping_cost
        (o.payments || []).forEach(p => { frete += p.shipping_cost || 0; });
        const day = String(o.date_created || '').substring(0, 10);
        if (day) byDay[day] = (byDay[day] || 0) + (o.total_amount || 0);
      }
    });

    res.json({
      periodo: days,
      faturamento,
      taxas,
      frete,
      cmv,
      lucroBruto: faturamento - taxas - cmv,
      lucroReal: faturamento - taxas - frete - cmv,
      itensSemCusto,
      custosCompletos: itensSemCusto === 0,
      pedidosConcluidos: concluidoCount,
      pedidosCancelados: canceladoCount,
      totalPedidos: orders.length,
      ticketMedio: concluidoCount ? faturamento / concluidoCount : 0,
      byDay,
    });
  } catch (err) {
    sendErrorResponse(res, 500, 'Erro ao montar painel do Mercado Livre', err.message);
  }
});

app.get('/api/cron/sync-vendas', async (req, res) => {
  if (!checkCronSecret(req)) return res.status(401).json({ error: 'unauthorized' });
  const token = await getCronBlingToken();
  if (!token) return res.json({ ok: true, skipped: 'Bling não conectado' });
  try { res.json({ ok: true, ...(await syncSalesLedger(token, { inicio: isoLocalDiasAtras(365), fim: isoLocal(), limit: 120 })) }); }
  catch (err) { sendErrorResponse(res, 500, 'Erro no sincronismo de vendas', err.message); }
});

app.get('/api/cron/sync-estoque', async (req, res) => {
  if (!checkCronSecret(req)) return res.status(401).json({ error: 'unauthorized' });
  const [token, ml] = await Promise.all([getCronBlingToken(), ensureMLToken()]);
  if (!token || !ml?.token) return res.json({ ok: true, skipped: 'Bling ou Mercado Livre não conectado' });
  try { res.json({ ok: true, ...(await reconcileMLStock(token, ml)) }); }
  catch (err) { sendErrorResponse(res, 500, 'Erro no sincronismo de estoque', err.message); }
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
    loadPersistedData();
  });
}

module.exports = app;
