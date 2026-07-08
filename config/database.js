// ⚠️ AVISO DE AUDITORIA ARQUITETURAL:
// Este arquivo de configuração do SQLite foi substituído por database-vercel.js
// no ambiente de desenvolvimento modular. No entanto, observe que o monolito
// de produção principal (index.js) NÃO utiliza SQLite, operando inteiramente
// em memória com sincronização para o Firestore (Firebase Admin SDK).
// Portanto, este arquivo e a dependência do SQLite permanecem inativos em produção.

const dbConfig = require('./database-vercel');

module.exports = dbConfig.getDb();
