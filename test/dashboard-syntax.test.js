const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('scripts inline do dashboard possuem JavaScript válido', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((source) => source.trim());

  assert.ok(scripts.length > 0, 'dashboard sem scripts inline');
  scripts.forEach((source, index) => {
    assert.doesNotThrow(() => new Function(source), `script inline ${index + 1} inválido`);
  });
});

test('painel executivo preserva IDs únicos e indicadores essenciais', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

  assert.deepEqual(duplicates, []);
  [
    'dash-faturamento',
    'dash-lucro',
    'dash-product-cost',
    'dash-marketplace-fee',
    'dash-channel-shipping',
    'dash-profit-order',
    'dash-cancel-rate',
    'dash-cost-coverage',
  ].forEach((id) => assert.match(html, new RegExp(`id="${id}"`)));
});

test('recálculo financeiro usa somente atualizadores disponíveis no próprio escopo', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  const start = html.indexOf('function recomputeDashLucro()');
  const end = html.indexOf('async function loadEnhancedDashboard', start);
  const body = start >= 0 && end > start ? html.slice(start, end) : '';
  assert.ok(body, 'função recomputeDashLucro não encontrada');
  assert.doesNotMatch(body, /\bsetTxt\s*\(/);
});

test('editor preserva imagens persistidas e aceita upload múltiplo', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  assert.match(html, /id="ed-img-file"[^>]*multiple/);
  assert.match(html, /p\.imagemUrls = Array\.isArray\(p\.imagemUrls\)/);
  assert.match(html, /function handleImgFiles\(files\)/);
});

test('produtos exibem lucro real e fornecedor é fixado imediatamente', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  assert.match(html, /Lucro real/);
  assert.match(html, /\/fornecedor`,\{method:'PUT'/);
});

test('novas integrações aparecem nas telas operacionais', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  assert.match(html, /Curva ABC do período/);
  assert.match(html, /Lojas vinculadas no/);
  assert.match(html, /id="fin-allocation-rule"/);
  assert.match(html, /id="ml-edit-modal"/);
  assert.match(html, /function reconcileAllMLStock\(\)/);
  assert.match(html, /function openMLEditor\(id\)/);
  assert.doesNotMatch(html, /function savePedidoEdicao\(/);
});

test('filtro do Início cancela requisições antigas e preserva o período selecionado', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  assert.match(html, /let _dashAbort=null/);
  assert.match(html, /const requestedPeriod=dashPeriod/);
  assert.match(html, /signal:_dashAbort\.signal,cache:'no-store'/);
  assert.match(html, /loadDashTaxas\(requestedPeriod,requestedStart,requestedEnd,reqId\)/);
  assert.doesNotMatch(html, /querySelectorAll\('\.dp-btn'\)\.forEach\(b=>b\.disabled=true\)/);
});

test('logos oficiais e lojas agrupadas são renderizadas nos canais', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  ['bling.png', 'mercado-livre.png', 'tiktok-shop.png', 'shopify.png'].forEach(file => assert.match(html, new RegExp(file.replace('.', '\\.'))));
  assert.match(html, /function uniqueStoreChannels\(channels=\[\]\)/);
  assert.match(html, /renderStoreLogos\(channels\)/);
  assert.match(html, /channelLogo\(p\.canal,'sm'\)/);
});

test('telas de entrada exibem as identidades oficiais fornecidas', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const login = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
  ['bling.png', 'mercado-livre.png', 'tiktok-shop.png', 'shopify.png'].forEach((asset) => {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'assets', 'channels', asset)), `logo ausente: ${asset}`);
  });
  assert.match(index, /assets\/channels\/bling\.png/);
  ['bling', 'mercado-livre', 'tiktok-shop', 'shopify'].forEach((asset) => {
    assert.match(login, new RegExp(`assets/channels/${asset}\\.png`));
  });
});

test('contas financeiras carregam automaticamente e possuem resumo, filtros e baixa rápida', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  ['fin-acc-payable', 'fin-acc-receivable', 'fin-acc-overdue', 'fin-acc-fixed', 'fin-acc-search'].forEach(id => assert.match(html, new RegExp(`id="${id}"`)));
  assert.match(html, /loadFinanceiro\(\);loadContasCustomizadas\(\)/);
  assert.match(html, /function quickSetContaStatus\(id,status\)/);
  assert.doesNotMatch(html, /\.mbox,\.sheet\{animation:popIn/);
});
