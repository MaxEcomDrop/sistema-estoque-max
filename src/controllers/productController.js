const db = require('../../config/database');
const blingService = require('../services/blingService');
const authService = require('../services/authService');

exports.syncProdutos = async (req, res) => {
  try {
    const userId = req.user.userId;

    db.get('SELECT * FROM users WHERE id = ?', [userId], async (err, user) => {
      if (err || !user) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }

      let accessToken = user.access_token;

      if (authService.isTokenExpired(user)) {
        try {
          accessToken = await authService.refreshUserToken(user);
        } catch (error) {
          return res.status(401).json({ error: 'Token expirado, faça login novamente' });
        }
      }

      try {
        const produtos = await blingService.getProdutos(accessToken);

        db.serialize(() => {
          db.run('DELETE FROM products WHERE user_id = ?', [userId], (deleteErr) => {
            if (deleteErr) {
              return res.status(500).json({ error: 'Erro ao limpar produtos antigos' });
            }

            if (produtos.length === 0) {
              return res.json({
                message: 'Produtos sincronizados com sucesso',
                total: 0,
              });
            }

            db.serialize(() => {
              db.run('BEGIN TRANSACTION');

              const chunkSize = 100;
              const chunks = [];
              for (let i = 0; i < produtos.length; i += chunkSize) {
                chunks.push(produtos.slice(i, i + chunkSize));
              }

              chunks.forEach((chunk) => {
                const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(',');
                const params = [];
                chunk.forEach((produto) => {
                  params.push(
                    userId,
                    produto.id,
                    produto.nome,
                    produto.codigo,
                    produto.preco || 0,
                    produto.estoque || 0,
                    produto.situacao || 'A'
                  );
                });

                db.run(
                  `INSERT INTO products (user_id, bling_product_id, nome, codigo, preco, estoque, situacao) VALUES ${placeholders}`,
                  params,
                  (err) => {
                    if (err) {
                      console.error('Erro ao inserir lote de produtos:', err);
                    }
                  }
                );
              });

              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                   return res.status(500).json({ error: 'Erro ao salvar produtos em lote' });
                }
                res.json({
                  message: 'Produtos sincronizados com sucesso',
                  total: produtos.length,
                });
              });
            });
          });
        });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar produtos do Bling' });
      }
    });
  } catch (error) {
    console.error('Erro ao sincronizar produtos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
};

exports.getProdutos = (req, res) => {
  try {
    const userId = req.user.userId;

    db.all(
      'SELECT * FROM products WHERE user_id = ? ORDER BY nome',
      [userId],
      (err, products) => {
        if (err) {
          return res.status(500).json({ error: 'Erro ao buscar produtos' });
        }

        res.json({
          total: products.length,
          products,
        });
      }
    );
  } catch (error) {
    console.error('Erro ao buscar produtos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
};

exports.getProdutoById = (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    db.get(
      'SELECT * FROM products WHERE id = ? AND user_id = ?',
      [id, userId],
      (err, product) => {
        if (err) {
          return res.status(500).json({ error: 'Erro ao buscar produto' });
        }

        if (!product) {
          return res.status(404).json({ error: 'Produto não encontrado' });
        }

        res.json(product);
      }
    );
  } catch (error) {
    console.error('Erro ao buscar produto:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
};

exports.searchProdutos = (req, res) => {
  try {
    const userId = req.user.userId;
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Parâmetro de busca não fornecido' });
    }

    const searchTerm = `%${q}%`;

    db.all(
      `SELECT * FROM products
       WHERE user_id = ? AND (nome LIKE ? OR codigo LIKE ?)
       ORDER BY nome`,
      [userId, searchTerm, searchTerm],
      (err, products) => {
        if (err) {
          return res.status(500).json({ error: 'Erro ao buscar produtos' });
        }

        res.json({
          total: products.length,
          products,
        });
      }
    );
  } catch (error) {
    console.error('Erro ao buscar produtos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
};

exports.updateProduto = (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { estoque, preco } = req.body;

    if (estoque === undefined && preco === undefined) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    db.get(
      'SELECT * FROM products WHERE id = ? AND user_id = ?',
      [id, userId],
      (err, product) => {
        if (err) {
          return res.status(500).json({ error: 'Erro ao buscar produto' });
        }

        if (!product) {
          return res.status(404).json({ error: 'Produto não encontrado' });
        }

        const novoEstoque = estoque !== undefined ? estoque : product.estoque;
        const novoPreco = preco !== undefined ? preco : product.preco;

        db.run(
          `UPDATE products
           SET estoque = ?, preco = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [novoEstoque, novoPreco, id],
          function (updateErr) {
            if (updateErr) {
              return res.status(500).json({ error: 'Erro ao atualizar produto' });
            }

            res.json({
              message: 'Produto atualizado com sucesso',
              product: {
                id,
                ...product,
                estoque: novoEstoque,
                preco: novoPreco,
              },
            });
          }
        );
      }
    );
  } catch (error) {
    console.error('Erro ao atualizar produto:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
};
