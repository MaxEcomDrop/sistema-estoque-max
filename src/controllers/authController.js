const blingService = require('../services/blingService');
const authService = require('../services/authService');
const db = require('../../config/database');

exports.getAuthUrl = (req, res) => {
  const authUrl = blingService.getAuthorizationUrl();
  res.json({ authUrl });
};

exports.handleCallback = async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'Código de autorização não fornecido' });
    }

    const tokenData = await blingService.exchangeCodeForToken(code);

    const blingUserId = 'bling_user';
    const userId = await authService.saveOrUpdateUser(blingUserId, tokenData);
    const jwtToken = authService.generateJWT(userId);

    res.cookie('auth_token', jwtToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    // Sincronizar produtos automaticamente após login
    syncProductosAposLogin(userId, tokenData.access_token).catch(err => {
      console.error('Erro ao sincronizar produtos após login:', err);
    });

    res.redirect('/dashboard');
  } catch (error) {
    console.error('Erro no callback de autenticação:', error);
    res.status(500).json({ error: 'Erro ao autenticar com Bling' });
  }
};

exports.logout = (req, res) => {
  res.clearCookie('auth_token');
  res.json({ message: 'Desconectado com sucesso' });
};

exports.getCurrentUser = (req, res) => {
  res.json({ userId: req.user.userId });
};

async function syncProductosAposLogin(userId, accessToken) {
  try {
    console.log('[AUTO-SYNC] Iniciando sincronização automática de produtos...');

    const produtos = await blingService.getProdutos(accessToken);

    if (!produtos || produtos.length === 0) {
      console.log('[AUTO-SYNC] Nenhum produto encontrado');
      return;
    }

    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION', (err) => {
          if (err) return reject(err);

          let processed = 0;
          let errors = 0;

          produtos.forEach((produto) => {
            db.run(
              `INSERT OR REPLACE INTO products
               (user_id, bling_product_id, nome, codigo, preco, estoque, situacao, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
              [
                userId,
                produto.id,
                produto.nome,
                produto.codigo,
                produto.preco || 0,
                produto.estoque || 0,
                produto.situacao || 'A',
              ],
              (err) => {
                if (err) {
                  console.error(`[AUTO-SYNC] Erro ao sincronizar produto ${produto.id}:`, err);
                  errors++;
                } else {
                  processed++;
                }

                if (processed + errors === produtos.length) {
                  db.run('COMMIT', (commitErr) => {
                    if (commitErr) {
                      console.error('[AUTO-SYNC] Erro ao fazer commit:', commitErr);
                      return reject(commitErr);
                    }
                    console.log(`[AUTO-SYNC] ✅ ${processed} produtos sincronizados (${errors} erros)`);
                    resolve();
                  });
                }
              }
            );
          });
        });
      });
    });
  } catch (error) {
    console.error('[AUTO-SYNC] Erro ao sincronizar produtos:', error);
    throw error;
  }
}
