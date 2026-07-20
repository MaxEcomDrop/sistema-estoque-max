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
