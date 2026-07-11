// REVIEW DASHBOARD LOGIC
const BACKEND_URL = "https://sistema-estoque-max.vercel.app";

let erpProducts = [];
let scannedProducts = [];
let matchedResults = [];
let token = "";

document.addEventListener('DOMContentLoaded', async () => {
  const tableBody = document.getElementById('table-body');
  const statScanned = document.getElementById('stat-scanned');
  const statMatched = document.getElementById('stat-matched');
  const statChanged = document.getElementById('stat-changed');
  const statImpact = document.getElementById('stat-impact');
  
  const checkAll = document.getElementById('check-all');
  const bulkBar = document.getElementById('bulk-bar');
  const selectedCountSpan = document.getElementById('selected-count');
  
  const filterChanged = document.getElementById('filter-changed');
  const filterConfidence = document.getElementById('filter-confidence');
  const searchInput = document.getElementById('search-input');
  
  const btnReload = document.getElementById('btn-reload');
  const btnCloseAnomaly = document.getElementById('btn-close-anomaly');
  const modalAnomaly = document.getElementById('modal-anomaly');

  // Load state and run match
  const state = await chrome.storage.local.get(['token', 'scannedProducts', 'scannedDomain']);
  token = state.token;
  scannedProducts = state.scannedProducts || [];
  
  if (!token) {
    tableBody.innerHTML = '<tr><td colspan="9" class="loading-state text-danger">Erro: Você não está logado no MAX ERP. Faça login na extensão primeiro.</td></tr>';
    return;
  }

  if (scannedProducts.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="9" class="loading-state">Nenhum produto escaneado nesta sessão. Abra o catálogo de um fornecedor e inicie a varredura.</td></tr>';
    return;
  }

  // Load ERP Products and match
  await loadAndMatch();

  // Listeners
  btnReload.addEventListener('click', loadAndMatch);
  
  checkAll.addEventListener('change', (e) => {
    const checkboxes = document.querySelectorAll('.product-check');
    checkboxes.forEach(cb => cb.checked = e.target.checked);
    updateBulkBar();
  });

  filterChanged.addEventListener('change', filterTable);
  filterConfidence.addEventListener('change', filterTable);
  searchInput.addEventListener('input', filterTable);

  btnCloseAnomaly.addEventListener('click', () => modalAnomaly.classList.add('hidden'));

  // BULK ACTIONS
  document.getElementById('bulk-sync-all').addEventListener('click', () => executeBulkSync('all'));
  document.getElementById('bulk-sync-cost').addEventListener('click', () => executeBulkSync('cost'));
  document.getElementById('bulk-sync-stock').addEventListener('click', () => executeBulkSync('stock'));

  // IMAGE SCAN / OCR HANDLERS
  const btnUploadImage = document.getElementById('btn-upload-image');
  const imageUpload = document.getElementById('image-upload');
  const modalOcr = document.getElementById('modal-ocr');
  const ocrProgressBar = document.getElementById('ocr-progress-bar');
  const ocrProgressPercent = document.getElementById('ocr-progress-percent');
  const ocrStatusTitle = document.getElementById('ocr-status-title');

  btnUploadImage.addEventListener('click', () => {
    imageUpload.click();
  });

  imageUpload.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    modalOcr.classList.remove('hidden');
    ocrProgressBar.style.width = '0%';
    ocrProgressPercent.textContent = '0%';
    ocrStatusTitle.textContent = 'Carregando Tesseract OCR...';

    try {
      const result = await Tesseract.recognize(
        file,
        'por',
        {
          logger: m => {
            if (m.status === 'recognizing text') {
              const progress = Math.round(m.progress * 100);
              ocrProgressBar.style.width = `${progress}%`;
              ocrProgressPercent.textContent = `${progress}%`;
              ocrStatusTitle.textContent = 'Extraindo texto da imagem...';
            }
          }
        }
      );

      const text = result.data.text;
      console.log("[OCR TEXT]", text);

      ocrStatusTitle.textContent = 'Analisando dados do catálogo...';
      const parsedProducts = parseOCRText(text);

      if (parsedProducts.length === 0) {
        alert("Não foi possível identificar produtos na imagem. Verifique se o preço e o SKU/Código estão visíveis.");
      } else {
        scannedProducts = parsedProducts;
        toast(`${parsedProducts.length} produtos identificados!`);
        runMatchEngine();
        renderTable();
        updateKPIs();
      }
    } catch (err) {
      alert("Erro ao ler imagem: " + err.message);
    } finally {
      modalOcr.classList.add('hidden');
      imageUpload.value = "";
    }
  });

  // PDF SCAN HANDLERS — abre o PDF, lê da página 1 até a ÚLTIMA (nunca pula
  // nenhuma) e extrai o texto real do documento (não é OCR: pdf.js lê o
  // texto embutido no PDF, muito mais preciso e rápido que reconhecer
  // imagem). PDFs que são só imagem escaneada (sem camada de texto) não têm
  // o que extrair aqui — para esses, use "Escanear Foto de Catálogo".
  const btnUploadPdf = document.getElementById('btn-upload-pdf');
  const pdfUpload = document.getElementById('pdf-upload');

  btnUploadPdf.addEventListener('click', () => {
    pdfUpload.click();
  });

  pdfUpload.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    modalOcr.classList.remove('hidden');
    ocrProgressBar.style.width = '0%';
    ocrProgressPercent.textContent = '0%';
    ocrStatusTitle.textContent = 'Abrindo PDF...';
    const ocrSubtitle = document.getElementById('ocr-status-subtitle');
    if (ocrSubtitle) ocrSubtitle.textContent = 'Carregando arquivo…';

    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const numPages = pdf.numPages;
      let allProducts = [];

      // Loop de 1 até numPages, sempre — nenhuma condição de saída antecipada.
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        ocrStatusTitle.textContent = `Lendo página ${pageNum} de ${numPages}...`;
        const pct = Math.round((pageNum / numPages) * 100);
        ocrProgressBar.style.width = pct + '%';
        ocrProgressPercent.textContent = pct + '%';

        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        allProducts = allProducts.concat(parsePdfPageProducts(textContent.items, pageNum));
      }

      if (allProducts.length === 0) {
        alert("Não foi possível identificar produtos no PDF. Verifique se o preço e o código/SKU aparecem como texto — PDFs 100% imagem (escaneados) não têm texto pra extrair; use \"Escanear Foto de Catálogo\" nesse caso.");
      } else {
        scannedProducts = allProducts;
        toast(`${allProducts.length} produtos identificados em ${numPages} página(s)!`);
        runMatchEngine();
        renderTable();
        updateKPIs();
      }
    } catch (err) {
      alert("Erro ao ler PDF: " + err.message);
    } finally {
      modalOcr.classList.add('hidden');
      pdfUpload.value = "";
    }
  });

  function parsePdfPageProducts(items, pageNum) {
    // pdf.js devolve os fragmentos de texto na ORDEM DE DESENHO do PDF, não
    // na ordem de leitura — concatenar tudo em sequência espalha colunas de
    // uma tabela em qualquer ordem. Agrupamos por Y (mesma linha visual,
    // tolerância de poucos px) e ordenamos por X dentro da linha, pra
    // reconstruir a leitura esquerda→direita, topo→baixo — essencial pra
    // catálogos em tabela (nome | SKU | preço | estoque em colunas).
    const rows = [];
    items.forEach(it => {
      const y = Math.round(it.transform[5]);
      let row = rows.find(r => Math.abs(r.y - y) <= 3);
      if (!row) { row = { y, parts: [] }; rows.push(row); }
      row.parts.push({ x: it.transform[4], text: it.str });
    });
    rows.sort((a, b) => b.y - a.y); // Y do PDF cresce de baixo pra cima
    const lines = rows
      .map(r => r.parts.sort((a, b) => a.x - b.x).map(p => p.text).join(' ').replace(/\s+/g, ' ').trim())
      .filter(l => l.length > 0);

    const products = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const priceMatch = line.match(/(?:R\$|\$)\s*([\d.]+,\d{2})/i) ||
                         line.match(/(?:R\$|\$)\s*([\d.]+\.\d{2})/i) ||
                         line.match(/([\d.]+,\d{2})\b/);
      if (!priceMatch) continue;

      const price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
      if (!price || price <= 0) continue;

      const cleanedLine = line.replace(priceMatch[0], '').trim();
      let name = cleanedLine.length > 5 ? cleanedLine : (i > 0 ? lines[i - 1] : '');

      const contextText = line + ' ' + (i > 0 ? lines[i - 1] : '') + ' ' + (i < lines.length - 1 ? lines[i + 1] : '');
      const eanMatch = contextText.match(/\b\d{13}\b/);
      const ean = eanMatch ? eanMatch[0] : '';

      let sku = '';
      const skuMatch = contextText.match(/(?:Ref|SKU|Cod|Código)[\s:]*([A-Za-z0-9-_]+)/i);
      if (skuMatch) {
        sku = skuMatch[1];
      } else {
        const genericCodeMatch = contextText.match(/\b([A-Z0-9-]{4,10})\b/i);
        if (genericCodeMatch && isNaN(genericCodeMatch[0]) && !genericCodeMatch[0].includes('$')) {
          sku = genericCodeMatch[0];
        }
      }
      if (!sku) sku = 'PDF-' + hashString(name || 'Item').slice(0, 8).toUpperCase();
      if (!name) name = 'Item ' + sku;

      products.push({
        id: 'pdf_' + pageNum + '_' + i + '_' + Date.now(),
        nome: name.trim(),
        sku, ean, cost: price,
        imageUrl: '', productUrl: '',
        supplierName: 'PDF_CATALOGO_pg' + pageNum
      });
    }
    return products;
  }

  function parseOCRText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const products = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const priceMatch = line.match(/(?:R\$|\$)\s*([\d.]+,\d{2})/i) || 
                         line.match(/(?:R\$|\$)\s*([\d.]+\.\d{2})/i) || 
                         line.match(/([\d.]+,\d{2})/);
                         
      if (priceMatch) {
        const price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
        let name = "";
        let sku = "";
        let ean = "";
        
        let cleanedLine = line.replace(priceMatch[0], '').trim();
        if (cleanedLine.length > 5) {
          name = cleanedLine;
        } else if (i > 0 && lines[i-1].length > 5) {
          name = lines[i-1];
        }
        
        const contextText = line + " " + (i > 0 ? lines[i-1] : "") + " " + (i < lines.length - 1 ? lines[i+1] : "");
        const eanMatch = contextText.match(/\b\d{13}\b/);
        if (eanMatch) ean = eanMatch[0];
        
        const skuMatch = contextText.match(/(?:Ref|SKU|Cod|Código)[\s:]*([A-Za-z0-9-_]+)/i);
        if (skuMatch) {
          sku = skuMatch[1];
        } else {
          const genericCodeMatch = contextText.match(/\b([A-Z0-9-]{4,10})\b/i);
          if (genericCodeMatch && isNaN(genericCodeMatch[0]) && !genericCodeMatch[0].includes('$')) {
            sku = genericCodeMatch[0];
          }
        }
        
        if (!sku) {
          sku = "OCR-" + hashString(name || "Item").slice(0, 8).toUpperCase();
        }
        if (!name) {
          name = "Item " + sku;
        }
        
        products.push({
          id: "ocr_" + i + "_" + Date.now(),
          nome: name.trim(),
          sku: sku,
          ean: ean,
          cost: price,
          imageUrl: "",
          productUrl: "",
          supplierName: "FOTO_CATALOGO"
        });
      }
    }
    return products;
  }

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }

  // LOAD & MATCH ENGINE
  async function loadAndMatch() {
    tableBody.innerHTML = '<tr><td colspan="9" class="loading-state">Baixando produtos do MAX ERP...</td></tr>';
    
    try {
      const res = await fetch(`${BACKEND_URL}/api/produtos`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (res.status === 401) throw new Error("Não autorizado. Por favor faça login novamente.");
      const data = await res.json();
      erpProducts = data.products || [];
      
      runMatchEngine();
      renderTable();
      updateKPIs();
    } catch (e) {
      tableBody.innerHTML = `<tr><td colspan="9" class="loading-state text-danger">Erro ao carregar banco do ERP: ${e.message}</td></tr>`;
    }
  }

  function runMatchEngine() {
    // Índices O(1) por EAN/SKU montados uma vez — com catálogos de 10k+
    // produtos, escanear erpProducts inteiro pra CADA item escaneado (e
    // ainda rodar Jaro-Winkler O(n*m) em cima) trava a aba. Só cai pro
    // Jaro-Winkler (linear, mais caro) quando EAN/SKU não bateram.
    const byEan = new Map();
    const bySku = new Map();
    erpProducts.forEach(p => {
      if (p.gtin) byEan.set(String(p.gtin), p);
      if (p.codigo) bySku.set(String(p.codigo).toLowerCase(), p);
    });

    matchedResults = scannedProducts.map(sc => {
      let match = null;
      let score = 0;
      let matchMethod = "";

      // 1. Match por EAN/GTIN se disponível
      if (sc.ean && byEan.has(String(sc.ean))) {
        match = byEan.get(String(sc.ean));
        score = 1.0;
        matchMethod = "EAN";
      }

      // 2. Match por SKU/Código Fornecedor
      if (!match && sc.sku && bySku.has(String(sc.sku).toLowerCase())) {
        match = bySku.get(String(sc.sku).toLowerCase());
        score = 1.0;
        matchMethod = "SKU";
      }

      // 3. Match Semântico por Similaridade de Nome (Jaro-Winkler)
      if (!match) {
        let bestMatch = null;
        let bestScore = 0;

        erpProducts.forEach(p => {
          const sim = jaroWinkler(sc.nome, p.nome);
          if (sim > bestScore) {
            bestScore = sim;
            bestMatch = p;
          }
        });

        // Só considera matching semântico válido se passar do threshold mínimo (70%)
        if (bestScore >= 0.70) {
          match = bestMatch;
          score = bestScore;
          matchMethod = "Semântico";
        }
      }

      // Calcular impactos financeiros e anomalias
      let hasChanges = false;
      let costChanged = false;
      let stockChanged = false;
      let priceDiff = 0;
      let priceDiffPct = 0;
      let marginImpact = 0;
      let profitImpact = 0;
      let anomalies = [];

      if (match) {
        // Mudança de Custo
        const oldCost = match.precoCusto || 0;
        const newCost = sc.cost || 0;
        costChanged = Math.abs(oldCost - newCost) > 0.01;
        priceDiff = newCost - oldCost;
        if (oldCost > 0) priceDiffPct = (priceDiff / oldCost) * 100;
        
        // Detecção de Anomalias de Custo
        if (newCost <= 0) {
          anomalies.push("Custo zerado ou negativo no fornecedor.");
        } else if (oldCost > 0 && priceDiffPct >= 150) {
          anomalies.push(`Custo aumentou ${priceDiffPct.toFixed(0)}% (Anômalo).`);
        }

        // Mudança de Estoque (Se capturado pela varredura)
        if (sc.stock !== undefined) {
          const oldStock = match.estoque || 0;
          const newStock = sc.stock || 0;
          stockChanged = oldStock !== newStock;
          
          if (oldStock > 10 && newStock <= 1) {
            anomalies.push(`Estoque despencou de ${oldStock} para ${newStock}.`);
          }
        }

        hasChanges = costChanged || stockChanged;

        // Cálculos de Margem de Venda
        const sellPrice = match.preco || 0;
        if (sellPrice > 0) {
          const oldMargin = (sellPrice - oldCost) / sellPrice;
          const newMargin = (sellPrice - newCost) / sellPrice;
          marginImpact = (newMargin - oldMargin) * 100; // Variação em %
          
          const oldProfit = sellPrice - oldCost;
          const newProfit = sellPrice - newCost;
          profitImpact = newProfit - oldProfit; // Valor em R$
        }
      }

      return {
        scanned: sc,
        erp: match,
        score: score,
        matchMethod: matchMethod,
        hasChanges: hasChanges,
        costChanged: costChanged,
        stockChanged: stockChanged,
        priceDiff: priceDiff,
        priceDiffPct: priceDiffPct,
        marginImpact: marginImpact,
        profitImpact: profitImpact,
        anomalies: anomalies
      };
    });
  }

  // RENDER TABLE
  function renderTable() {
    tableBody.innerHTML = "";
    
    if (matchedResults.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="9" class="loading-state">Nenhum produto correspondente.</td></tr>';
      return;
    }

    matchedResults.forEach((res) => {
      const tr = document.createElement('tr');
      tr.id = `row-${res.scanned.id}`;
      
      const isSelectable = res.erp && res.score >= 0.70;
      const confidencePercent = Math.round(res.score * 100);
      
      let confidenceClass = "low";
      if (res.score >= 0.90) confidenceClass = "high";
      else if (res.score >= 0.70) confidenceClass = "medium";
      
      // Montagem do bloco de fotos (Fornecedor -> ERP)
      const scannedImg = res.scanned.imageUrl ? `<img class="img-round" src="${res.scanned.imageUrl}">` : '<div class="img-round" style="display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--mu)">Forn</div>';
      const erpImg = res.erp?.imagemUrl ? `<img class="img-round" src="${res.erp.imagemUrl}">` : '<div class="img-round" style="display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--mu)">ERP</div>';
      
      // Status Badge
      let statusBadge = `<span class="badge">Nenhum Vínculo</span>`;
      if (res.erp) {
        if (res.anomalies.length > 0) {
          statusBadge = `<span class="badge badge-danger show-anomaly" style="cursor:pointer" data-id="${res.scanned.id}">⚠️ Anomalia</span>`;
        } else if (res.costChanged && res.stockChanged) {
          statusBadge = `<span class="badge badge-warning">Custo + Est.</span>`;
        } else if (res.costChanged) {
          statusBadge = `<span class="badge badge-warning">Custo Alterado</span>`;
        } else if (res.stockChanged) {
          statusBadge = `<span class="badge badge-info">Estoque Alt.</span>`;
        } else {
          statusBadge = `<span class="badge badge-success">Sem Alterações</span>`;
        }
      }

      // Lucro e margem
      let marginContent = "—";
      if (res.erp && res.erp.preco > 0) {
        const diffColor = res.profitImpact >= 0 ? "text-success" : "text-danger";
        const sign = res.profitImpact >= 0 ? "+" : "";
        marginContent = `
          <div class="cost-new">Margem: ${(res.marginImpact + ((res.erp.preco - res.scanned.cost)/res.erp.preco)*100).toFixed(0)}%</div>
          <span class="margin-diff ${diffColor}">${sign}${res.marginImpact.toFixed(1)}% (${sign}R$ ${res.profitImpact.toFixed(2)})</span>
        `;
      }

      tr.innerHTML = `
        <td>${isSelectable ? `<input type="checkbox" class="product-check" data-id="${res.scanned.id}">` : ''}</td>
        <td>
          <div class="image-pair">
            ${scannedImg}
            <span class="img-arrow">→</span>
            ${erpImg}
          </div>
        </td>
        <td>
          <div class="product-cell">
            <span class="prod-title">${res.scanned.nome}</span>
            <span class="prod-subtitle">${res.erp ? `ERP: ${res.erp.nome}` : 'Não cadastrado no ERP'}</span>
          </div>
        </td>
        <td>
          <div class="sku-cell">
            <strong>Forn:</strong> ${res.scanned.sku || '—'}<br>
            <strong>ERP:</strong> ${res.erp?.codigo || '—'}
          </div>
        </td>
        <td>
          <div class="cost-pair">
            <span class="cost-current">${res.erp ? `R$ ${res.erp.precoCusto.toFixed(2)}` : 'R$ —'}</span>
            <span class="cost-new">R$ ${res.scanned.cost.toFixed(2)}</span>
            ${res.erp && res.costChanged ? `<span class="cost-diff ${res.priceDiff >= 0 ? 'up' : 'down'}">${res.priceDiff >= 0 ? '▲' : '▼'} ${Math.abs(res.priceDiffPct).toFixed(1)}%</span>` : ''}
          </div>
        </td>
        <td>${marginContent}</td>
        <td><span class="score-badge ${confidenceClass}">${confidencePercent}% (${res.matchMethod || 'Nenhum'})</span></td>
        <td>${statusBadge}</td>
        <td>
          ${isSelectable ? `
            <button class="btn btn-primary btn-sync-single" data-id="${res.scanned.id}" style="height:28px;font-size:11px;padding:0 8px;">Sincronizar</button>
          ` : `
            <button class="btn btn-secondary" disabled style="height:28px;font-size:11px;padding:0 8px;">Vincular Manual</button>
          `}
        </td>
      `;
      tableBody.appendChild(tr);
    });

    // Add Checkbox listeners
    document.querySelectorAll('.product-check').forEach(cb => {
      cb.addEventListener('change', updateBulkBar);
    });

    // Anomaly Click Listeners
    document.querySelectorAll('.show-anomaly').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-id');
        const match = matchedResults.find(r => r.scanned.id === id);
        if (match) {
          const detailDiv = document.getElementById('anomaly-details');
          detailDiv.innerHTML = match.anomalies.map(a => `<div class="anomaly-item">${a}</div>`).join('');
          modalAnomaly.classList.remove('hidden');
        }
      });
    });

    // Single Sync Listener
    document.querySelectorAll('.btn-sync-single').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        btn.disabled = true;
        btn.textContent = "Gravando...";
        
        const success = await syncProducts([id], 'all');
        if (success) {
          btn.textContent = "OK";
          btn.className = "btn btn-secondary";
          // Remarcar status
          const row = document.getElementById(`row-${id}`);
          const cb = row.querySelector('.product-check');
          if (cb) cb.remove();
          row.style.opacity = "0.6";
        } else {
          btn.disabled = false;
          btn.textContent = "Sincronizar";
        }
      });
    });
  }

  function updateBulkBar() {
    const selected = document.querySelectorAll('.product-check:checked');
    selectedCountSpan.textContent = selected.length;
    if (selected.length > 0) {
      bulkBar.classList.remove('hidden');
    } else {
      bulkBar.classList.add('hidden');
    }
  }

  function updateKPIs() {
    statScanned.textContent = scannedProducts.length;
    
    const matched = matchedResults.filter(r => r.erp).length;
    statMatched.textContent = matched;

    const changed = matchedResults.filter(r => r.erp && r.hasChanges).length;
    statChanged.textContent = changed;

    // Calcular ganho total estimado se atualizarmos custos menores
    let totalImpact = 0;
    matchedResults.forEach(r => {
      if (r.erp && r.costChanged) {
        // Estimamos o ganho somando a variação positiva de lucro
        // Se o custo caiu (priceDiff < 0), aumentamos nosso lucro
        // Se o custo subiu (priceDiff > 0), perdemos lucro
        totalImpact += (r.profitImpact || 0) * (r.erp.estoque || 1); // Impacto real pelo estoque atual
      }
    });

    const isPositive = totalImpact >= 0;
    statImpact.textContent = `${isPositive ? '+' : ''} R$ ${totalImpact.toFixed(2)}`;
    statImpact.className = `kpi-num ${isPositive ? 'text-success' : 'text-danger'}`;
  }

  function filterTable() {
    const changedVal = filterChanged.value;
    const confidenceVal = filterConfidence.value;
    const query = searchInput.value.toLowerCase().trim();

    const rows = document.querySelectorAll('#table-body tr');
    
    matchedResults.forEach((res) => {
      const row = document.getElementById(`row-${res.scanned.id}`);
      if (!row) return;

      let show = true;

      // 1. Mudanças
      if (changedVal === 'changed' && !res.hasChanges) show = false;
      else if (changedVal === 'cost_changed' && !res.costChanged) show = false;
      else if (changedVal === 'stock_changed' && !res.stockChanged) show = false;
      else if (changedVal === 'new_products' && res.erp) show = false;
      else if (changedVal === 'anomaly' && res.anomalies.length === 0) show = false;

      // 2. Confiança
      const score = res.score;
      if (confidenceVal === 'high' && score < 0.90) show = false;
      else if (confidenceVal === 'medium' && (score < 0.70 || score >= 0.90)) show = false;
      else if (confidenceVal === 'low' && score >= 0.70) show = false;

      // 3. Search query
      if (query) {
        const inScanned = res.scanned.nome.toLowerCase().includes(query) || (res.scanned.sku && res.scanned.sku.toLowerCase().includes(query));
        const inErp = res.erp && (res.erp.nome.toLowerCase().includes(query) || (res.erp.codigo && res.erp.codigo.toLowerCase().includes(query)));
        if (!inScanned && !inErp) show = false;
      }

      if (show) row.classList.remove('hidden');
      else row.classList.add('hidden');
    });
  }

  // BULK SYNC PROCESSOR
  async function executeBulkSync(mode) {
    const selected = Array.from(document.querySelectorAll('.product-check:checked')).map(cb => cb.getAttribute('data-id'));
    if (selected.length === 0) return;

    const btn = document.getElementById('bulk-sync-all');
    btn.disabled = true;
    btn.textContent = "Sincronizando lote...";

    const success = await syncProducts(selected, mode);
    
    if (success) {
      toast("Sincronização em lote finalizada com sucesso!");
      setTimeout(() => location.reload(), 1500);
    } else {
      btn.disabled = false;
      btn.textContent = "Sincronizar Selecionados";
    }
  }

  async function syncProducts(scannedIds, mode) {
    // O ERP é sempre a fonte de verdade pra identidade do produto (nome,
    // código, categoria) — o fornecedor NUNCA sobrescreve isso. A extensão
    // só propõe custo e, quando realmente capturado na varredura, estoque.
    // Antes este payload mandava "estoque: match.scanned.cost" em qualquer
    // modo que não fosse 'cost' — ou seja, "Sincronizar" e "Atualizar
    // Estoques" gravavam o CUSTO do fornecedor dentro do campo de ESTOQUE
    // do ERP. Corrigido: cada campo só entra no payload quando o dado de
    // origem realmente existe.
    const payload = [];
    let semEstoqueCapturado = 0;

    scannedIds.forEach(id => {
      const match = matchedResults.find(r => r.scanned.id === id);
      if (!match || !match.erp) return;

      const item = { erpId: match.erp.id };
      if (mode === 'all' || mode === 'cost') {
        item.precoCusto = match.scanned.cost;
      }
      if (mode === 'all' || mode === 'stock') {
        if (match.scanned.stock !== undefined && match.scanned.stock !== null) {
          item.estoque = match.scanned.stock;
        } else if (mode === 'stock') {
          semEstoqueCapturado++;
        }
      }
      if (item.precoCusto !== undefined || item.estoque !== undefined) {
        payload.push(item);
      }
    });

    if (mode === 'stock' && payload.length === 0) {
      alert("Nenhum dos produtos selecionados teve estoque capturado na varredura (o site do fornecedor não expôs quantidade). Nada foi enviado.");
      return false;
    }

    try {
      const res = await fetch(`${BACKEND_URL}/api/produtos/sync-batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ updates: payload })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro na rede.");
      const falhas = (data.results || []).filter(r => !r.ok);
      if (semEstoqueCapturado > 0) {
        toast(`${semEstoqueCapturado} produto(s) ignorado(s): sem estoque capturado na varredura.`);
      }
      if (falhas.length > 0) {
        alert(`${data.ok}/${data.total} sincronizados. ${falhas.length} falharam:\n` + falhas.map(f => `#${f.erpId}: ${f.erro || 'erro desconhecido'}`).join('\n'));
      }
      return true;
    } catch (e) {
      alert("Falha ao sincronizar: " + e.message);
      return false;
    }
  }

  // ALGORITMO JARO-WINKLER
  function jaroWinkler(s1, s2) {
    s1 = s1.toLowerCase().trim();
    s2 = s2.toLowerCase().trim();
    if (s1 === s2) return 1.0;
    
    let l1 = s1.length;
    let l2 = s2.length;
    let matchDistance = Math.floor(Math.max(l1, l2) / 2) - 1;
    matchDistance = Math.max(0, matchDistance);
    
    let matches1 = new Array(l1).fill(false);
    let matches2 = new Array(l2).fill(false);
    
    let matches = 0;
    let transpositions = 0;
    
    for (let i = 0; i < l1; i++) {
      let start = Math.max(0, i - matchDistance);
      let end = Math.min(l2, i + matchDistance + 1);
      
      for (let j = start; j < end; j++) {
        if (matches2[j]) continue;
        if (s1[i] === s2[j]) {
          matches1[i] = true;
          matches2[j] = true;
          matches++;
          break;
        }
      }
    }
    
    if (matches === 0) return 0.0;
    
    let k = 0;
    for (let i = 0; i < l1; i++) {
      if (!matches1[i]) continue;
      while (!matches2[k]) k++;
      if (s1[i] !== s2[k]) transpositions++;
      k++;
    }
    
    let jaro = ((matches / l1) + (matches / l2) + ((matches - transpositions / 2) / matches)) / 3.0;
    
    // Winkler Modification
    let prefix = 0;
    let maxPrefix = 4;
    for (let i = 0; i < Math.min(maxPrefix, Math.min(l1, l2)); i++) {
      if (s1[i] === s2[i]) prefix++;
      else break;
    }
    
    return jaro + (prefix * 0.1 * (1.0 - jaro));
  }

  function toast(msg) {
    const d = document.createElement('div');
    d.style.position = 'fixed';
    d.style.bottom = '40px';
    d.style.left = '50%';
    d.style.transform = 'translateX(-50%)';
    d.style.background = 'var(--success-text)';
    d.style.color = 'white';
    d.style.padding = '12px 24px';
    d.style.borderRadius = '10px';
    d.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    d.style.zIndex = '999';
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2500);
  }
});
