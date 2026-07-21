'use strict';

const { normalizeBlingOrder } = require('./bling-order');

const money = value => Math.round((Number(value) || 0) * 100) / 100;
const normalizeSku = value => String(value || '').trim().toUpperCase();

function buildSalesFact(order, options = {}) {
  const financial = normalizeBlingOrder(order || {});
  const costBySku = options.costBySku || {};
  const imageBySku = options.imageBySku || {};
  const channelById = options.channelById || {};
  const rawItems = Array.isArray(order?.itens) ? order.itens : [];
  const grossItems = rawItems.reduce((sum, item) => {
    return sum + (Number(item?.quantidade) || 0) * (Number(item?.valor) || 0);
  }, 0);
  const denominator = grossItems > 0 ? grossItems : 1;

  const items = rawItems.map(item => {
    const sku = normalizeSku(item?.codigo || item?.produto?.codigo);
    const quantity = Number(item?.quantidade) || 0;
    const unitPrice = Number(item?.valor) || 0;
    const grossRevenue = quantity * unitPrice;
    const share = grossRevenue / denominator;
    const revenue = financial.salesBase * share;
    const unitCost = Number(costBySku[sku]?.cost ?? costBySku[sku] ?? 0) || 0;
    const costTotal = unitCost * quantity;
    const fee = financial.marketplaceFee * share;
    const channelShipping = financial.marketplaceShippingCost * share;
    return {
      sku,
      productId: item?.produto?.id || costBySku[sku]?.productId || null,
      name: item?.descricao || item?.produto?.nome || 'Item',
      imageUrl: imageBySku[sku] || costBySku[sku]?.imageUrl || '',
      quantity,
      unitPrice: money(unitPrice),
      grossRevenue: money(grossRevenue),
      revenue: money(revenue),
      unitCost: money(unitCost),
      costTotal: money(costTotal),
      marketplaceFee: money(fee),
      channelShippingCost: money(channelShipping),
      profitBeforeFixed: money(revenue - costTotal - fee - channelShipping),
    };
  });

  const channelId = String(order?.loja?.id || '0');
  const channelName = order?.loja?.nome || channelById[channelId] || null;
  const cmv = items.reduce((sum, item) => sum + item.costTotal, 0);
  const profitBeforeFixed = financial.salesBase - cmv - financial.marketplaceFee - financial.marketplaceShippingCost;

  return {
    id: String(order?.id || order?.numero || ''),
    number: order?.numero || null,
    date: String(order?.data || order?.dataPedido || '').slice(0, 10),
    status: options.status || '',
    statusCategory: options.statusCategory || 'pendente',
    channelId,
    channelName,
    customerId: order?.contato?.id || null,
    customerName: order?.contato?.nome || '',
    salesBase: money(financial.salesBase),
    customerTotal: money(financial.customerTotal),
    productsTotal: money(financial.productsTotal),
    discount: money(financial.discount),
    customerShipping: money(financial.shippingCharged),
    otherExpenses: money(financial.otherExpenses),
    marketplaceFee: money(financial.marketplaceFee),
    marketplaceShippingCost: money(financial.marketplaceShippingCost),
    marketplaceNet: money(financial.marketplaceNet),
    cmv: money(cmv),
    profitBeforeFixed: money(profitBeforeFixed),
    marginBeforeFixed: financial.salesBase > 0 ? money((profitBeforeFixed / financial.salesBase) * 100) : 0,
    items,
    costSnapshotComplete: items.every(item => item.sku && item.unitCost > 0),
  };
}

function buildAbc(items) {
  const sorted = [...items].filter(item => item.revenue > 0).sort((a, b) => b.revenue - a.revenue);
  const total = sorted.reduce((sum, item) => sum + item.revenue, 0);
  let accumulated = 0;
  return sorted.map(item => {
    const before = total ? accumulated / total : 0;
    accumulated += item.revenue;
    const classification = before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C';
    return { ...item, classification, participation: total ? money((item.revenue / total) * 100) : 0, accumulated: total ? money((accumulated / total) * 100) : 0 };
  });
}

