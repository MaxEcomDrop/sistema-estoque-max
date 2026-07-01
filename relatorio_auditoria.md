# Relatório de Auditoria Técnica - Sistema de Estoque Max

## 1. Auditoria da Arquitetura
- **Estrutura e Organização:** O projeto é apresentado como um monólito onde a maior parte da lógica (`app.js` / `index.js`) está concentrada em um único arquivo, dificultando a manutenibilidade e escalabilidade. Uma tentativa de modularização (na pasta `src/`) parece ter sido abandonada ou não está integrada corretamente ao entry point principal (`index.js`).
- **Dependências e Deploy:** A aplicação é hospedada na Vercel utilizando funções Serverless. A configuração de limite de requisições globais do express usando `express-rate-limit` é referida na memória, mas não observada no `index.js`, o que deve ser considerado.
- **Armazenamento:** O sistema depende do Firestore para notificações (`fcm_tokens`, `notif_history`), autenticação Bling e também usa o Firestore para o `changeLog` / `historico`, implementando um fallback in-memory, o que não persiste entre cold starts na Vercel. O README menciona o uso do SQLite (com schemas), contudo as tabelas não parecem ser instanciadas no código atual (o `changeLog` faz push para o Firebase ou memória em `pushLog`).

## 2. Auditoria das APIs (Back-end em `index.js`)
- **/api/produtos**:
  - **Paginação Fixa:** Limita-se a consultar 5 páginas (máximo de 500 produtos) independentemente da necessidade, o que pode truncar dados para catálogos maiores.
  - **Performance/Retries:** Usa lógica simples de loop. A chamadas de retries baseada em cache está implementada para `/api/pedidos`, mas produtos parecem sofrer gargalo.
- **/api/pedidos**:
  - **Limites Rígidos:** A função `fetchPedidos` e as rotas relacionadas possuem limites hardcoded (ex: `maxPg = 3` ou 2), perdendo requisições grandes para longos períodos de datas e relatórios financeiros (DRE/Dashboard).
- **Webhooks:** Retornam rápido para satisfazer o Bling (fire-and-forget), enviando notificações Push sem aguardar a conclusão, o que é um design bom (SRE), mas não atualizam o cache local (banco) porque dependem inteiramente de fetch on demand pelos clientes.

## 3. Auditoria do Fluxo de Dados e Views (`dashboard.html`)
- **Renderização e Atualização:** A aplicação cliente é uma SPA construída inteiramente com Vanilla JavaScript e manipulação de DOM direta através de `.innerHTML`.
- **Gargalos de Atualização:** Modificações não atualizam localmente otimizado: as views inteiras são reescritas com `renderTable()` ou similar, e a paginação do frontend depende de buscar o total de produtos. Não existe um cache via Service Worker robusto para os dados da API além dos arquivos estáticos.
- **Sincronização:** Sincronização manual (sincronizar produtos) ou via autoRefresh (poll) com contagem agressiva de timer.

## 4. Auditoria de Segurança
- **JWT e Cookies:** A aplicação utiliza tokens JWT guardados em cookies `HttpOnly` com flag `secure` habilitada no modo produção (ideal).
- **Hardcoded Secrets:** A autenticação local validação a partir das variáveis `ADMIN_EMAIL` e `ADMIN_PASSWORD`, sem suportar múltiplos usuários além de uma senha universal hardcoded para confirmar ações "estilo Shopee" (`_pwCallback`).
- **Headers:** Não há aplicação ativa e agressiva de middlewares como o `helmet` no código fonte `index.js` para adicionar CSP, XSS e outras proteções. CORS é muito permissivo.

## 5. Auditoria de Performance e Interface
- **Layout (UI/UX):** O `login.html` utiliza cores vibrantes, gradientes e sombras (e.g., `background: linear-gradient(135deg,#6366f1,#8b5cf6)`). O `dashboard.html` (`new_style.css`) utiliza um sistema mais "listrado"/flat com foco no corporativo, resultando em disparidade visual notável com a página de entrada.
- **Assets:** Falta minimização da resposta do HTML principal (`dashboard.html` é massivo). Renderização in-browser bloqueada devido à inicialização monolítica de variáveis de UI (`renderTable`, modais).

## 6. Sumário de Problemas a Resolver
1. **Padrão de Cores e UI:** Aplicar paleta de cores e estilo visual do Login (`linear-gradient`) nos componentes do Dashboard (Botões, Sidebars, Cards), substituindo a identidade simplória antiga (`new_style.css`).
2. **Back-end Paginação Limitada:** Alterar a lógica do loop em `index.js` de `/api/produtos` e `fetchPedidos` para não usar números fixos limitados (ex. 5 ou 3), mas iterar até `hasMore = false` (ou lista retornar menor que o limite imposto).
3. **Mismatches Técnicos:** Adicionar os passos essenciais para tornar a aplicação consistente com o relatado.

## Plano de Correção Imediata
Iniciaremos a refatoração unificando o Design System do app (CSS e HTML) e corrigindo as travas de paginação no `index.js` garantindo total integridade de dados (Products e Orders).