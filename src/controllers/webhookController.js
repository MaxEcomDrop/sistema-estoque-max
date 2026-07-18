const db = require('../../config/database');
const blingService = require('../services/blingService');
const authService = require('../services/authService');

exports.handleBlingWebhook = async (req, res) => {
  try {
    const { tipo, idRegistro, sequencia } = req.body;

    console.log(`[WEBHOOK] Tipo: ${tipo}, ID: ${idRegistro}, Sequencia: ${sequencia}`);

    if (!tipo || !idRegistro) {
      return res.status(400).json({ error: 'Parâmetros obrigatórios não fornecidos' });
    }

    if (tipo === 'produto.criacao' || tipo === 'produto.atualizacao') {
      handleProdutoWebhook(idRegistro).catch(err =>
        console.error(`[WEBHOOK] Erro no processamento em background do produto ${idRegistro}:`, err)
      );
    } else if (tipo === 'estoque.atualizacao') {
      handleEstoqueWebhook(idRegistro).catch(err =>
        console.error(`[WEBHOOK] Erro no processamento em background do estoque ${idRegistro}:`, err)
      );
    } else {
      console.log(`[WEBHOOK] Tipo de evento não suportado: ${tipo}`);
    }

    res.json({
      message: 'Webhook recebido com sucesso',
      tipo,
      idRegistro,
    });
  } catch (error) {
    console.error('Erro ao processar webhook:', error);
    res.status(500).json({ error: 'Erro ao processar webhook' });
  }
};

async function handleProdutoWebhook(produtoId) {
  try {
    const user = await getValidUser();
    if (!user) {
      console.log('[WEBHOOK] Nenhum usuário autenticado encontrado');
      return;
    }

    let accessToken = user.access_token;

    if (authService.isTokenExpired(user)) {
      try {
        accessToken = await authService.refreshUserToken(user);
        console.log('[WEBHOOK] Token renovado com sucesso');
      } catch (error) {
        console.error('[WEBHOOK] Erro ao renovar token:', error);
        return;
      }
    }

    const produtoData = await blingService.getProdutoById(accessToken, produtoId);

    if (!produtoData) {
      console.log(`[WEBHOOK] Produto ${produtoId} não encontrado na API do Bling`);
      return;
    }

    await updateOrInsertProduto(user.id, produtoData);
    console.log(`[WEBHOOK] Produto ${produtoId} sincronizado com sucesso`);
  } catch (error) {
    console.error(`[WEBHOOK] Erro ao processar produto ${produtoId}:`, error);
  }
}

async function handleEstoqueWebhook(produtoId) {
  try {
    const user = await getValidUser();
    if (!user) {
      console.log('[WEBHOOK] Nenhum usuário autenticado encontrado');
      return;
    }

    let accessToken = user.access_token;

    if (authService.isTokenExpired(user)) {
      try {
        accessToken = await authService.refreshUserToken(user);
      } catch (error) {
        console.error('[WEBHOOK] Erro ao renovar token:', error);
        return;
      }
    }

    const produtoData = await blingService.getProdutoById(accessToken, produtoId);

    if (!produtoData) {
      console.log(`[WEBHOOK] Produto ${produtoId} não encontrado`);
      return;
    }

    await updateOrInsertProduto(user.id, produtoData);
    console.log(`[WEBHOOK] Estoque do produto ${produtoId} sincronizado`);
  } catch (error) {
    console.error(`[WEBHOOK] Erro ao processar estoque ${produtoId}:`, error);
  }
}

function updateOrInsertProduto(userId, produtoData) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO products
       (user_id, bling_product_id, nome, codigo, preco, estoque, situacao, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        userId,
        produtoData.id,
        produtoData.nome,
        produtoData.codigo,
        produtoData.preco || 0,
        produtoData.estoque || 0,
        produtoData.situacao || 'A',
      ],
      function (err) {
        if (err) {
          console.error('Erro ao atualizar produto no banco:', err);
          return reject(err);
        }
        resolve();
      }
    );
  });
}

function getValidUser() {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM users WHERE access_token IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
      (err, user) => {
        if (err) return reject(err);
        resolve(user);
      }
    );
  });
}

exports.getWebhookStatus = (req, res) => {
  res.json({
    message: 'Webhook do Bling está funcionando',
    supported_events: [
      'produto.criacao',
      'produto.atualizacao',
      'estoque.atualizacao',
    ],
    endpoint: '/api/webhook/bling',
  });
};
