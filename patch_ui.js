const fs = require('fs');
const path = 'C:/Users/Dell/.gemini/antigravity/scratch/sistema-estoque-max/public/dashboard.html';
let html = fs.readFileSync(path, 'utf8');

// 1. Fix mobile jumps on setLayout
if(!html.includes('Math.max(cc.clientHeight')) {
  html = html.replace('function setLayout(l){', `function setLayout(l){
  const cc=$('card-container'),lc=$('list-container');
  const h = Math.max(cc.clientHeight, lc.clientHeight);
  if(h > 0) $('view-produtos').style.minHeight = h + 'px';`);
  
  html = html.replace("else{lc.style.display='none';cc.className='card-grid '+(l==='grid'?'vg':'vc');renderCards();}", 
  `else{lc.style.display='none';cc.className='card-grid '+(l==='grid'?'vg':'vc');renderCards();}
  setTimeout(()=>{$('view-produtos').style.minHeight='';}, 50);`);
}

// 2. Fix mobile CSS for tables and modals (if not already patched)
const cssFix = `
@media(max-width:768px){
  .mbox { width: 100% !important; max-width: 100% !important; height: 100% !important; max-height: 100vh !important; border-radius: 0 !important; padding: 20px 16px !important; margin: 0 !important; overflow-y: auto; }
  .modal { padding: 0 !important; }
  .vtable { overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; width: 100%; display: block; }
  .view { padding: 8px !important; overflow-x: hidden !important; width: 100vw !important; box-sizing: border-box !important; }
  table { width: 100% !important; min-width: 600px; }
  .tcard { width: 100% !important; box-sizing: border-box !important; overflow: hidden !important; }
}
`;
if(!html.includes('.mbox { width: 100% !important')) {
  html = html.replace('</style>', cssFix + '\n</style>');
}

// 3. Fix edraw max-width
html = html.replace('max-width:97vw;', 'max-width:100vw;');

fs.writeFileSync(path, html);
console.log('Dashboard HTML patched successfully!');
