const fs = require('fs');
const path = 'C:/Users/Dell/.gemini/antigravity/scratch/sistema-estoque-max/index.js';
let code = fs.readFileSync(path, 'utf8');

// Adicionar a rota antiga como alias para o callback
if(!code.includes("app.get('/api/webhook/bling'")) {
  code = code.replace(
    "app.get('/api/auth/callback', async (req, res) => {",
    "app.get(['/api/auth/callback', '/api/webhook/bling'], async (req, res) => {"
  );
  fs.writeFileSync(path, code);
  console.log('Rotas corrigidas!');
} else {
  console.log('Rota ja existia!');
}
