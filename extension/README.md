# MAX ERP AI Supplier Intelligence — Extensão Chrome

Extensão de sincronização de catálogos de fornecedores com o MAX ERP. Vive dentro deste
repositório (`extension/`) para versionar junto com o backend e facilitar o deploy — os dois
lados (extensão + `index.js`) mudam juntos quando a integração muda.

## Como instalar (modo desenvolvedor)

A Chrome Web Store exige revisão/publicação; enquanto isso não acontece, a instalação é via
"carregar sem compactação" (Load unpacked), o único jeito de instalar uma extensão fora da loja:

1. Baixe/copie a pasta `extension/` inteira para o computador (ou baixe o `.zip` fornecido e
   descompacte).
2. Abra o Chrome e vá em `chrome://extensions`.
3. Ative o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** (Load unpacked) e selecione a pasta `extension/`
   (a que contém o `manifest.json`).
5. O ícone "M" azul aparece na barra de extensões. Clique nele, faça login com o mesmo
   e-mail/senha do painel MAX ERP.

O ID da extensão é fixo (`ggoanbhfaciiaimcihblophnjenclohp`, definido pelo campo `"key"` do
`manifest.json`) — o backend só aceita chamadas de origem `chrome-extension://` vindas
**exatamente** desse ID (ver `EXTENSION_ORIGIN` em `index.js`). Não gere um novo keypair /
apague o campo `"key"` sem atualizar o backend junto, senão a extensão perde acesso à API
(CORS vai bloquear o novo ID).

## Arquitetura

- `manifest.json` — Manifest V3. `host_permissions: ["<all_urls>"]` porque o usuário escolhe
  qualquer site de fornecedor pra escanear; `content.js` só é injetado sob demanda (não roda
  em toda página aberta).
- `background.js` — service worker: injeta `content.js` na aba ativa quando o usuário clica em
  "Scan Supplier Catalog", e abre `review.html` quando a varredura termina.
- `content.js` — motor de extração: rola a página até estabilizar de verdade (sem teto de
  tempo fixo — só uma rede de segurança contra scroll infinito quebrado), roda as 4
  estratégias de extração (JSON-LD, heurística de cards, fallback imagem+preço, tabelas) e
  **funde** os resultados em vez de parar na primeira que achar algo.
- `popup.html/js/css` — login e autorização de domínios (só sites autorizados pelo usuário
  podem ser escaneados).
- `review.html/js/css` — dashboard de revisão: busca produtos do ERP (`GET /api/produtos`),
  casa com os produtos escaneados (EAN → **SKU exato** → similaridade de nome, sendo que o
  match semântico só roda para itens SEM código real do fornecedor — se o fornecedor publicou
  um SKU e ele não está no ERP, o item fica sem vínculo em vez de chutar), calcula impacto de
  margem/lucro, detecta anomalias, e sincroniza mudanças aprovadas
  (`POST /api/produtos/sync-batch`).
- **Varredura de PDF híbrida** (`pdf.min.js` + OCR local): páginas com camada de texto são
  lidas direto (rápido e exato); páginas 100% imagem — como os catálogos exportados por
  screenshot via FireShot, que geram UMA página gigante sem nenhum texto — são renderizadas
  em fatias com sobreposição e lidas por OCR, TODAS as fatias até o fim. O parser espacial
  reconstrói o grid de cards por geometria (âncora `(SKU)` → preço `R$` e `Estoque: N pcs`
  abaixo, na mesma coluna), então colunas vizinhas nunca se misturam.
- **OCR 100% local** (`ocr/`): worker, núcleo WASM (SIMD) e modelo português do Tesseract v5
  vêm empacotados na extensão — nada é baixado de CDN em tempo de execução (a CSP de
  extensões MV3 bloquearia; era por isso que o OCR de fotos não funcionava). O manifest
  precisa de `wasm-unsafe-eval` na CSP, já configurado.

## Regra de ouro: o ERP é sempre a fonte de verdade

A extensão nunca sobrescreve nome, código ou categoria do produto — só propõe **custo** e,
quando a varredura realmente capturar, **estoque**. `POST /api/produtos/sync-batch` só aceita
`{erpId, precoCusto?, estoque?}` por item, e a gravação de custo passa pelo mesmo caminho do
editor do painel (`persistirCusto`/`persistirEstoque` em `index.js` — nunca um PUT cru, que o
Bling ignora silenciosamente).
