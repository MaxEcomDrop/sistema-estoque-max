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
