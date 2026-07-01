const axios = require('axios');
const http = require('http');

const PORT = 3001;
const DELAY = 50; // simulated latency

// Mock server for Bling APIs
const server = http.createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/Api/v3/depositos') {
      res.end(JSON.stringify({ data: [{ id: 1, padrao: true }] }));
    } else {
      res.end(JSON.stringify({ success: true }));
    }
  }, DELAY);
});

server.listen(PORT, async () => {
  console.log(`Mock server running on port ${PORT}`);

  // Test target logic here
  const produtos = Array.from({ length: 20 }).map((_, i) => ({
    id: i,
    preco: 10 + i,
    estoque: 5 + i,
    nome: `Produto ${i}`
  }));

  const token = 'fake_token';
  const blingHeaders = () => ({ 'Content-Type': 'application/json' });
  let _depositoId = null;
  async function getDepositoId() { return 1; }

  let changeLog = [];
  function pushLog(log) { changeLog.push(log); }

  console.log('--- BASELINE ---');
  let start = Date.now();
  let success = 0;
  const errors = [];

  for (const p of produtos) {
    try {
      if (p.preco !== undefined && p.preco !== '') {
        await axios.put(`http://localhost:${PORT}/Api/v3/produtos/${p.id}`,
          { preco: Number(p.preco) },
          { headers: blingHeaders(token) }
        );
      }
      if (p.estoque !== undefined && p.estoque !== '') {
        const depositoId = await getDepositoId(token);
        await axios.post(`http://localhost:${PORT}/Api/v3/estoques`,
          { produto: { id: Number(p.id) }, deposito: { id: depositoId }, operacao: 'B', quantidade: Number(p.estoque) },
          { headers: blingHeaders(token) }
        );
      }
      pushLog({ id: p.id });
      success++;
    } catch (err) {
      errors.push(err);
    }
  }
  let timeSequential = Date.now() - start;
  console.log(`Sequential execution time: ${timeSequential}ms`);

  console.log('--- OPTIMIZED ---');
  start = Date.now();
  let successOpt = 0;
  const errorsOpt = [];

  await Promise.all(produtos.map(async (p) => {
    try {
      if (p.preco !== undefined && p.preco !== '') {
        await axios.put(`http://localhost:${PORT}/Api/v3/produtos/${p.id}`,
          { preco: Number(p.preco) },
          { headers: blingHeaders(token) }
        );
      }
      if (p.estoque !== undefined && p.estoque !== '') {
        const depositoId = await getDepositoId(token);
        await axios.post(`http://localhost:${PORT}/Api/v3/estoques`,
          { produto: { id: Number(p.id) }, deposito: { id: depositoId }, operacao: 'B', quantidade: Number(p.estoque) },
          { headers: blingHeaders(token) }
        );
      }
      pushLog({ id: p.id });
      successOpt++;
    } catch (err) {
      errorsOpt.push(err);
    }
  }));

  let timeParallel = Date.now() - start;
  console.log(`Parallel execution time: ${timeParallel}ms`);
  console.log(`Speedup: ${(timeSequential / timeParallel).toFixed(2)}x`);

  server.close();
});
