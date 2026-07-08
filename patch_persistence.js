const fs = require('fs');

let code = fs.readFileSync('index.js', 'utf8');

// Change const to let for the arrays
code = code.replace(/const changeLog = \[\];/g, 'let changeLog = [];');
code = code.replace(/const customContas = \[\];/g, 'let customContas = [];');
code = code.replace(/const calendarEvents = \[\];/g, 'let calendarEvents = [];');

const declarations = `let calendarEvents = [];
let eventIdCounter = 1;`;

const persistenceCode = `
async function loadInMemoryData() {
  const admin = getAdmin();
  if (!admin) return;
  try {
    const doc = await admin.firestore().collection('system').doc('in_memory_data').get();
    if (doc.exists) {
      const data = doc.data();
      if (data.customContas) customContas = data.customContas;
      if (data.calendarEvents) calendarEvents = data.calendarEvents;
      if (data.changeLog) changeLog = data.changeLog;
      if (data.contaIdCounter) contaIdCounter = data.contaIdCounter;
      if (data.eventIdCounter) eventIdCounter = data.eventIdCounter;
    }
  } catch (e) { console.error('Erro ao carregar dados em memoria', e); }
}

let saveTimeout = null;
async function saveInMemoryData() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    const admin = getAdmin();
    if (!admin) return;
    try {
      await admin.firestore().collection('system').doc('in_memory_data').set({
        customContas, calendarEvents, changeLog, contaIdCounter, eventIdCounter
      });
    } catch(e) { console.error('Erro ao salvar dados', e); }
  }, 1000); // debounce 1 second
}

// Start loading
loadInMemoryData();
`;

code = code.replace(declarations, declarations + '\n' + persistenceCode);

// Function to safely inject the save callback
function injectSave(regex) {
  code = code.replace(regex, (match) => {
    if (match.includes('saveInMemoryData()')) return match;
    return match + '\n    saveInMemoryData();';
  });
}

// Inject after modifications
injectSave(/(changeLog\.push\(\{[\s\S]*?\}\);)/g);
injectSave(/(customContas\.push\([^)]+\);)/g);
injectSave(/(calendarEvents\.push\([^)]+\);)/g);
injectSave(/(customContas\.splice\([^)]+\);)/g);
injectSave(/(calendarEvents\.splice\([^)]+\);)/g);

fs.writeFileSync('index.js', code);
console.log('Patch aplicado com sucesso!');
