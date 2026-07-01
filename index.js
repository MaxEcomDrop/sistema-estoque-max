require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const jwt = require('jsonwebtoken');

// --- Cache e Retry ---
const apiCache = new Map();

async function fetchWithRetry(fetchFn) {
  let attempts = 0;
  while (attempts < 4) {
    try {
      return await fetchFn();
    } catch (err) {
      if (err.response?.status === 429) {
        attempts++;
        await new Promise(r => setTimeout(r, 1000 * attempts));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Rate limit exceeded after retries');
}

async function fetchWithCache(key, ttlMs, fetchFn) {
  const cached = apiCache.get(key);
  if (cached && Date.now() < cached.exp) return cached.data;
  let attempts = 0;
  while(attempts < 3) {
    try {
      const data = await fetchFn();
      apiCache.set(key, { data, exp: Date.now() + ttlMs });
      return data;
    } catch(err) {
      if (err.response?.status === 429) {
        attempts++;
        await new Promise(r => setTimeout(r, 1000 * attempts));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Rate limit exceeded after retries');
}

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

// In-memory change log (resets on cold start)
// TODO: Persistir em banco de dados em produção
const changeLog = [];
function pushLog(logData) {
  const admin = getAdmin();
  if (admin) {
    admin.firestore().collection('historico').add({
      ...logData,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    }).catch(console.error);
  } else {
    // Fallback seguro em memória
    logData.timestamp = new Date().toISOString();
    changeLog.push(logData);
    console.log('[Historico Local]', logData);
  }
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

// Resolve intervalo de datas a partir do período (today | 7d | 30d | custom)
function resolvePeriodo(period, startDate, endDate) {
  const hoje = new Date();
  const iso = d => d.toISOString().split('T')[0];
  let inicio, fim;
  if (period === 'today') {
    inicio = fim = iso(hoje);
  } else if (period === '7d') {
    const d = new Date(hoje); d.setDate(d.getDate() - 6);
    inicio = iso(d); fim = iso(hoje);
  } else if (period === 'custom' && startDate && endDate) {
    inicio = startDate; fim = endDate;
  } else {
    const d = new Date(hoje); d.setDate(d.getDate() - 29);
    inicio = iso(d); fim = iso(hoje);
  }
  return { inicio, fim, period: period || '30d' };
}

// ── Páginas ──────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(__dirname + '/public/login.html');
});
app.get('/', requireAuth, (req, res) => res.redirect('/dashboard.html'));
app.get('/conectar.html', requireAuth, (req, res) => res.sendFile(__dirname + '/public/conectar.html'));

app.get('/dashboard.html', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  res.sendFile(__dirname + '/public/dashboard.html');
});
app.get('/health', (req, res) => res.json({ status: 'OK', history: changeLog.length, environment: NODE_ENV }));

// Arquivos estáticos (fontes, imagens) — vem DEPOIS das rotas de página
// para que /index.html e /dashboard.html passem pela autenticação acima
// Service Worker — DEVE ser servido sem cache e com scope correto
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Service-Worker-Allowed', '/');
  res.set('Content-Type', 'application/javascript');
  res.sendFile(__dirname + '/public/sw.js');
});

// Manifest — precisa ser acessível publicamente
app.get('/manifest.json', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(__dirname + '/public/manifest.json');
});

// Arquivos estáticos — usa __dirname para funcionar no Vercel Serverless
app.use(express.static(__dirname + '/public', { index: false }));

// ── Login ────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  
  if (!email || !password) {
    return sendErrorResponse(res, 400, 'Email e senha são obrigatórios');
  }
  
  if (!safeEqual(email, ADMIN_EMAIL) || !safeEqual(password, ADMIN_PASSWORD)) {
    return sendErrorResponse(res, 401, 'Email ou senha incorretos');
  }

  const token = jwt.sign({ email: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('system_token', token, {
    httpOnly: true, 
    secure: NODE_ENV === 'production',
    sameSite: 'lax', 
    maxAge: 7 * 24 * 3600 * 1000,
  });
  res.json({ success: true });
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
    const { data } = await axios.get(`https://www.bling.com.br/Api/v3/produtos/${req.params.id}`, {
      headers: blingHeaders(token),
    });
    res.json(data?.data || {});
  } catch (err) {
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
    pushLog({
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
  const n = String(s?.nome || s?.valor || s || '').toLowerCase();
  if (n.includes('cancel')) return 'cancelado';
  if (n.includes('atend') || n.includes('conclui') || n.includes('entregue')) return 'concluido';
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
    const totalFrete       = sum(allPedidos, p => p.transporte?.frete || p.frete || 0);
    const totalDesconto    = sum(allPedidos, p => p.desconto?.valor || p.totalDescontos || 0);

    // Comparativo com período anterior (faturamento concluído)
    const prevConcluidos = prevPedidos.filter(p => categorize(p.situacao) === 'concluido');
    const prevReceita = sum(prevConcluidos, valorPedido);
    const variacao = prevReceita > 0 ? ((receitaConcluida - prevReceita) / prevReceita) * 100 : null;

    // Série diária para gráfico
    const byDay = {};
    allPedidos.forEach(p => {
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
      ticketMedio: allPedidos.length > 0 ? totalBruto / allPedidos.length : 0,
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

  const { id } = req.params;
  const { estoque, preco, nome_produto, valor_anterior, _fullUpdate } = req.body;

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
      pushLog({
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
      pushLog({
        id: changeLog.length + 1, produto_id: id,
        produto_nome: nome_produto || `#${id}`, campo: 'preço',
        valor_anterior: valor_anterior || '—',
        valor_novo: `R$ ${Number(preco).toFixed(2)}`,
        timestamp: new Date().toISOString(),
      });
    }
    if (estoque !== undefined) {
      const depositoId = await getDepositoId(token);
      await axios.post('https://www.bling.com.br/Api/v3/estoques',
        { produto: { id: Number(id) }, deposito: { id: depositoId }, operacao: 'B', quantidade: Number(estoque) },
        { headers: blingHeaders(token) }
      );
      pushLog({
        id: changeLog.length + 1, produto_id: id,
        produto_nome: nome_produto || `#${id}`, campo: 'estoque',
        valor_anterior: valor_anterior || '—',
        valor_novo: `${Number(estoque)} un.`,
        timestamp: new Date().toISOString(),
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Update]', err.response?.data || err.message);
    const detail = err.response?.data?.error?.message || err.response?.data || err.message;
    sendErrorResponse(res, 500, 'Erro ao atualizar produto', detail);
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
      pushLog({
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
    const pedidosBling = await fetchWithCache(`pedidos_recentes_${token.substring(0,10)}`, 45000, async () => {
      let all = [];
      for (let pg = 1; pg <= 2; pg++) {
        const { data } = await fetchWithRetry(() => axios.get('https://www.bling.com.br/Api/v3/pedidos/vendas', {
          headers: { Authorization: `Bearer ${token}` },
          params: { limite: 100, pagina: pg },
        }));
        const items = Array.isArray(data?.data) ? data.data : [];
        all = all.concat(items);
        if (items.length < 100) break;
      }

      // Fetch deeper details for the first 12 orders
      const top12 = all.slice(0, 12);
      for (let i = 0; i < top12.length; i += 3) {
        const batch = top12.slice(i, i + 3);
        await Promise.all(batch.map(async (p) => {
          try {
            const { data: detailData } = await fetchWithRetry(() => axios.get(`https://www.bling.com.br/Api/v3/pedidos/vendas/${p.id}`, {
              headers: { Authorization: `Bearer ${token}` }
            }));
            const d = detailData?.data || {};
            p.transporte = d.transporte || p.transporte;
            p.desconto = d.desconto || p.desconto;
            p.tributos = d.tributos || {};
          } catch(e) { }
        }));
        if (i + 3 < top12.length) await new Promise(r => setTimeout(r, 1100)); 
      }
      return all;
    });

    const pedidos = pedidosBling.map(p => {
      const valorBruto = p.totalProdutos || p.totalVenda || p.total || 0;
      const frete = p.transporte?.fretePorConta || p.transporte?.frete || p.frete || 0;
      const desconto = p.desconto?.valor || p.totalDescontos || p.desconto || 0;
      const impostosEstimados = p.tributos?.total || (valorBruto * 0.06);
      let lucroLiquido = valorBruto - frete - desconto - impostosEstimados;
      
      return {
        id:        p.id,
        numero:    p.numero,
        data:      p.data,
        valor:     valorBruto,
        frete,
        desconto,
        impostos: impostosEstimados,
        lucro:     lucroLiquido,
        situacao:  String(p.situacao?.nome || p.situacao?.valor || p.situacao || '—'),
        contato:   p.contato?.nome || '—',
      };
    });

    res.json({ total: pedidos.length, pedidos });
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    sendErrorResponse(res, 500, 'Erro ao buscar pedidos', err.message);
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
  } catch (e) { res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Erro interno no servidor' : e.message }); }
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
  } catch (e) { res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Erro interno no servidor' : e.message }); }
});

// Cron: processa notificações agendadas (chamado pelo Vercel Cron a cada minuto)
app.get('/api/cron/push', async (req, res) => {
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
        batch.update(doc.ref, { status: 'error', error: process.env.NODE_ENV === 'production' ? 'Erro interno no servidor' : e.message });
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

  const categorize = s => {
    const n = String(s?.nome || s?.valor || s || '').toLowerCase();
    if (n.includes('cancel')) return 'cancelado';
    if (n.includes('atend') || n.includes('conclui') || n.includes('entregue')) return 'concluido';
    return 'pendente';
  };

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

    const contasReceber = {
      total: receber.total,
      count: receber.count,
      vencidas: receber.vencidas,
      vencidasValor: receber.vencidasValor || 0,
      ok: receber.ok,
      itens: receber.itens || []
    };

    const contasPagar = {
      total: pagar.total,
      count: pagar.count,
      vencidas: pagar.vencidas,
      vencidasValor: pagar.vencidasValor || 0,
      ok: pagar.ok,
      itens: pagar.itens || []
    };

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
      },
      contasReceber,
      contasPagar,
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
