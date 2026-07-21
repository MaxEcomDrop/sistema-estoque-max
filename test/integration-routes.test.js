'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('backend expõe sincronização, analytics e canais sem reativar edição de pedidos', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  [
    "app.get('/api/produtos/lojas-vinculadas'",
    "app.post('/api/sync/vendas'",
    "app.get('/api/analytics/vendas'",
    "app.post('/api/sync/estoque'",
    "app.get('/api/cron/sync-vendas'",
    "app.get('/api/cron/sync-estoque'",
    "app.get('/api/ml/anuncios/:id'",
  ].forEach(route => assert.ok(source.includes(route), `rota ausente: ${route}`));
  assert.ok(!source.includes("app.put('/api/pedidos/:id'"), 'edição de pedido ainda exposta');
});

test('paginação operacional não mantém os antigos cortes de produtos e anúncios', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(source.includes("fetchBlingPaged(token, 'produtos', {}, 100)"));
  assert.ok(source.includes("fetchMLItemIds(ml, status, 1000)"));
  assert.ok(source.includes("fetchMLOrders(ml, fromStr, 1000)"));
});

test('Firebase Admin usa a API modular compatível com a versão instalada', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(source.includes("require('firebase-admin/app')"));
  assert.ok(source.includes('getApps().length ? getApp() : initializeApp'));
  assert.ok(!source.includes('admin.apps.length'));
  assert.ok(!source.includes('admin.credential.cert'));
});

test('pedidos usam plataforma real e fallback persistido do canal do Bling', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(source.includes('function plataformaCanal(nome)'));
  assert.ok(source.includes('async function canaisPedidosPersistidos(pedidos)'));
  assert.ok(source.includes('canalLoja: lojaOriginal'));
});

test('contas recorrentes preservam calendário e status informado', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(source.includes('function dataRecorrente(baseData, frequencia, indice)'));
  assert.ok(source.includes("const statusInicial = ['pendente', 'pago', 'recebido'].includes(status)"));
  assert.ok(source.includes("dataVencimento: dataRecorrente(baseData, frequencia || 'mensal', i)"));
});
