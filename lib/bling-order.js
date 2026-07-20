'use strict';

function money(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstMoney(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function roundMoney(value) {
  return Math.round((money(value) + Number.EPSILON) * 100) / 100;
}

function itemSubtotal(order) {
  const explicit = firstMoney(order?.totalProdutos, order?.totalItens);
  if (explicit > 0) return explicit;
  return (Array.isArray(order?.itens) ? order.itens : []).reduce((total, item) => {
    return total + money(item?.quantidade) * money(item?.valor ?? item?.preco);
  }, 0);
}

function orderDiscount(order, subtotal = itemSubtotal(order)) {
  const raw = order?.desconto;
  if (raw && typeof raw === 'object') {
    const value = firstMoney(raw.valor, raw.value, raw.total);
    const unit = String(raw.unidade ?? raw.unit ?? '').toUpperCase();
    if (unit.includes('PERCENT') || unit === '%') return roundMoney(subtotal * value / 100);
    return roundMoney(value);
  }
  return roundMoney(firstMoney(raw, order?.totalDesconto, order?.descontoValor));
}

function normalizeBlingOrder(order = {}) {
  const productsTotal = roundMoney(itemSubtotal(order));
  const discount = orderDiscount(order, productsTotal);
  const otherExpenses = roundMoney(firstMoney(order.outrasDespesas, order.despesasAcessorias, order.despesas));
  const shippingCharged = roundMoney(firstMoney(order.transporte?.frete, order.transporte?.valorFrete, order.frete));
  const marketplaceFee = roundMoney(firstMoney(order.taxas?.taxaComissao, order.taxaComissao));
  const marketplaceShippingCost = roundMoney(firstMoney(order.taxas?.custoFrete, order.custoFrete));
  const calculatedBase = Math.max(0, productsTotal - discount + otherExpenses);
  const explicitBase = firstMoney(order.taxas?.valorBase, order.valorBase);
  const salesBase = roundMoney(explicitBase > 0 ? explicitBase : calculatedBase);
  // No detalhe do Bling, `total` representa "Total da venda" (inclui o
  // frete cobrado do cliente). `totalVenda` pode representar apenas os itens.
  const explicitCustomerTotal = firstMoney(order.total);
  const customerTotal = roundMoney(explicitCustomerTotal > 0
    ? explicitCustomerTotal
    : firstMoney(salesBase + shippingCharged, order.totalVenda, order.totalProdutos));
  const explicitMarketplaceNet = firstMoney(order.taxas?.valorLiquido, order.taxas?.valorLiquidoReceber);
  const marketplaceNet = roundMoney(explicitMarketplaceNet > 0
    ? explicitMarketplaceNet
    : salesBase - marketplaceFee - marketplaceShippingCost);

  return {
    productsTotal,
    discount,
    otherExpenses,
    shippingCharged,
    salesBase,
    customerTotal,
    marketplaceFee,
    marketplaceShippingCost,
    marketplaceNet,
    marketplaceFeePercent: salesBase > 0 ? marketplaceFee / salesBase * 100 : 0,
    marketplaceShippingPercent: salesBase > 0 ? marketplaceShippingCost / salesBase * 100 : 0,
    totalMarketplacePercent: salesBase > 0 ? (marketplaceFee + marketplaceShippingCost) / salesBase * 100 : 0,
  };
}

module.exports = {
  money,
  roundMoney,
  orderDiscount,
  normalizeBlingOrder,
};
