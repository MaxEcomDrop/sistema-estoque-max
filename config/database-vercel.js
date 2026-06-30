const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

let db;

const initDatabase = () => {
  if (db) return db;

  // Em produção (Vercel), usar memória. Em desenvolvimento, usar arquivo.
  const useInMemory = process.env.NODE_ENV === 'production';

  if (useInMemory) {
    console.log('[DB] Usando banco de dados em memória (Vercel)');
    db = new sqlite3.Database(':memory:', (err) => {
      if (err) {
        console.error('[DB] Erro ao conectar:', err);
      } else {
        console.log('[DB] Banco de dados em memória criado');
        initializeTables();
      }
    });
  } else {
    const dataDir = path.join(__dirname, '../data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const dbPath = path.join(dataDir, 'estoque.db');
    console.log('[DB] Usando banco de dados em arquivo:', dbPath);

    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('[DB] Erro ao conectar:', err);
      } else {
        console.log('[DB] Conectado ao banco de dados SQLite');
        initializeTables();
      }
    });
  }

  return db;
};

function initializeTables() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bling_user_id TEXT UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) console.error('[DB] Erro ao criar tabela users:', err);
      else console.log('[DB] Tabela users inicializada');
    });

    db.run(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        bling_product_id TEXT UNIQUE NOT NULL,
        nome TEXT NOT NULL,
        codigo TEXT,
        preco REAL,
        estoque INTEGER,
        situacao TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `, (err) => {
      if (err) console.error('[DB] Erro ao criar tabela products:', err);
      else console.log('[DB] Tabela products inicializada');
    });


    db.run(`
      CREATE TABLE IF NOT EXISTS change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        produto_id TEXT,
        produto_nome TEXT,
        campo TEXT,
        valor_anterior TEXT,
        valor_novo TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) console.error('[DB] Erro ao criar tabela change_log:', err);
      else console.log('[DB] Tabela change_log inicializada');
    });

    console.log('[DB] ✅ Tabelas inicializadas com sucesso');
  });
}

module.exports = {
  init: initDatabase,
  getDb: () => {
    if (!db) {
      initDatabase();
    }
    return db;
  },
};
