// CONTENT SCRIPT (Injetado dinamicamente nos sites autorizados)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "scan_catalog") {
    sendResponse({ success: true, message: "Varredura iniciada" });
    runFullScan(message.domain);
  }
});

// Envia atualizações de progresso para a popup ou console para auditoria
function logProgress(status) {
  console.log(`[MAX ERP SCAN] ${status.message}`, status);
  chrome.runtime.sendMessage({
    action: "scan_progress",
    status: status
  }).catch(() => {}); // Ignora se a popup fechar
}

async function runFullScan(domain) {
  logProgress({ message: "Iniciando auto-rolagem inteligente...", strategy: "Rolagem" });

  // 1. Auto-scroll inteligente até o final real da página (lidando com carregamentos dinâmicos)
  await autoScrollPage();

  // 2. Executa TODAS as estratégias sempre e funde os resultados. Parar na
  // primeira que devolvesse >0 produtos (comportamento antigo) perdia o
  // resto do catálogo sempre que a página misturava fontes — ex.: 3
  // produtos com JSON-LD (de um plugin de SEO) + 500 renderizados só como
  // cards visuais ficavam reduzidos a 3. Cada estratégia roda por completo
  // e mergeStrategyResults deduplica por URL/nome, priorizando o campo mais
  // preciso disponível entre as fontes que bateram no mesmo produto.
  logProgress({ message: "Estratégia 1: Extração de Metadados (JSON-LD)...", strategy: "JSON-LD" });
  const ldProducts = extractJSONLD();

  logProgress({ message: `Estratégia 2: Heurística de Cards... (${ldProducts.length} via JSON-LD até agora)`, strategy: "DOM Heuristics" });
  const cardProducts = extractProductsHeuristic(domain);

  logProgress({ message: "Estratégia 3: Fallback de Imagens e Preços...", strategy: "Deep Fallback" });
  const fallbackProducts = extractFallbackImagePrice(domain);

  logProgress({ message: "Estratégia 4: Heurística de Tabelas...", strategy: "Table Parsing" });
  const tableProducts = extractTableProducts(domain);

  const rawTotal = ldProducts.length + cardProducts.length + fallbackProducts.length + tableProducts.length;
  const products = mergeStrategyResults([ldProducts, cardProducts, fallbackProducts, tableProducts]);

  logProgress({
    message: `Varredura concluída. ${products.length} produtos únicos extraídos (${rawTotal} brutos antes da deduplicação entre estratégias).`,
    strategy: "Concluído",
    count: products.length
  });

  // 3. Retorna os resultados
  chrome.runtime.sendMessage({
    action: "scan_complete",
    products: products,
    domain: domain
  });
}

// Funde os resultados de várias estratégias de extração num único catálogo:
// deduplica pela URL do produto (ou pelo nome normalizado, quando a
// estratégia não capturou URL própria) e completa campos vazios de um
// resultado com o valor equivalente de outra estratégia que bateu no mesmo
// produto — sem nunca sobrescrever um campo que já veio preenchido pela
// fonte de maior confiança (a ordem de "strategyLists" é a ordem de
// prioridade: JSON-LD > cards > fallback > tabela).
function mergeStrategyResults(strategyLists) {
  const byKey = new Map();
  const order = [];

  strategyLists.forEach(list => {
    list.forEach(p => {
      const key = (p.productUrl && p.productUrl !== window.location.href)
        ? 'url:' + p.productUrl
        : 'name:' + String(p.nome || '').toLowerCase().trim();
      if (!key || key === 'name:') return;

      if (!byKey.has(key)) {
        byKey.set(key, { ...p });
        order.push(key);
        return;
      }
      const existing = byKey.get(key);
      ['sku', 'ean', 'cost', 'imageUrl'].forEach(field => {
        const isEmpty = existing[field] === '' || existing[field] === 0 || existing[field] === undefined || existing[field] === null;
        if (isEmpty && p[field]) existing[field] = p[field];
      });
    });
  });

  return order.map(k => byKey.get(k));
}

