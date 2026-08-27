const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FieldValue,
  createFirestoreAdapter,
  createMemoryDriver,
} = require('../lib/mysql-firestore');

function createStore() {
  const firestore = createFirestoreAdapter(createMemoryDriver());
  firestore.FieldValue = FieldValue;
  return firestore;
}

test('persistência documental salva, mescla e remove documentos', async () => {
  const db = createStore();
  const ref = db.collection('app_state').doc('data');

  await ref.set({ nome: 'Estoque Max', config: { cor: 'azul', ativo: true } });
  await ref.set({ config: { cor: 'verde' } }, { merge: true });

  const saved = await ref.get();
  assert.equal(saved.exists, true);
  assert.deepEqual(saved.data(), {
    nome: 'Estoque Max',
    config: { cor: 'verde', ativo: true },
  });

  await ref.delete();
  assert.equal((await ref.get()).exists, false);
});

test('FieldValue preserva timestamp e arrayUnion sem duplicação', async () => {
  const db = createStore();
  const ref = db.collection('ml_sku_map').doc('sku');

  await ref.set({ itemIds: ['MLB1'], updatedAt: FieldValue.serverTimestamp() });
  await ref.set({ itemIds: FieldValue.arrayUnion('MLB1', 'MLB2') }, { merge: true });

  const data = (await ref.get()).data();
  assert.deepEqual(data.itemIds, ['MLB1', 'MLB2']);
  assert.ok(data.updatedAt.toMillis() > 0);
  assert.match(data.updatedAt.toDate().toISOString(), /^\d{4}-\d{2}-\d{2}T/);
});

test('consultas aplicam filtros, ordenação e limite', async () => {
  const db = createStore();
  const ledger = db.collection('sales_ledger');
  await ledger.doc('1').set({ date: '2026-08-20', total: 10 });
  await ledger.doc('2').set({ date: '2026-08-25', total: 20 });
  await ledger.doc('3').set({ date: '2026-08-27', total: 30 });

  const snapshot = await ledger
    .where('date', '>=', '2026-08-21')
    .where('date', '<=', '2026-08-27')
    .orderBy('total', 'desc')
    .limit(1)
    .get();

  assert.equal(snapshot.size, 1);
  assert.equal(snapshot.docs[0].id, '3');
  assert.equal(snapshot.docs[0].data().total, 30);
});

test('batch, getAll e select mantêm a interface usada pela aplicação', async () => {
  const db = createStore();
  const first = db.collection('finance_accounts').doc('1');
  const second = db.collection('finance_accounts').doc('2');
  const batch = db.batch();
  batch.set(first, { descricao: 'Conta A', valor: 100 });
  batch.set(second, { descricao: 'Conta B', valor: 200 });
  await batch.commit();

  const docs = await db.getAll(first, second);
  assert.deepEqual(docs.map(doc => doc.id), ['1', '2']);

  const selected = await db.collection('finance_accounts').select('valor').get();
  assert.deepEqual(selected.docs.map(doc => doc.data()), [{ valor: 100 }, { valor: 200 }]);

  const update = db.batch();
  update.update(first, { valor: 150 });
  update.delete(second);
  await update.commit();
  assert.equal((await first.get()).data().valor, 150);
  assert.equal((await second.get()).exists, false);
});
