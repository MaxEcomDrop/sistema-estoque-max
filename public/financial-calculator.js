(function financialCalculatorModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FinancialCalculator = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildFinancialCalculator() {
  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function roundMoney(value) {
    return Math.round((number(value) + Number.EPSILON) * 100) / 100;
  }

  function calculateResult(input) {
    const revenue = number(input && input.revenue);
    const productCost = number(input && input.productCost);
    const marketplaceFee = number(input && input.marketplaceFee);
    const shippingCost = number(input && input.shippingCost);
    const otherVariableCost = number(input && input.otherVariableCost);
    const fixedCost = number(input && input.fixedCost);
    const costsComplete = input && input.costsComplete !== false;
    const estimated = Boolean(input && input.estimated);

    const grossMargin = revenue - productCost;
    const variableExpenses = marketplaceFee + shippingCost + otherVariableCost;
    const contributionProfit = grossMargin - variableExpenses;
    const operationalProfit = contributionProfit - fixedCost;
    const contributionMargin = revenue > 0 ? contributionProfit / revenue : 0;

    return {
      revenue: roundMoney(revenue),
      productCost: roundMoney(productCost),
      marketplaceFee: roundMoney(marketplaceFee),
      shippingCost: roundMoney(shippingCost),
      otherVariableCost: roundMoney(otherVariableCost),
      fixedCost: roundMoney(fixedCost),
      grossMargin: roundMoney(grossMargin),
      variableExpenses: roundMoney(variableExpenses),
      contributionProfit: roundMoney(contributionProfit),
      operationalProfit: roundMoney(operationalProfit),
      contributionMargin,
      quality: costsComplete ? (estimated ? 'estimated' : 'real') : 'incomplete',
    };
  }

  function estimateProductCost(soldProducts, catalogProducts, factor) {
    const sold = Array.isArray(soldProducts) ? soldProducts : [];
    const catalog = Array.isArray(catalogProducts) ? catalogProducts : [];
    const projectionFactor = Math.max(1, number(factor) || 1);
    const catalogBySku = new Map();
    catalog.forEach((product) => {
      const sku = String(product && (product.codigo || product.sku) || '').trim();
      if (sku) catalogBySku.set(sku, product);
    });

    let sampleCost = 0;
    let coveredRevenue = 0;
    let totalRevenue = 0;
    let coveredQuantity = 0;
    let totalQuantity = 0;
    const missingSkus = [];

    sold.forEach((item) => {
      const sku = String(item && (item.codigo || item.sku) || '').trim();
      const quantity = Math.max(0, number(item && (item.qtd || item.quantidade)));
      const revenue = Math.max(0, number(item && item.faturamento));
      const product = sku ? catalogBySku.get(sku) : null;
      const unitCost = number(product && (product.precoCusto || product.custo));
      totalRevenue += revenue;
      totalQuantity += quantity;
      if (product && unitCost > 0) {
        sampleCost += unitCost * quantity;
        coveredRevenue += revenue;
        coveredQuantity += quantity;
      } else {
        const missingId = sku || '(item sem SKU)';
        if (!missingSkus.includes(missingId)) missingSkus.push(missingId);
      }
    });

    const coverage = totalRevenue > 0
      ? coveredRevenue / totalRevenue
      : (totalQuantity > 0 ? coveredQuantity / totalQuantity : 0);

    return {
      sampleCost: roundMoney(sampleCost),
      projectedCost: roundMoney(sampleCost * projectionFactor),
      coverage,
      complete: sold.length > 0 && missingSkus.length === 0,
      missingSkus,
      factor: projectionFactor,
    };
  }

  return { calculateResult, estimateProductCost, roundMoney };
}));