// Roda a página até o fim REAL da rolagem. O critério de parada é
// estabilização (posição, altura do documento E contagem de elementos todos
// parados ao mesmo tempo por várias checagens seguidas) — NUNCA um tempo
// fixo. O antigo maxScrollAttempts=60 (400px * 60 = 24.000px, ~15s) cortava
// qualquer catálogo mais alto que isso no meio, silenciosamente. O teto
// abaixo é só uma rede de segurança contra scroll infinito genuinamente
// quebrado (ex.: página que gera conteúdo pra sempre) — no uso normal ele
// nunca deveria ser atingido, porque a estabilização já resolveu antes.
async function autoScrollPage() {
  return new Promise((resolve) => {
    let lastScrollY = -1, sameScrollCount = 0;
    let lastElemCount = 0, sameElemCount = 0;
    let lastScrollHeight = -1, sameHeightCount = 0;
    const distance = 500;
    const STABLE_TICKS_REQUIRED = 8; // ~2s sem NENHUMA mudança em nenhum sinal
    const SAFETY_MAX_ATTEMPTS = 2400; // ~10 minutos — só pra páginas realmente quebradas
    let attempts = 0;

    const timer = setInterval(() => {
      const scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight;
      window.scrollBy(0, distance);

      const currentScrollY = window.scrollY || window.pageYOffset;
      const currentElemCount = document.querySelectorAll('img, a').length; // proxy rápido de crescimento do DOM
      attempts++;

      sameScrollCount = (currentScrollY === lastScrollY) ? sameScrollCount + 1 : 0;
      sameElemCount = (currentElemCount === lastElemCount) ? sameElemCount + 1 : 0;
      sameHeightCount = (scrollHeight === lastScrollHeight) ? sameHeightCount + 1 : 0;

      lastScrollY = currentScrollY;
      lastElemCount = currentElemCount;
      lastScrollHeight = scrollHeight;

      logProgress({
        message: `Rolando... Posição: ${currentScrollY}px / Altura do documento: ${scrollHeight}px / Tentativa: ${attempts}`,
        strategy: "Rolagem",
      });

      const trulyStable = sameScrollCount >= STABLE_TICKS_REQUIRED
        && sameElemCount >= STABLE_TICKS_REQUIRED
        && sameHeightCount >= STABLE_TICKS_REQUIRED;

      if (trulyStable || attempts >= SAFETY_MAX_ATTEMPTS) {
        clearInterval(timer);
        if (attempts >= SAFETY_MAX_ATTEMPTS && !trulyStable) {
          logProgress({ message: "Atingido o teto de segurança de rolagem sem estabilizar — a página pode ter scroll infinito genuíno.", strategy: "Rolagem" });
        }
        window.scrollTo(0, 0);
        setTimeout(resolve, 1200); // Aguarda renderizar imagens do topo após subir
      }
    }, 250);
  });
}

// ESTRATÉGIA 1: Extrair dados estruturados Schema.org / JSON-LD
function extractJSONLD() {
  const products = [];
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  
  scripts.forEach(script => {
    try {
      const data = JSON.parse(script.innerText);
      
      // JSON-LD pode ser um objeto simples ou um array de objetos
      const items = Array.isArray(data) ? data : [data];
      
      items.forEach(item => {
        // Encontrar nós do tipo Product
        if (item['@type'] === 'Product' || (item['@graph'] && Array.isArray(item['@graph']))) {
          const graphItems = item['@graph'] || [item];
          
          graphItems.forEach(p => {
            if (p['@type'] !== 'Product') return;
            
            const name = p.name || p.title || "";
            const sku = p.sku || p.mpn || p.productID || "";
            const gtin = p.gtin13 || p.gtin || p.isbn || "";
            
            let price = 0;
            if (p.offers) {
              const offers = Array.isArray(p.offers) ? p.offers : [p.offers];
              const firstOffer = offers[0];
              price = parseFloat(firstOffer.price || firstOffer.lowPrice || 0);
            }
            
            let imageUrl = "";
            if (p.image) {
              imageUrl = Array.isArray(p.image) ? p.image[0] : (typeof p.image === 'object' ? p.image.url : p.image);
            }

            if (name && (price > 0 || sku)) {
              products.push({
                id: "ld_" + hashString(name).slice(0, 8) + "_" + Date.now(),
                nome: name,
                sku: sku,
                ean: gtin,
                cost: price,
                imageUrl: imageUrl,
                productUrl: window.location.href,
                supplierName: "JSON-LD"
              });
            }
          });
        }
      });
    } catch (e) {
      // Ignorar erros de parse do JSON
    }
  });
  
  return products;
}

