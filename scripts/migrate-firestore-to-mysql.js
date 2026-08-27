require('dotenv').config();

const { cert, deleteApp, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const {
  createMySqlFirestore,
  isMySqlConfigured,
  mysqlConfigFromEnv,
} = require('../lib/mysql-firestore');

const COLLECTIONS = [
  'app_assets',
  'app_state',
  'bling_auth',
  'bling_config',
  'bling_pedido_detalhes',
  'customers',
  'fcm_tokens',
  'finance_accounts',
  'financeiro_periodos',
  'ml_auth',
  'ml_pkce',
  'ml_sku_map',
  'notif_history',
  'produto_imagens',
  'produto_overrides',
  'produtos_ocultos',
  'sales_ledger',
  'stock_sync_events',
  'sync_queue',
  'sync_state',
];

function normalizeFirestoreValue(value) {
  if (value?.toDate instanceof Function) return value.toDate();
  if (Array.isArray(value)) return value.map(normalizeFirestoreValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeFirestoreValue(item)]));
  }
  return value;
}

async function main() {
  if (!isMySqlConfigured()) {
    throw new Error('Configure MYSQL_DATABASE, MYSQL_USER e MYSQL_PASSWORD.');
  }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('Configure FIREBASE_SERVICE_ACCOUNT para ler os dados antigos.');
  }

  const dryRun = process.argv.includes('--dry-run');
  const credential = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const firebaseApp = initializeApp({ credential: cert(credential) }, `mysql-migration-${Date.now()}`);
  const firestoreId = process.env.FIRESTORE_DB_ID;
  const source = firestoreId && firestoreId !== '(default)'
    ? getFirestore(firebaseApp, firestoreId)
    : getFirestore(firebaseApp);
  const target = createMySqlFirestore(mysqlConfigFromEnv());
  let total = 0;

  try {
    for (const collectionName of COLLECTIONS) {
      const snapshot = await source.collection(collectionName).get();
      console.log(`${collectionName}: ${snapshot.size} documento(s)${dryRun ? ' [simulação]' : ''}`);
      if (!dryRun && !snapshot.empty) {
        for (let offset = 0; offset < snapshot.docs.length; offset += 100) {
          const batch = target.batch();
          snapshot.docs.slice(offset, offset + 100).forEach(document => {
            batch.set(
              target.collection(collectionName).doc(document.id),
              normalizeFirestoreValue(document.data())
            );
          });
          await batch.commit();
        }
      }
      total += snapshot.size;
    }
    console.log(`${dryRun ? 'Simulação concluída' : 'Migração concluída'}: ${total} documento(s).`);
  } finally {
    await target.close();
    await deleteApp(firebaseApp);
  }
}

main().catch(error => {
  console.error(`Migração ERRO: ${error.message}`);
  process.exitCode = 1;
});
