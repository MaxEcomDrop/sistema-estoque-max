'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBlingOrder, orderDiscount } = require('../lib/bling-order');
const { calculateResult } = require('../public/financial-calculator');

const pedido225Bling = {
  total: 51.68,
  totalVenda: 22.99,
  totalProdutos: 22.99,
  desconto: { valor: 2.30, unidade: 'REAL' },
  transporte: { frete: 30.99 },
  taxas: { valorBase: 20.69, taxaComissao: 1.89, custoFrete: 6.55 },
  itens: [{ quantidade: 1, valor: 22.99 }],
};

test('normaliza o pedido 225 exatamente como aparece no Bling', () => {
  const result = normalizeBlingOrder(pedido225Bling);
  assert.deepEqual({
    productsTotal: result.productsTotal,
    discount: result.discount,
    shippingCharged: result.shippingCharged,
    salesBase: result.salesBase,
    customerTotal: result.customerTotal,
    marketplaceFee: result.marketplaceFee,
    marketplaceShippingCost: result.marketplaceShippingCost,
    marketplaceNet: result.marketplaceNet,
  }, {
    productsTotal: 22.99,
    discount: 2.30,
    shippingCharged: 30.99,
    salesBase: 20.69,
    customerTotal: 51.68,
    marketplaceFee: 1.89,
    marketplaceShippingCost: 6.55,
    marketplaceNet: 12.25,
  });
  assert.equal(Number(result.marketplaceFeePercent.toFixed(2)), 9.13);
  assert.equal(Number(result.marketplaceShippingPercent.toFixed(2)), 31.66);
  assert.equal(Number(result.totalMarketplacePercent.toFixed(2)), 40.79);
  assert.equal(calculateResult({
    revenue: result.salesBase,
    productCost: 3.50,
    marketplaceFee: result.marketplaceFee,
    shippingCost: result.marketplaceShippingCost,
  }).contributionProfit, 8.75);
});

test('converte desconto percentual em valor monetário', () => {
  assert.equal(orderDiscount({ totalProdutos: 200, desconto: { valor: 10, unidade: 'PERCENTUAL' } }), 20);
});

test('não confunde frete cobrado com receita de mercadoria', () => {
  const result = normalizeBlingOrder({
    totalProdutos: 100,
    desconto: { valor: 5, unidade: 'REAL' },
    transporte: { frete: 25 },
  });
  assert.equal(result.salesBase, 95);
  assert.equal(result.customerTotal, 120);
});
