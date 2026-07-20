const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateResult,
  estimateProductCost,
} = require('../public/financial-calculator');

test('calcula o lucro real do pedido descontando custo, taxa e frete', () => {
  const result = calculateResult({
    revenue: 22.99,
    productCost: 3.50,
    marketplaceFee: 1.89,
    shippingCost: 6.55,
  });

  assert.equal(result.contributionProfit, 11.05);
  assert.equal(result.grossMargin, 19.49);
  assert.equal(result.quality, 'real');
});

test('marca como incompleto quando faltam custos de produtos', () => {
  const result = calculateResult({ revenue: 100, marketplaceFee: 10, costsComplete: false });
  assert.equal(result.contributionProfit, 90);
  assert.equal(result.quality, 'incomplete');
});

test('estima custo ponderado pelos SKUs realmente vendidos', () => {
  const result = estimateProductCost([
    { codigo: 'A', qtd: 2, faturamento: 40 },
    { codigo: 'B', qtd: 1, faturamento: 20 },
  ], [
    { codigo: 'A', precoCusto: 5 },
    { codigo: 'B', precoCusto: 8 },
  ], 2);

  assert.equal(result.sampleCost, 18);
  assert.equal(result.projectedCost, 36);
  assert.equal(result.coverage, 1);
  assert.equal(result.complete, true);
});

test('informa cobertura e SKUs ausentes sem assumir custo zero como dado completo', () => {
  const result = estimateProductCost([
    { codigo: 'A', qtd: 1, faturamento: 80 },
    { codigo: 'SEM-CUSTO', qtd: 1, faturamento: 20 },
  ], [{ codigo: 'A', precoCusto: 30 }], 1);

  assert.equal(result.projectedCost, 30);
  assert.equal(result.coverage, 0.8);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missingSkus, ['SEM-CUSTO']);
});

test('item sem SKU também impede que o resultado seja considerado completo', () => {
  const result = estimateProductCost([
    { codigo: '', qtd: 1, faturamento: 25 },
  ], [], 1);

  assert.equal(result.complete, false);
  assert.deepEqual(result.missingSkus, ['(item sem SKU)']);
});
