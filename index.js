require('dotenv').config();
const express = require('express');
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
let _fbAdminProjectId = null; // exposto em /api/diagnostico p/ conferir se bate com o projeto do login.html
let _fbAdminInitError = null;
function getAdmin() {
  if (_fbAdmin) return _fbAdmin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const admin = require('firebase-admin');
    const cred = JSON.parse(raw);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(cred) });
    }
    _fbAdminProjectId = cred.project_id || null;
    // Erro "5 NOT_FOUND" no ping = o banco "(default)" não existe no projeto.
    // Acontece quando o banco foi criado com ID personalizado no console.
    // FIRESTORE_DB_ID permite apontar para esse banco nomeado sem recriar:
    // redirecionamos admin.firestore() para o banco certo, preservando
    // FieldValue/Timestamp usados no resto do código.
    const dbId = process.env.FIRESTORE_DB_ID;
    if (dbId && dbId !== '(default)') {
      const { getFirestore } = require('firebase-admin/firestore');
      const namedDb = getFirestore(admin.app(), dbId);
      const orig = admin.firestore;
      const patched = () => namedDb;
      patched.FieldValue = orig.FieldValue;
      patched.Timestamp = orig.Timestamp;
      patched.GeoPoint = orig.GeoPoint;
      admin.firestore = patched;
      console.log(`[Firestore] usando banco nomeado "${dbId}" (FIRESTORE_DB_ID)`);
    }
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
let changeLog = [];

// Contas customizadas e eventos de calendário: cache em memória com
// persistência no Firestore (quando FIREBASE_SERVICE_ACCOUNT configurado).
// Sem Firestore, funcionam em memória e se perdem no restart — comportamento
// anterior preservado como fallback.
let customContas = [];
let contaIdCounter = 1;
let calendarEvents = [];
let eventIdCounter = 1;
let _persistLoaded = false;

async function loadPersistedData() {
  if (_persistLoaded) return;
  _persistLoaded = true;
  const admin = getAdmin();
  if (!admin) return;
  try {
    const doc = await admin.firestore().collection('app_state').doc('data').get();
    if (!doc.exists) return;
    const d = doc.data() || {};
    if (Array.isArray(d.customContas)) customContas = d.customContas;
    if (Array.isArray(d.calendarEvents)) calendarEvents = d.calendarEvents;
    if (Array.isArray(d.changeLog)) changeLog = d.changeLog;
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
      updatedAt: new Date().toISOString(),
    }).catch(e => console.error('[saveInMemoryData]', e.message));
  }, 1500);
}

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

app.get('/login', (req, res) => { noCache(res); res.sendFile(__dirname + '/public/login.html'); });
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

