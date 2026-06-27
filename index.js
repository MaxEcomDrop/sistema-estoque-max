require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors());
app.use(express.static('public'));

const BLING_CLIENT_ID     = process.env.BLING_CLIENT_ID     || '56f15479eddae7460b8028e56f2d5f8a64970fe0';
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || 'de5d5bc2fa78c1b151392e81aae3ab2377bad770724dce3e13c0ec454674';
const BLING_REDIRECT_URI  = process.env.BLING_REDIRECT_URI  || 'https://sistema-estoque-max.vercel.app/api/webhook/bling';
const ADMIN_EMAIL         = process.env.ADMIN_EMAIL         || '';
const ADMIN_PASSWORD      = process.env.ADMIN_PASSWORD      || '';
const JWT_SECRET          = process.env.JWT_SECRET          || 'estoque_max_jwt_2026_xK9#mP';

// ── Auth helpers ────────────────────────────────────────────────

function safeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}

function requireAuth(req, res, next) {
  try {
    jwt.verify(req.cookies?.system_token || '', JWT_SECRET);
    next();
  } catch {
    res.clearCookie('system_token');
    res.redirect('/login');
  }
}

function requireAuthJson(req, res, next) {
  try {
    jwt.verify(req.cookies?.system_token || '', JWT_SECRET);
    next();
  } catch {
    res.clearCookie('system_token');
    res.status(401).json({ error: 'Não autenticado' });
  }
}

// ── Páginas ─────────────────────────────────────────────────────

app.get('/login', (req, res) => res.sendFile(__dirname + '/public/login.html'));
app.get('/', requireAuth, (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/dashboard.html', requireAuth, (req, res) => res.sendFile(__dirname + '/public/dashboard.html'));
app.get('/health', (req, res) => res.json({ status: 'OK' }));

// ── Login do sistema ─────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'Configure ADMIN_EMAIL e ADMIN_PASSWORD no Vercel.' });
  }

  if (!safeEqual(email, ADMIN_EMAIL) || !safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Email ou senha incorretos.' });
  }

  const token = jwt.sign({ email: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('system_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 3600 * 1000,
  });
  res.json({ success: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('system_token');
  res.clearCookie('bling_token');
  res.clearCookie('bling_refresh');
  res.json({ ok: true });
});

// ── OAuth Bling ──────────────────────────────────────────────────

app.get('/api/auth/url', requireAuthJson, (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: BLING_CLIENT_ID,
    redirect_uri: BLING_REDIRECT_URI,
    state: 'estoque_max',
  });
  res.json({ authUrl: `https://www.bling.com.br/Api/v3/oauth/authorize?${params}` });
});

app.get('/api/webhook/bling', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
  if (!code) return res.redirect('/?error=no_code');

  try {
    const creds  = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
    const body   = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: BLING_REDIRECT_URI });

    const { data } = await axios.post('https://www.bling.com.br/Api/v3/oauth/token', body.toString(), {
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const cookieOpts = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' };
    res.cookie('bling_token',   data.access_token,  { ...cookieOpts, maxAge: (data.expires_in || 3600) * 1000 });
    if (data.refresh_token) res.cookie('bling_refresh', data.refresh_token, { ...cookieOpts, maxAge: 30 * 24 * 3600 * 1000 });

    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('[OAuth]', err.response?.data || err.message);
    res.redirect('/?error=token_exchange_failed');
  }
});

// ── Produtos ─────────────────────────────────────────────────────

app.get('/api/produtos', requireAuthJson, async (req, res) => {
  const token = req.cookies?.bling_token;
  if (!token) return res.status(401).json({ error: 'Bling não conectado', code: 'BLING_NOT_CONNECTED' });

  try {
    const { data } = await axios.get('https://www.bling.com.br/Api/v3/produtos', {
      headers: { Authorization: `Bearer ${token}` },
      params: { limite: 100, pagina: 1 },
    });

    const products = (Array.isArray(data?.data) ? data.data : []).map(p => ({
      id:       p.id,
      nome:     p.nome     || 'Sem nome',
      codigo:   p.codigo   || '—',
      preco:    typeof p.preco === 'number' ? p.preco : 0,
      estoque:  p.estoque?.saldoVirtualTotal ?? p.estoque ?? 0,
      situacao: p.situacao || 'A',
    }));

    res.json({ total: products.length, products });
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token Bling expirado', code: 'BLING_TOKEN_EXPIRED' });
    }
    res.status(500).json({ error: 'Erro ao buscar produtos', detail: err.message });
  }
});

app.patch('/api/produtos/:id', requireAuthJson, async (req, res) => {
  const token = req.cookies?.bling_token;
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });

  const { id } = req.params;
  const { estoque, preco } = req.body;

  try {
    if (preco !== undefined) {
      await axios.put(`https://www.bling.com.br/Api/v3/produtos/${id}`, { preco: Number(preco) }, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
    }
    if (estoque !== undefined) {
      await axios.patch('https://www.bling.com.br/Api/v3/estoques',
        { produto: { id: Number(id) }, operacao: 'B', quantidade: Number(estoque) },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Update]', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao atualizar produto' });
  }
});

// ── Webhook ───────────────────────────────────────────────────────

app.post('/api/webhook/bling', (req, res) => res.json({ received: true }));

// ── 404 ──────────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// ── Start (local) ─────────────────────────────────────────────────

if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => console.log('✅ http://localhost:3000'));
}

module.exports = app;
