const fs = require('fs');
const path = require('path');

const dir = 'C:/Users/Dell/.gemini/antigravity/scratch/sistema-estoque-max';

// 1. Rename public/index.html to public/conectar.html
const oldIndexHtml = path.join(dir, 'public', 'index.html');
const newConectarHtml = path.join(dir, 'public', 'conectar.html');
if (fs.existsSync(oldIndexHtml)) {
  fs.renameSync(oldIndexHtml, newConectarHtml);
}

// 2. Patch login.html
const loginPath = path.join(dir, 'public', 'login.html');
let loginHtml = fs.readFileSync(loginPath, 'utf8');
loginHtml = loginHtml.replace("window.location.href = '/';", "window.location.href = '/dashboard.html';");
fs.writeFileSync(loginPath, loginHtml);

// 3. Patch dashboard.html
const dashPath = path.join(dir, 'public', 'dashboard.html');
let dashHtml = fs.readFileSync(dashPath, 'utf8');
dashHtml = dashHtml.replace(/window\.location\.href='\/[^']*'/g, "window.location.href='/conectar.html'");
fs.writeFileSync(dashPath, dashHtml);

// 4. Patch index.js
const indexJsPath = path.join(dir, 'index.js');
let indexJs = fs.readFileSync(indexJsPath, 'utf8');

// Replace the old / routes
const oldRoute1 = "app.get('/', requireAuth, (req, res) => res.sendFile(__dirname + '/public/index.html'));";
const oldRoute2 = "app.get('/index.html', requireAuth, (req, res) => res.sendFile(__dirname + '/public/index.html'));";

const newRoutes = `app.get('/', requireAuth, (req, res) => res.redirect('/dashboard.html'));
app.get('/conectar.html', requireAuth, (req, res) => res.sendFile(__dirname + '/public/conectar.html'));`;

if (indexJs.includes(oldRoute1)) {
  indexJs = indexJs.replace(oldRoute1 + '\\n' + oldRoute2, newRoutes);
  // Just in case they weren't exactly separated by newline:
  indexJs = indexJs.replace(oldRoute1, newRoutes);
  indexJs = indexJs.replace(oldRoute2, '');
}

// Rename in the push notification payload just to be safe
indexJs = indexJs.replace("url = '/dashboard.html'", "url = '/dashboard.html'");

fs.writeFileSync(indexJsPath, indexJs);
console.log("Fluxo de auth atualizado!");