app.get('/api/auth/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
  if (!code) return res.redirect('/?error=no_code');
  if (state !== 'estoque_max') return res.redirect('/?error=invalid_state');

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

// Edita preço e/ou estoque de um anúncio e MANDA a alteração de volta para
// o Mercado Livre (PUT /items/:id) — até aqui só existia leitura de
// anúncios; não havia como editar e enviar dados para o ML, só para o Bling.
app.patch('/api/ml/anuncios/:id', requireAuthJson, async (req, res) => {
  const ml = await ensureMLToken();
  if (!ml?.token) return res.status(401).json({ error: 'ML não conectado', code: 'ML_NOT_CONNECTED' });
  const { preco, estoque, titulo_produto } = req.body || {};
  if (preco === undefined && estoque === undefined) {
    return res.status(400).json({ error: 'Informe preco e/ou estoque' });
  }
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
  try {
    const { data } = await axios.put(`https://api.mercadolibre.com/items/${req.params.id}`, payload, { headers: mlHeaders(ml.token) });
    changeLog.push({
      id: changeLog.length + 1, produto_id: `ml_${req.params.id}`,
      produto_nome: titulo_produto || req.params.id, campo: 'Mercado Livre',
      valor_anterior: '—',
      valor_novo: [preco !== undefined ? `preço R$ ${Number(preco).toFixed(2)}` : null, estoque !== undefined ? `${Number(estoque)} un.` : null].filter(Boolean).join(' · '),
      timestamp: new Date().toISOString(),
    });
    saveInMemoryData();
    res.json({ success: true, item: { id: data.id, price: data.price, available_quantity: data.available_quantity } });
  } catch (err) {
    // A API do ML retorna o motivo da rejeição em cause[] (ex: preço abaixo do mínimo, item pausado etc.)
    const detail = err.response?.data?.cause?.[0]?.message || err.response?.data?.message || err.message;
    sendErrorResponse(res, err.response?.status || 500, 'Erro ao atualizar anúncio no Mercado Livre', detail);
  }
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
      situacao:   String((typeof p.situacao === 'object' ? (p.situacao?.valor || p.situacao?.nome) : p.situacao) || 'A'),
      // A listagem do Bling v3 traz a miniatura em `imagemURL`; o detalhe traz
      // `midia.imagens.{internas,externas}[].link`. Os campos antigos
      // (imagem.link / imageThumbnailURL) NÃO existem — por isso todos os
      // produtos apareciam com placeholder mesmo tendo foto no Bling.
      imagemUrl:  p.imagemURL
               || p.midia?.imagens?.internas?.[0]?.link
               || p.midia?.imagens?.externas?.[0]?.link
               || p.imagem?.link || '',
    }));

    // Imagens enviadas pelo próprio painel têm prioridade (aparecem na hora,
    // sem esperar o Bling processar a URL externa). Só os metadados são
    // lidos (select) — o base64 pesado fica fora desta consulta.
    const admin = getAdmin();
    if (admin) {
      try {
        const snap = await admin.firestore().collection('produto_imagens').select('updatedAt').get();
        const overrides = new Map(snap.docs.map(d => [d.id, d.updateTime?.toMillis() || Date.now()]));
        if (overrides.size) {
          const base = `${req.protocol}://${req.get('host')}`;
          for (const prod of products) {
            const v = overrides.get(String(prod.id));
            if (v) prod.imagemUrl = `${base}/img/produto/${prod.id}?v=${v}`;
          }
        }
      } catch (e) { console.error('[produtos] override de imagens:', e.message); }
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
    const body = { ...req.body };
    if (body.imagemUrl) { body.midia = { imagens: { externas: [{ link: body.imagemUrl }] } }; delete body.imagemUrl; }
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
    const m = String(req.body?.dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return res.status(400).json({ error: 'Envie um dataURL de imagem JPG, PNG ou WEBP' });
    const [, mime, b64] = m;
    // Firestore limita o documento a ~1MB — o front comprime bem abaixo disso
    if (b64.length > 950_000) return res.status(413).json({ error: 'Imagem grande demais mesmo após compressão (máx ~700KB)' });
    await admin.firestore().collection('produto_imagens').doc(String(produtoId)).set({
      data: b64, mime, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // URL pública (com cache-buster) que o navegador e o Bling vão usar
    const url = `${req.protocol}://${req.get('host')}/img/produto/${produtoId}?v=${Date.now()}`;
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
    if (!isValidNumericId(req.params.id)) return res.status(400).end();
    const doc = await admin.firestore().collection('produto_imagens').doc(String(req.params.id)).get();
    if (!doc.exists) return res.status(404).end();
    const { data, mime } = doc.data();
    res.set('Content-Type', mime || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(data, 'base64'));
  } catch { res.status(500).end(); }
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
  const n = situacaoPT(s).toLowerCase();
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
    // Bling retorna frete aninhado em transporte.frete (não como campo
    // plano) — ler o caminho errado aqui fazia o total de frete ficar
    // sempre zero, mesmo com pedidos tendo frete cobrado de verdade.
    const totalFrete       = sum(allPedidos, p => Number(p.transporte?.frete) || Number(p.transporte?.valorFrete) || Number(p.frete) || 0);
    const totalDesconto    = sum(allPedidos, p => Number(p.desconto) || Number(p.descontoValor) || 0);

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

// ── Taxas reais por canal (comissão + custo de frete dos marketplaces) ──
// A LISTAGEM de pedidos do Bling não traz o bloco `taxas` — ele só vem no
// DETALHE (GET /pedidos/vendas/{id}): { taxaComissao, custoFrete, valorBase }.
// Buscar o detalhe de todos os pedidos estouraria o rate-limit, então
// amostramos os mais recentes, agregamos por loja/canal e guardamos em
// cache por 10 minutos.
const TAXAS_AMOSTRA_MAX = 12; // 12 × ~350ms de espaçamento ≈ 4s (cabe no timeout da Vercel)
const _taxasCache = new Map();
app.get('/api/financeiro/taxas', requireAuthJson, async (req, res) => {
  const token = await ensureBlingToken(req, res);
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });
  const { inicio, fim, period } = resolvePeriodo(req.query.period, req.query.startDate, req.query.endDate);
  const key = `${inicio}|${fim}`;
  const hit = _taxasCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60000 && !req.query.force) return res.json(hit.payload);
  try {
    const lista = await fetchPedidos(token, inicio, fim, 2);
    const validos = lista.filter(p => categorizePedido(p.situacao) !== 'cancelado');
    const amostra = validos.slice(0, TAXAS_AMOSTRA_MAX);
    const porLoja = {};
    const produtos = {}; // agregação de itens vendidos, pra "top 5 mais vendidos"
    let comissao = 0, custoFrete = 0, freteCobrado = 0, valorAmostrado = 0, detalhados = 0;
    for (const p of amostra) {
      try {
        const { data } = await axios.get(`https://www.bling.com.br/Api/v3/pedidos/vendas/${p.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = data?.data || data || {};
        const tx = d.taxas || {};
        const lojaId = String(d.loja?.id || p.loja?.id || '0');
        const com = Number(tx.taxaComissao) || 0;
        const cf = Number(tx.custoFrete) || 0;
        const fc = Number(d.transporte?.frete) || Number(d.transporte?.valorFrete) || 0;
        const val = valorPedido(d) || valorPedido(p) || 0;
        comissao += com; custoFrete += cf; freteCobrado += fc; valorAmostrado += val; detalhados++;
        if (!porLoja[lojaId]) porLoja[lojaId] = { lojaId, pedidos: 0, comissao: 0, custoFrete: 0, freteCobrado: 0, valor: 0 };
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
      } catch { /* um pedido falhou; os demais seguem */ }
    }
    // Projeção: se só uma amostra foi detalhada, extrapola para o período
    // inteiro proporcionalmente ao VALOR vendido (taxas escalam com valor).
    const valorTotalPeriodo = validos.reduce((a, p) => a + (valorPedido(p) || 0), 0);
    const fator = (valorAmostrado > 0 && valorTotalPeriodo > valorAmostrado) ? valorTotalPeriodo / valorAmostrado : 1;
    const payload = {
      periodo: { inicio, fim, period },
      totais: { comissao, custoFrete, freteCobrado },
      estimativaPeriodo: {
        comissao: comissao * fator, custoFrete: custoFrete * fator,
        fator, exata: fator === 1,
      },
      porLoja: Object.values(porLoja).sort((a, b) => b.valor - a.valor),
      topVendidos: Object.values(produtos).sort((a, b) => b.qtd - a.qtd).slice(0, 5),
      amostra: detalhados, dePedidos: validos.length,
    };
    _taxasCache.set(key, { at: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, 500, 'Erro ao buscar taxas por canal', err.message);
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
      // Converte imagemUrl (campo frontend) para o formato do Bling v3:
      // imagens ficam em midia.imagens.externas[].link ("imagem.link" não existe)
      const payload = { ..._fullUpdate };
      if (payload.imagemUrl !== undefined) {
        if (payload.imagemUrl) payload.midia = { imagens: { externas: [{ link: payload.imagemUrl }] } };
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
    saveInMemoryData();
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
    saveInMemoryData();
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
    payload.codigo = prod.codigo ? `${prod.codigo}-COPIA${Date.now().toString().slice(-5)}` : undefined;
    const { data: created } = await axios.post('https://www.bling.com.br/Api/v3/produtos', payload, { headers: blingHeaders(token) });
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
    saveInMemoryData();
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
      situacao:  situacaoPT(p.situacao),
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
      situacao:    situacaoPT(p.situacao),
      contato:     p.contato?.nome || '—',
      contatoDoc:  p.contato?.numeroDocumento || '',
      contatoTel:  p.contato?.celular || p.contato?.telefone || '',
      observacoes: p.observacoes || p.observacoesInternas || '',
      total:       Number(p.totalProdutos) || Number(p.totalVenda) || Number(p.total) || 0,
      frete:            Number(p.transporte?.frete) || Number(p.transporte?.valorFrete) || 0,
      transportadora:   p.transporte?.transportadora?.nome || _TRANSP_TIPO[p.transporte?.tipo] || '',
      desconto:         Number(p.desconto) || 0,
      // Valores EXATOS que o Bling recebe do marketplace neste pedido —
      // sem estimativa: é o bloco `taxas` do próprio pedido.
      taxaComissao:     Number(p.taxas?.taxaComissao) || 0,
      custoFreteCanal:  Number(p.taxas?.custoFrete) || 0,
      loja:             p.loja?.id || null,
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
    res.json({
      id: n.id,
      numero: n.numero,
      serie: n.serie || '1',
      dataEmissao: n.dataEmissao || n.data || '',
      total: n.totalProdutos || n.total || n.valor || 0,
      totalFrete: Number(n.totalFrete || 0),
      totalDesconto: Number(n.totalDesconto || 0),
      situacao: nfeSituacaoPT(n.situacao),
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
    res.status(500).json({ error: 'Erro ao buscar clientes', detail: err.message });
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
    dataVencimento: dataVencimento || isoLocal(),
    categoria: categoria || 'Outras',
    observacao: observacao || '',
    status: 'pendente',
    criada_em: new Date().toISOString(),
    atualizada_em: new Date().toISOString(),
  };

  customContas.push(conta);
    saveInMemoryData();
  changeLog.push({
    id: changeLog.length + 1,
    produto_id: `conta_${id}`,
    produto_nome: descricao,
    campo: `conta ${tipo}`,
    valor_anterior: '—',
    valor_novo: `${tipo === 'pagar' ? '-' : '+'}R$ ${valor}`,
    timestamp: new Date().toISOString(),
  });
    saveInMemoryData();

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
    saveInMemoryData();

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
    saveInMemoryData();

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
    saveInMemoryData();
  res.json(evento);
});

app.delete('/api/calendario/:id', requireAuthJson, (req, res) => {
  try {
    const id = Number(req.params.id);
    const idx = calendarEvents.findIndex(e => e.id === id);

    if (idx === -1) return res.status(404).json({ error: 'Evento não encontrado' });

    calendarEvents.splice(idx, 1);
    saveInMemoryData();
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
      situacao:   situacaoPT(p.situacao),
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

// ── Integração Mercado Livre Avançada ────────────────────────────────
app.get('/api/ml/pedidos', requireAuthJson, async (req, res) => {
  const ml = await ensureMLToken();
  if (!ml?.token) return res.status(401).json({ error: 'ML não conectado', code: 'ML_NOT_CONNECTED' });
  try {
    const from = new Date(); from.setDate(from.getDate() - 30);
    const fromStr = from.toISOString();
    // Buscar ordens recentes
    const { data: orders } = await axios.get(`https://api.mercadolibre.com/orders/search?seller=${ml.sellerId}&order.date_created.from=${encodeURIComponent(fromStr)}`, { headers: mlHeaders(ml.token) });
    res.json(orders.results || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ml/dashboard', requireAuthJson, async (req, res) => {
  const ml = await ensureMLToken();
  if (!ml?.token) return res.status(401).json({ error: 'ML não conectado', code: 'ML_NOT_CONNECTED' });

  const days = parseInt(req.query.period) || 30;
  const from = new Date(); from.setDate(from.getDate() - days);
  const fromStr = from.toISOString();

  try {
    const { data: ordersData } = await axios.get(`https://api.mercadolibre.com/orders/search?seller=${ml.sellerId}&order.date_created.from=${encodeURIComponent(fromStr)}&sort=date_desc&limit=50`, { headers: mlHeaders(ml.token) });

    let faturamento = 0;
    let taxas = 0;
    let frete = 0;
    let concluidoCount = 0;
    let canceladoCount = 0;
    const byDay = {};

    (ordersData.results || []).forEach(o => {
      if (o.status === 'cancelled') { canceladoCount++; return; }
      if (o.status === 'paid' || o.status === 'closed' || o.status === 'delivered' || o.status === 'shipped') {
        concluidoCount++;
        faturamento += o.total_amount || 0;
        // Comissão do ML fica em order_items[].sale_fee (por unidade)
        (o.order_items || []).forEach(it => { taxas += (it.sale_fee || 0) * (it.quantity || 1); });
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
      lucroBruto: faturamento - taxas,
      pedidosConcluidos: concluidoCount,
      pedidosCancelados: canceladoCount,
      totalPedidos: ordersData.paging?.total ?? (ordersData.results || []).length,
      ticketMedio: concluidoCount ? faturamento / concluidoCount : 0,
      byDay,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    loadPersistedData();
  });
}

module.exports = app;
