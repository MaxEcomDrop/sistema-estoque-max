const fs = require('fs');
const lines = fs.readFileSync('C:/Users/Dell/.gemini/antigravity/scratch/sistema-estoque-max/public/dashboard.html', 'utf8').split('\n');
lines.forEach((l, i) => {
  if (
    l.includes('function setLayout') || 
    l.includes('function open') || 
    l.includes('modal') || 
    l.includes('pedido') ||
    l.includes('edraw')
  ) {
    console.log(`${i+1}: ${l.substring(0, 100).trim()}`);
  }
});
