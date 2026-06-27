// Este arquivo foi substituído por database-vercel.js
// Que suporta tanto desenvolvimento (arquivo) quanto produção (memória)

const dbConfig = require('./database-vercel');

module.exports = dbConfig.getDb();
