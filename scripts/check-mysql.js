require('dotenv').config();

const {
  createMySqlFirestore,
  isMySqlConfigured,
  mysqlConfigFromEnv,
} = require('../lib/mysql-firestore');

async function main() {
  const config = mysqlConfigFromEnv();
  if (!isMySqlConfigured()) {
    throw new Error('Configure MYSQL_DATABASE, MYSQL_USER e MYSQL_PASSWORD antes de testar.');
  }

  const db = createMySqlFirestore(config);
  const id = `check_${Date.now()}`;
  const ref = db.collection('_health').doc(id);
  try {
    await ref.set({ checkedAt: new Date(), source: 'npm run db:check' });
    const saved = await ref.get();
    if (!saved.exists) throw new Error('A gravação de teste não pôde ser lida.');
    await ref.delete();
    console.log(`MySQL OK: ${config.host}:${config.port}/${config.database}`);
  } finally {
    await db.close();
  }
}

main().catch(error => {
  console.error(`MySQL ERRO: ${error.message}`);
  process.exitCode = 1;
});
