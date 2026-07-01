const fs = require('fs');
const path = require('path');

const dashPath = path.join(__dirname, 'public', 'dashboard.html');
let html = fs.readFileSync(dashPath, 'utf8');

// 1. Force Dark Mode Theme
html = html.replace(
  /function effectiveDark\(\)\{.*?\}/,
  `function effectiveDark(){return true;}` // Always true
);

// 2. Fix Pedidos Rendering (Remove table wrapping)
html = html.replace(
  /body\.innerHTML=`<div style="overflow-x:auto"><table><thead>.*?<tbody>\$\{rows\}<\/tbody><\/table><\/div>`;/,
  `body.innerHTML = rows;`
);

// 3. Fix Historico Rendering
html = html.replace(
  /body\.innerHTML=`<table><thead>.*?<tbody>\$\{hist\.map\(.*?\)\.join\(''\)\}<\/tbody><\/table>`;/,
  `body.innerHTML = hist.map(h=>\`<tr><td>\${esc(h.produto_nome)}</td><td><span class="h-campo">\${esc(h.campo)}</span></td><td class="h-from">\${esc(h.valor_anterior)}</td><td class="h-to">\${esc(h.valor_novo)}</td><td style="color:var(--fa);font-size:12px">\${new Date(h.timestamp).toLocaleString('pt-BR')}</td></tr>\`).join('');`
);

// 4. Fix Notas Rendering
html = html.replace(
  /body\.innerHTML=`<table><thead>.*?<tbody>\$\{notas\.map\(.*?\)\.join\(''\)\}<\/tbody><\/table>`;/,
  `body.innerHTML = notas.map(n=>{const s=(n.situacao||'').toLowerCase();const cls=s.includes('autoriza')?'nfe-ok':s.includes('cancel')?'nfe-can':'nfe-pen';return\`<tr><td><span class="sku">\${n.numero||n.id}</span></td><td>\${esc(n.serie||'1')}</td><td>\${n.dataEmissao?String(n.dataEmissao).substring(0,10):'—'}</td><td>\${esc(n.contato)}</td><td class="o-val">\${fmt(n.total)}</td><td class="\${cls}">\${esc(n.situacao)}</td><td><span class="nfe-key">\${n.chave?n.chave.substring(0,20)+'…':'—'}</span></td></tr>\`;}).join('');`
);

// 5. Fix Financeiro Margem Rendering
html = html.replace(
  /body\.innerHTML=`<table><thead>.*?<tbody>\$\{([\s\S]*?)\}<\/tbody><\/table>`;/,
  `body.innerHTML = $1;`
);

// 6. Fix Report Rendering
html = html.replace(
  /body\.innerHTML=`<table><thead>.*?<tbody>\$\{zero\.slice\(0,100\)\.map\(.*?\)\.join\(''\)\}<\/tbody><\/table>`;/,
  `body.innerHTML = zero.slice(0,100).map(p=>\`<tr><td><span class="sku">\${esc(p.codigo||'—')}</span></td><td>\${esc(p.nome)}</td><td><span class="ctag">\${esc(p.categoria||'—')}</span></td><td style="text-align:right;font-weight:500;font-variant-numeric:tabular-nums">\${fmt(p.preco)}</td></tr>\`).join('');`
);

// 7. Add Mandatory Login Redirect and force initial dark theme attribute
if (!html.includes('Auth Check')) {
  html = html.replace(
    '<head>',
    `<head>\n  <!-- Auth Check -->\n  <script>if(!document.cookie.includes('token=')){window.location.href='/login.html';}</script>\n`
  );
  html = html.replace(
    '<html>',
    `<html data-theme="dark">`
  );
}

// 8. Fix empty states that used <div> inside <tbody>
html = html.replace(/body\.innerHTML='<div class="st-wrap">.*?<\/div>';/g, match => {
  return match.replace(/<div class="st-wrap">/, '<tr><td colspan="10"><div class="st-wrap">').replace(/<\/div>';/, '</div></td></tr>\';');
});
html = html.replace(/body\.innerHTML=`\s*<div class="empty-state">[\s\S]*?<\/div>\s*`;/g, match => {
  return match.replace(/<div class="empty-state">/, '<tr><td colspan="10"><div class="empty-state">').replace(/<\/div>\s*`;/, '</div></td></tr>`;');
});

// 9. Fix Integrações Tab
if (!html.includes('api/bling/full-sync')) {
  html = html.replace(
    /<div class="dash-sec-t" style="border:none">Integrações<\/div>[\s\S]*?(?=<\/div>\s*<\/div>\s*<\/div>\s*<div class="view" id="view-config">)/,
    `<div class="dash-sec-t" style="border:none">Integrações (Bling ERP)</div>
      <div class="dash-hero" style="grid-template-columns: 1fr; max-width: 600px;">
        <div class="hero-card" style="display:flex; flex-direction:column; gap:20px;">
          <div style="display:flex; align-items:center; gap:20px;">
            <div style="width:60px; height:60px; background:#000; border:1px solid var(--bord); border-radius:16px; display:flex; align-items:center; justify-content:center;">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
            </div>
            <div>
              <h3 style="margin:0; font-size:18px; color:var(--tx)">Conexão Bling API v3</h3>
              <p style="margin:4px 0 0 0; color:var(--mu); font-size:14px;">Obrigatório para sincronizar produtos, pedidos, notas e financeiro.</p>
            </div>
          </div>
          <button class="st-btn" style="width:100%; padding:14px; background:linear-gradient(135deg, #6366f1, #8b5cf6); color:white; font-weight:600; font-size:15px; border-radius:12px; cursor:pointer;" onclick="window.location.href='/api/auth/bling'">
             AUTENTICAR COM BLING E SINCRONIZAR TUDO
          </button>
        </div>
      </div>
    `
  );
}

fs.writeFileSync(dashPath, html, 'utf8');
console.log('Frontend patch applied successfully.');