// ESTRATÉGIA 2: Heurística Adaptativa de Cards
function extractProductsHeuristic(domain) {
  const products = [];
  const seenUrls = new Set();
  const allLinks = Array.from(document.querySelectorAll('a'));
  const candidates = [];

  allLinks.forEach(link => {
    const img = link.querySelector('img');
    if (!img) return;

    const imgWidth = img.width || img.naturalWidth || 0;
    const imgHeight = img.height || img.naturalHeight || 0;
    if (imgWidth > 0 && imgWidth < 60) return;
    if (imgHeight > 0 && imgHeight < 60) return;

    let cardContainer = link;
    let depth = 0;
    let current = link;
    while (current && depth < 4) {
      if (current.tagName === 'DIV' || current.tagName === 'LI') {
        const text = current.innerText || "";
        if (text.length > link.innerText.length + 8) {
          cardContainer = current;
          break;
        }
      }
      current = current.parentElement;
      depth++;
    }

    candidates.push({ container: cardContainer, imgElement: img, linkElement: link });
  });

  const uniqueContainers = [];
  candidates.forEach(c => {
    if (uniqueContainers.some(x => x.container === c.container)) return;
    uniqueContainers.push(c);
  });

  uniqueContainers.forEach(({ container, imgElement, linkElement }, index) => {
    try {
      const productUrl = linkElement ? linkElement.href : window.location.href;
      if (seenUrls.has(productUrl)) return;
      seenUrls.add(productUrl);

      let imageUrl = imgElement.src || 
                     imgElement.getAttribute('data-src') || 
                     imgElement.getAttribute('data-lazy-src') || 
                     imgElement.getAttribute('data-original') || "";
                     
      if (imageUrl.startsWith('data:image')) {
        const srcset = imgElement.getAttribute('srcset') || imgElement.getAttribute('data-srcset') || "";
        if (srcset) {
          const firstSrc = srcset.split(',')[0].trim().split(' ')[0];
          if (firstSrc && !firstSrc.startsWith('data:')) imageUrl = firstSrc;
        }
      }
      
      if (!imageUrl || imageUrl.startsWith('data:')) return;

      let name = "";
      const titleElement = container.querySelector('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="name"], [class*="titulo"]');
      if (titleElement) {
        name = titleElement.innerText.trim();
      } else {
        name = imgElement.alt || imgElement.title || "";
      }

      if (!name || name.length < 4) {
        const lines = container.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 5);
        if (lines.length > 0) name = lines[0];
      }
      if (!name) name = "Produto " + (index + 1);
      name = name.replace(/\r?\n|\r/g, " ").trim();

      let cost = 0;
      const text = container.innerText || "";
      const priceMatch = text.match(/(?:R\$|\$)\s*([\d.]+,\d{2})/i) || 
                         text.match(/(?:R\$|\$)\s*([\d.]+\.\d{2})/i) || 
                         text.match(/([\d.]+,\d{2})/);
                         
      if (priceMatch) {
        cost = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
      }

      let sku = "";
      let ean = "";
      const eanMatch = text.match(/\b\d{13}\b/);
      if (eanMatch) ean = eanMatch[0];

      const skuMatch = text.match(/(?:Ref|SKU|Código|Cod|Código Fornecedor|Cód)[\s:]*([A-Za-z0-9-_]+)/i);
      if (skuMatch) {
        sku = skuMatch[1].trim();
      } else {
        const genericCodeMatch = text.match(/\b([A-Z0-9-]{4,12})\b/i);
        if (genericCodeMatch && !genericCodeMatch[0].includes('R$') && isNaN(genericCodeMatch[0])) {
          sku = genericCodeMatch[0].trim();
        }
      }

      if (!sku) {
        sku = "EXT-" + hashString(name).slice(0, 8).toUpperCase();
      }

      products.push({
        id: "sup_" + index + "_" + Date.now(),
        nome: name,
        sku: sku,
        ean: ean,
        cost: cost,
        imageUrl: imageUrl,
        productUrl: productUrl,
        supplierName: getDomainName(domain)
      });
    } catch (e) {
      console.error(e);
    }
  });

  return products;
}

