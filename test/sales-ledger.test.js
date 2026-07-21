'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateSalesFacts, buildSalesFact } = require('../lib/sales-ledger');

test('calcula lucro real do pedido descontando custo, taxa e frete do canal', () => {
  const fact = buildSalesFact({
    id: 225, numero: 225, data: '2026-07-20', situacao: { nome: 'Atendido' }, loja: { id: 9, nome: 'TikTok Shop' },
    itens: [{ codigo: 'SAD009001', descricao: 'Adaptador', quantidade: 1, valor: 22.99 }],
    total: 51.68, desconto: { valor: 2.30 }, taxas: { taxaComissao: 1.89, custoFrete: 6.55, valorBase: 20.69 },
  }, { costBySku: { SAD009001: 5 }, statusCategory: 'concluido' });
  assert.equal(fact.salesBase, 20.69);
  assert.equal(fact.marketplaceFee, 1.89);
  assert.equal(fact.marketplaceShippingCost, 6.55);
  assert.equal(fact.cmv, 5);
  assert.equal(fact.profitBeforeFixed, 7.25);
});

test('dilui custos fixos por faturamento e gera curva ABC do mesmo conjunto', () => {
  const result = aggregateSalesFacts([
    { id: '1', date: '2026-07-01', statusCategory: 'concluido', salesBase: 80, marketplaceFee: 8, marketplaceShippingCost: 4, cmv: 20, profitBeforeFixed: 48, items: [{ sku: 'A', name: 'A', quantity: 2, revenue: 80, costTotal: 20, marketplaceFee: 8, channelShippingCost: 4, profitBeforeFixed: 48 }] },
    { id: '2', date: '2026-07-02', statusCategory: 'concluido', salesBase: 20, marketplaceFee: 2, marketplaceShippingCost: 1, cmv: 5, profitBeforeFixed: 12, items: [{ sku: 'B', name: 'B', quantity: 1, revenue: 20, costTotal: 5, marketplaceFee: 2, channelShippingCost: 1, profitBeforeFixed: 12 }] },
  ], { fixedCosts: 10, allocationRule: 'revenue' });
  assert.equal(result.totals.realProfit, 50);
  assert.equal(result.products[0].fixedCostAllocated, 8);
  assert.equal(result.abc[0].classification, 'A');
  assert.equal(result.abc[1].classification, 'B');
});
