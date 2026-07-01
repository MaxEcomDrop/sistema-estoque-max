const fs = require('fs');
const path = require('path');

// 1. Corrigir HTML para forçar light theme
const dashPath = path.join(__dirname, 'public', 'dashboard.html');
let html = fs.readFileSync(dashPath, 'utf8');

// Força o return false para effectiveDark()
html = html.replace(
  /function effectiveDark\(\)\{.*?\}/,
  `function effectiveDark(){return false;}` // Always false
);

// Troca o atributo HTML inicial para light
html = html.replace(/<html data-theme="dark">/g, '<html data-theme="light">');

fs.writeFileSync(dashPath, html, 'utf8');

// 2. Corrigir CSS para voltar as cores White com Roxo Premium
const cssPath = path.join(__dirname, 'public', 'new_style.css');
let css = fs.readFileSync(cssPath, 'utf8');

// The original CSS was generated for dark mode. Let's rewrite the :root colors completely for a premium light mode.
// We must replace the variables inside :root
const lightColors = `
  /* Premium Light Theme */
  --bg: #f8fafc;
  --bg-card: #ffffff;
  --bg-hover: #f1f5f9;
  --bg-active: #e2e8f0;
  
  --text: #0f172a;
  --text-m: #475569;
  --text-d: #94a3b8;
  
  --border: #e2e8f0;
  --border-h: #cbd5e1;
  
  --primary: #8b5cf6;
  --primary-bg: #8b5cf6;
  --primary-text: #ffffff;
  --primary-h: #7c3aed;
  
  --accent: #6366f1;
  --accent-h: #4f46e5;

  --ok: #10b981; --ok-t: #059669;
  --wa: #f59e0b; --wa-t: #d97706;
  --er: #ef4444; --er-t: #dc2626;

  --bord: var(--border);
  --bord-l: var(--bg-hover);
  --tx: var(--text);
  --mu: var(--text-m);
  --fa: var(--text-d);

  --sb-bg: #ffffff;
  --sb-w: 250px;
`;

css = css.replace(/:root\s*\{([\s\S]*?)(?=\})/m, `:root {${lightColors}`);

// Remove the forced dark mode patch from earlier if it exists
css = css.replace(/\[data-theme="light"\] \{ \/\* FORCED DARK MODE \*\/ \}/g, '');

// If there are specific dark mode overrides like [data-theme="dark"] or @media (prefers-color-scheme: dark), they can stay as long as effectiveDark() is false.

fs.writeFileSync(cssPath, css, 'utf8');
console.log('Light Theme Patch applied successfully.');