function aggregateSalesFacts(facts, options = {}) {
  const valid = (facts || []).filter(f => f && f.statusCategory !== 'cancelado');
  const fixedCosts = Math.max(0, Number(options.fixedCosts) || 0);
  const allocationRule = ['revenue', 'order', 'unit'].includes(options.allocationRule) ? options.allocationRule : 'revenue';
  const totals = valid.reduce((acc, fact) => {
    acc.revenue += Number(fact.salesBase) || 0;
    acc.customerTotal += Number(fact.customerTotal) || 0;
    acc.fees += Number(fact.marketplaceFee) || 0;
    acc.channelShipping += Number(fact.marketplaceShippingCost) || 0;
    acc.customerShipping += Number(fact.customerShipping) || 0;
    acc.discount += Number(fact.discount) || 0;
    acc.cmv += Number(fact.cmv) || 0;
    acc.units += (fact.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    return acc;
  }, { revenue: 0, customerTotal: 0, fees: 0, channelShipping: 0, customerShipping: 0, discount: 0, cmv: 0, units: 0 });

  const productMap = new Map();
  const channelMap = new Map();
  const byDay = {};
  for (const fact of valid) {
    byDay[fact.date] = money((byDay[fact.date] || 0) + (Number(fact.salesBase) || 0));
    const channelKey = fact.channelId || '0';
    const channel = channelMap.get(channelKey) || { channelId: channelKey, channelName: fact.channelName || 'Sem canal', orders: 0, revenue: 0, fees: 0, shipping: 0, cmv: 0, profit: 0 };
    channel.orders += 1;
    channel.revenue += Number(fact.salesBase) || 0;
    channel.fees += Number(fact.marketplaceFee) || 0;
    channel.shipping += Number(fact.marketplaceShippingCost) || 0;
    channel.cmv += Number(fact.cmv) || 0;
    channel.profit += Number(fact.profitBeforeFixed) || 0;
    channelMap.set(channelKey, channel);
    for (const item of fact.items || []) {
      const key = item.sku || `ID:${item.productId || item.name}`;
      const product = productMap.get(key) || { sku: item.sku, productId: item.productId, name: item.name, imageUrl: item.imageUrl || '', quantity: 0, revenue: 0, cmv: 0, fees: 0, shipping: 0, profitBeforeFixed: 0 };
      product.quantity += Number(item.quantity) || 0;
      product.revenue += Number(item.revenue) || 0;
      product.cmv += Number(item.costTotal) || 0;
      product.fees += Number(item.marketplaceFee) || 0;
      product.shipping += Number(item.channelShippingCost) || 0;
      product.profitBeforeFixed += Number(item.profitBeforeFixed) || 0;
      productMap.set(key, product);
    }
  }

  const products = [...productMap.values()];
  const divisor = allocationRule === 'order' ? valid.length : allocationRule === 'unit' ? totals.units : totals.revenue;
  for (const product of products) {
    const weightBase = allocationRule === 'order'
      ? valid.filter(f => (f.items || []).some(i => (i.sku || `ID:${i.productId || i.name}`) === (product.sku || `ID:${product.productId || product.name}`))).length
      : allocationRule === 'unit' ? product.quantity : product.revenue;
    product.fixedCostAllocated = divisor > 0 ? money(fixedCosts * weightBase / divisor) : 0;
    product.realProfit = money(product.profitBeforeFixed - product.fixedCostAllocated);
    product.realMargin = product.revenue > 0 ? money(product.realProfit / product.revenue * 100) : 0;
  }

  const profitBeforeFixed = totals.revenue - totals.cmv - totals.fees - totals.channelShipping;
  const realProfit = profitBeforeFixed - fixedCosts;
  const contributionMargin = totals.revenue > 0 ? (totals.revenue - totals.cmv - totals.fees - totals.channelShipping) / totals.revenue : 0;
  return {
    totals: Object.fromEntries(Object.entries({ ...totals, fixedCosts, profitBeforeFixed, realProfit, realMargin: totals.revenue > 0 ? realProfit / totals.revenue * 100 : 0, breakEven: contributionMargin > 0 ? fixedCosts / contributionMargin : 0 }).map(([key, value]) => [key, money(value)])),
    allocationRule,
    orders: valid.length,
    byDay,
    channels: [...channelMap.values()].map(channel => Object.fromEntries(Object.entries(channel).map(([key, value]) => [key, typeof value === 'number' ? money(value) : value]))).sort((a, b) => b.revenue - a.revenue),
    products: products.sort((a, b) => b.revenue - a.revenue),
    abc: buildAbc(products),
    costSnapshotComplete: valid.every(f => f.costSnapshotComplete),
  };
}

module.exports = { aggregateSalesFacts, buildAbc, buildSalesFact, money, normalizeSku };
