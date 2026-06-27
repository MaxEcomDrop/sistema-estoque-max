require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const axios = require('axios');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors());
app.use(express.static('public'));

const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID || '56f15479eddae7460b8028e56f2d5f8a64970fe0';
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || 'de5d5bc2fa78c1b151392e81aae3ab2377bad770724dce3e13c0ec454674';
const BLING_REDIRECT_URI = process.env.BLING_REDIRECT_URI || 'https://sistema-estoque-max.vercel.app/api/webhook/bling';

// ============================================================
// PÁGINAS
// ============================================================

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/dashboard.html', (req, res) => {
  res.sendFile(__dirname + '/public/dashboard.html');
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', client_id: BLING_CLIENT_ID ? 'configurado' : 'ausente' });
});

// ============================================================
// OAUTH
// ============================================================

app.get('/api/auth/url', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: BLING_CLIENT_ID,
    redirect_uri: BLING_REDIRECT_URI,
    state: 'sistema_estoque_max',
  });

  const authUrl = `https://www.bling.com.br/Api/v3/oauth/authorize?${params.toString()}`;
  res.json({ authUrl });
});

// Callback do Bling após autorização
app.get('/api/webhook/bling', async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    console.error('[OAuth] Bling retornou erro:', error);
    return res.redirect(`/?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    // Bling v3 requer Basic Auth + form-urlencoded
    const credentials = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', BLING_REDIRECT_URI);

    const tokenResponse = await axios.post(
      'https://www.bling.com.br/Api/v3/oauth/token',
      params.toString(),
      {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
      }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    res.cookie('bling_token', access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: (expires_in || 3600) * 1000,
    });

    if (refresh_token) {
      res.cookie('bling_refresh', refresh_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 3600 * 1000,
      });
    }

    res.redirect('/dashboard.html?success=true');
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[OAuth] Erro ao trocar código por token:', JSON.stringify(detail));
    res.redirect('/?error=token_exchange_failed');
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('bling_token');
  res.clearCookie('bling_refresh');
  res.json({ message: 'Desconectado' });
});

// ============================================================
// PRODUTOS
// ============================================================

async function getAuthHeader(req) {
  const token = req.cookies?.bling_token;
  if (!token) return null;
  return `Bearer ${token}`;
}

app.get('/api/produtos', async (req, res) => {
  const auth = await getAuthHeader(req);
  if (!auth) return res.status(401).json({ error: 'Não autenticado' });

  try {
    const response = await axios.get('https://www.bling.com.br/Api/v3/produtos', {
      headers: { Authorization: auth, Accept: 'application/json' },
      params: { limite: 100, pagina: 1, situacao: 'A' },
    });

    const raw = Array.isArray(response.data?.data) ? response.data.data : [];

    const products = raw.map(p => ({
      id: p.id,
      nome: p.nome || 'Sem nome',
      codigo: p.codigo || '—',
      preco: typeof p.preco === 'number' ? p.preco : 0,
      estoque: p.estoque?.saldoVirtualTotal ?? p.estoque ?? 0,
      situacao: p.situacao || 'A',
    }));

    res.json({ total: products.length, products });
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado' });
    }
    console.error('[Produtos] Erro:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao buscar produtos', detail: err.message });
  }
});

app.patch('/api/produtos/:id', async (req, res) => {
  const auth = await getAuthHeader(req);
  if (!auth) return res.status(401).json({ error: 'Não autenticado' });

  const { id } = req.params;
  const { estoque, preco } = req.body;

  try {
    const payload = {};
    if (preco !== undefined) payload.preco = Number(preco);

    if (Object.keys(payload).length > 0) {
      await axios.put(
        `https://www.bling.com.br/Api/v3/produtos/${id}`,
        payload,
        { headers: { Authorization: auth, 'Content-Type': 'application/json' } }
      );
    }

    if (estoque !== undefined) {
      await axios.patch(
        `https://www.bling.com.br/Api/v3/estoques`,
        {
          produto: { id: Number(id) },
          operacao: 'B',
          quantidade: Number(estoque),
        },
        { headers: { Authorization: auth, 'Content-Type': 'application/json' } }
      );
    }

    res.json({ success: true, id, changes: { estoque, preco } });
  } catch (err) {
    console.error('[Produto Update] Erro:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao atualizar produto', detail: err.message });
  }
});

// ============================================================
// WEBHOOK (POST do Bling)
// ============================================================

app.post('/api/webhook/bling', (req, res) => {
  console.log('[Webhook] Recebido:', JSON.stringify(req.body));
  res.json({ received: true });
});

// ============================================================
// 404
// ============================================================

app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// ============================================================
// START (local only)
// ============================================================

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n✅ Servidor em http://localhost:${PORT}`);
  });
}

module.exports = app;