// ESTRATÉGIA 3: Fallback de Imagens e Preços Próximos
function extractFallbackImagePrice(domain) {
  const products = [];
  const allImages = Array.from(document.querySelectorAll('img'));
  
  allImages.forEach((img, index) => {
    try {
      const imgWidth = img.width || img.naturalWidth || 0;
      if (imgWidth > 0 && imgWidth < 60) return;

      let parent = img.parentElement;
      let depth = 0;
      while (parent && depth < 5) {
        const text = parent.innerText || "";
        const priceMatch = text.match(/(?:R\$|\$)\s*([\d.]+,\d{2})/i) || text.match(/([\d.]+,\d{2})/);
        
        if (priceMatch) {
          const cost = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
          const name = img.alt || img.title || "Fallback " + index;
          
          let imageUrl = img.src || img.getAttribute('data-src') || "";
          if (imageUrl && !imageUrl.startsWith('data:')) {
            products.push({
              id: "fb_" + index + "_" + Date.now(),
              nome: name.trim(),
              sku: "FB-" + hashString(name).slice(0, 8).toUpperCase(),
              ean: "",
              cost: cost,
              imageUrl: imageUrl,
              productUrl: window.location.href,
              supplierName: getDomainName(domain)
            });
            break;
          }
        }
        parent = parent.parentElement;
        depth++;
      }
    } catch (e) {
      // Ignorar erros individuais
    }
  });
  
  return products;
}

// ESTRATÉGIA 4: Heurística de Tabelas de Preço (Listagem B2B)
function extractTableProducts(domain) {
  const products = [];
  const rows = document.querySelectorAll('tr');

  rows.forEach((row, index) => {
    try {
      const text = row.innerText || "";
      const priceMatch = text.match(/(?:R\$|\$)\s*([\d.]+,\d{2})/i) || text.match(/([\d.]+,\d{2})/);
      
      if (priceMatch && text.length > 15) {
        const cost = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
        
        // Pega as células da linha
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 2) return;
        
        // Tenta deduzir qual célula é o nome
        let name = "";
        let sku = "";
        
        cells.forEach(cell => {
          const cellText = cell.innerText.trim();
          if (cellText.length > name.length && !cellText.includes('R$') && isNaN(cellText.replace(',', '.'))) {
            name = cellText;
          }
          
          // Verifica se há alguma célula que seja apenas código
          const codeMatch = cellText.match(/^[A-Za-z0-9-_]{4,12}$/);
          if (codeMatch && isNaN(cellText)) {
            sku = codeMatch[0];
          }
        });

        const img = row.querySelector('img');
        const imageUrl = img ? (img.src || img.getAttribute('data-src') || "") : "";

        if (name && name.length > 3) {
          products.push({
            id: "tb_" + index + "_" + Date.now(),
            nome: name,
            sku: sku || "TB-" + hashString(name).slice(0, 8).toUpperCase(),
            ean: "",
            cost: cost,
            imageUrl: imageUrl,
            productUrl: window.location.href,
            supplierName: getDomainName(domain)
          });
        }
      }
    } catch (e) {
      // Ignorar
    }
  });

  return products;
}

// Helpers
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; 
  }
  return Math.abs(hash).toString(16);
}

function getDomainName(host) {
  const parts = host.split('.');
  if (parts.length > 2) {
    return parts[parts.length - 2].toUpperCase();
  }
  return parts[0].toUpperCase();
}
