const fs = require('fs');
let code = fs.readFileSync('C:/Users/Dell/.gemini/antigravity/scratch/sistema-estoque-max/index.js', 'utf8');

// 1. changeLog in-memory -> Firestore
const changeLogDecl = 'const changeLog = [];';
const pushLogFunc = `const changeLog = [];
function pushLog(logData) {
  const admin = getAdmin();
  if (admin) {
    admin.firestore().collection('historico').add({
      ...logData,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    }).catch(console.error);
  } else {
    logData.timestamp = new Date().toISOString();
    changeLog.push(logData);
  }
}`;
if(!code.includes('function pushLog')) {
  code = code.replace(changeLogDecl, pushLogFunc);
  code = code.replace(/changeLog\.push\(/g, 'pushLog(');
}

// 2. /api/historico endpoint replacement
const oldHistorico = `app.get('/api/historico', requireAuthJson, (req, res) => {
  res.json({ history: changeLog.slice().reverse().slice(0, 300) });
});`;
const newHistorico = `app.get('/api/historico', requireAuthJson, async (req, res) => {
  try {
    const admin = getAdmin();
    if (admin) {
      const snap = await admin.firestore().collection('historico').orderBy('timestamp', 'desc').limit(300).get();
      const history = snap.docs.map(d => {
         const data = d.data();
         if(data.timestamp && data.timestamp.toDate) data.timestamp = data.timestamp.toDate().toISOString();
         return data;
      });
      return res.json({ history });
    }
  } catch(e) { console.error('[Firestore Historico Erro]', e); }
  res.json({ history: changeLog.slice().reverse().slice(0, 300) });
});`;
if(code.includes(oldHistorico)) {
  code = code.replace(oldHistorico, newHistorico);
}

// 3. Rename GET /api/webhook/bling to /api/auth/callback
code = code.replace("app.get('/api/webhook/bling', async (req, res) => {", "app.get('/api/auth/callback', async (req, res) => {");

// 4. Hide traces in sendErrorResponse
if(!code.includes("process.env.NODE_ENV === 'production' ? null : details")) {
  code = code.replace("function sendErrorResponse(res, status, message, details = null) {", `function sendErrorResponse(res, status, message, details = null) {
  if(details) console.error('[Error Details]', details);
  details = process.env.NODE_ENV === 'production' ? null : details;`);
}

// 5. Replace inline error: e.message with generic error
code = code.replace(/error:\s*e\.message/g, "error: process.env.NODE_ENV === 'production' ? 'Erro interno no servidor' : e.message");
code = code.replace(/error:\s*err\.message/g, "error: process.env.NODE_ENV === 'production' ? 'Erro interno no servidor' : err.message");

fs.writeFileSync('C:/Users/Dell/.gemini/antigravity/scratch/sistema-estoque-max/index.js', code);
console.log('Backend patched!');
