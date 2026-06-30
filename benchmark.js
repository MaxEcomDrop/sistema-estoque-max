const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(':memory:');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      bling_product_id TEXT UNIQUE NOT NULL,
      nome TEXT NOT NULL,
      codigo TEXT,
      preco REAL,
      estoque INTEGER,
      situacao TEXT
    )
  `);
});

const produtos = [];
for (let i = 0; i < 10000; i++) {
  produtos.push({
    id: `prod_${i}`,
    nome: `Produto ${i}`,
    codigo: `COD${i}`,
    preco: 10.5,
    estoque: 100,
    situacao: 'A'
  });
}

function runOriginal(callback) {
  const start = Date.now();
  db.serialize(() => {
    db.run('DELETE FROM products');
    let inserted = 0;
    produtos.forEach((produto) => {
      db.run(
        `INSERT INTO products (user_id, bling_product_id, nome, codigo, preco, estoque, situacao)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          1,
          produto.id,
          produto.nome,
          produto.codigo,
          produto.preco || 0,
          produto.estoque || 0,
          produto.situacao || 'A',
        ],
        function (insertErr) {
          if (!insertErr) inserted++;
        }
      );
    });
    // the problem with this benchmark is db.run is asynchronous in node, even with db.serialize, we don't know when it finishes unless we do a callback
    db.get('SELECT COUNT(*) as count FROM products', (err, row) => {
       const end = Date.now();
       console.log('Original Time:', end - start, 'ms', 'inserted:', row.count);
       callback();
    });
  });
}

function runOptimized(callback) {
  const start = Date.now();
  db.serialize(() => {
    db.run('DELETE FROM products');
    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare(
      `INSERT INTO products (user_id, bling_product_id, nome, codigo, preco, estoque, situacao)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    let inserted = 0;
    produtos.forEach((produto) => {
      stmt.run(
        [
          1,
          produto.id,
          produto.nome,
          produto.codigo,
          produto.preco || 0,
          produto.estoque || 0,
          produto.situacao || 'A',
        ],
        function (insertErr) {
          if (!insertErr) inserted++;
        }
      );
    });
    stmt.finalize();
    db.run('COMMIT');

    db.get('SELECT COUNT(*) as count FROM products', (err, row) => {
       const end = Date.now();
       console.log('Optimized Time:', end - start, 'ms', 'inserted:', row.count);
       callback();
    });
  });
}

db.serialize(() => {
  runOriginal(() => {
    runOptimized(() => {
      db.close();
    });
  });
});
