# Pós-Venda Capture

Microsserviço serverless que recebe webhooks do **Bling** e do **Mercado Livre**,
resolve o contato do comprador (nome completo, endereço, telefone/celular/email)
e mantém um cache no **Firestore** (`customers/{cpf}`), reduzindo latência e
consumo da API v3 do Bling. O mesmo cache alimenta a aba Clientes do sistema
principal (preenche e-mail/telefone/endereço quando o Bling não tinha) e a
tela **Clientes (CRM)** deste próprio projeto.

## Fluxo

1. `POST /api/webhook-capture` recebe o payload (Bling ou ML).
2. Valida método (405), Content-Type/JSON/estrutura (400) e autenticidade:
   - Bling: HMAC-SHA256 do corpo cru vs `BLING_WEBHOOK_SECRET`;
   - ML: `application_id` vs `ML_APP_ID` + re-busca do recurso na API oficial.
3. Extrai CPF/CNPJ (`cleanDocument()` deixa só dígitos). Webhook do ML não traz
   documento no payload: o pedido é buscado na API do ML com o token compartilhado.
4. Consulta `customers/{cpf}`; se `updatedAt` dentro de `CACHE_TTL_HOURS`,
   responde na hora sem tocar o Bling (`action: cache_hit`).
5. Cache frio → `GET /contatos?numeroDocumento=...` no Bling; extrai `nome`,
   `telefone`, `celular`, `email`, `endereco` (logradouro/número/bairro/
   cidade/UF/CEP — mesmos campos que o sistema principal já lê do Bling) e
   `tipoPessoa` (PF/PJ, do campo `tipo` do Bling). O Mercado Livre só expõe
   nome e telefone de forma confiável no pedido (endereço completo exigiria
   o recurso de envio, fora do escopo atual).
   **Razão social e inscrição estadual (PJ):** ainda não capturados — a
   documentação oficial do Bling não pôde ser confirmada automaticamente
   (bloqueou acesso automatizado); implementa assim que tivermos uma
   amostra real do JSON de um contato PJ confirmando os nomes exatos dos
   campos, pra não arriscar ler um campo errado silenciosamente.
6. Upsert `set(..., { merge: true })` com `cpf`, contato completo, `source`,
   `updatedAt` — nunca apaga um campo já preenchido por uma fonte anterior.
7. Responde `200 { success: true, action, cpf }`.

## Decisões de arquitetura

- **Tokens compartilhados (opção A):** access/refresh do Bling vivem em
  `bling_auth/tokens` no mesmo Firestore do sistema principal. O refresh do
  Bling (uso único) é protegido por *lease* transacional (`bling_auth/refresh_lease`).
  O token do ML (`ml_auth/tokens`) é usado **somente leitura** — este serviço
  nunca o renova, para não derrubar a conexão do sistema principal.
- **Dedup em memória:** chamadas simultâneas para o mesmo CPF compartilham uma
  única promessa por instância.
- **Resiliência:** retry com backoff exponencial + jitter para 429/5xx/rede,
  timeout por tentativa via `AbortController`, nunca vaza stack trace.

## Variáveis de ambiente

Copie `.env.example` e preencha. `FIREBASE_SERVICE_ACCOUNT` é o JSON da service
account em uma linha (a MESMA do sistema principal, projeto `erp-max-sistema`).
`FIRESTORE_DB_ID` só se o banco não for `(default)`.

## Rodando localmente

```bash
cd pos-venda
npm install
npm run typecheck   # tsc --noEmit (estrito)
npm run lint
npx vercel dev      # sobe a function em http://localhost:3000
```

Teste:

```bash
curl -s -X POST http://localhost:3000/api/webhook-capture \
  -H 'Content-Type: application/json' \
  -d '{"evento":"pedido","dados":{"contato":{"numeroDocumento":"111.222.333-44"}}}'
```

## Deploy na Vercel

Este diretório é um projeto independente dentro do repositório:

1. Vercel → **Add New Project** → importe o repositório;
2. **Root Directory: `pos-venda`**;
3. configure as variáveis de ambiente do `.env.example`;
4. Deploy. A rota fica em `https://<projeto>.vercel.app/api/webhook-capture`.

Cadastre essa URL como destino dos webhooks no Bling (com a chave de assinatura
igual a `BLING_WEBHOOK_SECRET`) e nas notificações do app do Mercado Livre.

**Categorias de webhook no Bling:** o painel não tem uma categoria "Contato" —
use **Pedido** e **Nota Fiscal** (o serviço já lida com o payload minimalista
dessas categorias, buscando o recurso completo quando necessário).

## Tela de diagnóstico

A URL raiz do projeto (`https://<projeto>.vercel.app/`) abre um painel visual
(tema escuro/glassmorphism, próprio deste projeto) que mostra, ao vivo:

- se o Firebase configurado é o **mesmo projeto** do sistema principal
  (`erp-max-sistema`) e se o Firestore está respondendo;
- se há token do Bling/Mercado Livre salvo e válido;
- quantos clientes estão em cache e quantos eventos já foram resolvidos;
- os últimos clientes e eventos processados (CPF mascarado);
- um formulário para **testar o webhook manualmente** colando um payload de
  exemplo, sem precisar esperar um evento real do Bling/ML.

### Clientes (CRM)

Uma segunda aba na mesma tela (`https://<projeto>.vercel.app/`) lista o cache
completo — `GET /api/customers` (paginado, `?cursor=<updatedAt>` continua a
listagem — scroll infinito no front-end) — com nome, CPF/CNPJ **sem
máscara**, e-mail, telefone, endereço completo, tags e origem
(`bling`/`mercado_livre`), com busca por qualquer um desses campos, mais
cards com total em cache e % com e-mail/telefone/endereço preenchidos.
Diferente do `/api/recent` (resumo de diagnóstico, CPF mascarado), este
endpoint é o dado completo para uso operacional — por isso exige
login/`ADMIN_KEY` como os demais endpoints protegidos.

**Visual dark/glassmorphism:** só esta tela (pos-venda) — o sistema principal
não foi alterado.

**Clique num cliente** pra abrir o detalhe: histórico de pedidos + LTV (via
`GET /api/customers/{cpf}`, que busca `/pedidos/vendas` no Bling filtrado
pelo ID do contato — o Bling não filtra pedidos por documento, só por data,
então é um histórico "dentro do período consultado" — 365 dias por padrão,
`?dias=` pra ajustar — não o total desde sempre) e notas/tags internas
(`PATCH /api/customers/{cpf}` com `{ notas, tags }` — dado que só existe
aqui, nunca é enviado ao Bling/ML).

**Importante:** o cache só é alimentado por **webhooks reais** (pedido/NF-e/ML
chegando) — o serviço nunca varre o Bling sozinho. Um cadastro recém-criado
fica vazio até o primeiro evento real acontecer. Pra ver os clientes que já
existem no Bling desde já, use o botão **"Importar do Bling"** na aba
Clientes — chama `POST /api/import-bling` repetidamente (a função serverless
não tem tempo de varrer um cadastro grande de uma vez só, então cada chamada
processa até 3 páginas de 100 contatos e devolve `proximaPagina` pra
continuar; o botão já faz esse loop sozinho até `concluido: true`). É seguro
rodar mais de uma vez — é um upsert com merge, nunca duplica nem apaga dado
já resolvido por um webhook.

### Login

`https://<projeto>.vercel.app/login.html` pede e-mail/senha (mesmo par do
sistema principal — defina `ADMIN_EMAIL`, `ADMIN_PASSWORD` e `JWT_SECRET`
no `.env.example`; `JWT_SECRET` pode ser gerado com `openssl rand -hex 32`).
No sucesso, `POST /api/auth/login` emite um cookie de sessão
(`pv_session`, HttpOnly + Secure + SameSite=Lax, válido por 7 dias) que
protege a tela e os endpoints `/api/status`/`/api/recent`. `GET /api/auth/me`
confirma a sessão (usado pelo `index.html` para redirecionar ao login quando
não autenticado) e `POST /api/auth/logout` encerra a sessão.

Como alternativa ao login (útil para automação/scripts), `ADMIN_KEY` continua
funcionando via `?key=...` ou header `x-admin-key` — sem nenhum dos dois
configurados, os endpoints ficam abertos (aceitável só durante a validação
inicial).

### Erros de configuração

Se alguma variável de ambiente estiver ausente ou inválida (ex.: `JWT_SECRET`
não definido, `FIREBASE_SERVICE_ACCOUNT` malformado), os endpoints respondem
`503 { success:false, error:'config_error', detail:'<variável exata>' }` em
vez de um `500 internal_error` genérico — o `detail` sempre aponta qual
variável precisa ser corrigida.

## Estrutura

```
index.html                    tela de diagnóstico (status + teste manual)
login.html                    tela de login (e-mail/senha, visual do sistema principal)
api/webhook-capture.ts        handler HTTP principal (Vercel Function)
api/status.ts                 diagnóstico ao vivo (Firebase/Bling/ML/cache)
api/recent.ts                 últimos clientes e eventos resolvidos (CPF mascarado)
api/customers.ts              listagem paginada do CRM (CPF sem máscara, autenticado)
api/customers/[cpf].ts        detalhe: GET pedidos+LTV (Bling), PATCH notas/tags
api/import-bling.ts           importação única do cadastro de contatos do Bling (em lotes)
api/auth/login.ts             valida credenciais, emite cookie de sessão (JWT)
api/auth/logout.ts            encerra a sessão
api/auth/me.ts                confirma se a sessão é válida
src/config/{env,firebase}.ts  zod env + Firebase Admin (banco nomeado ok)
src/services/                 bling (OAuth compartilhado + contatos), ml, firestore
src/repositories/             customers (get/upsert merge)
src/controllers/              orquestração do fluxo do webhook + importação em lote do Bling
src/middlewares/              método/Content-Type/JSON/assinatura HMAC/sessão/ADMIN_KEY
src/utils/                    cleanDocument, retry/backoff, dedup, logger, auth (JWT/cookie), errors (ConfigError), handleApiError, readJsonBody
src/types, src/constants      contratos e constantes
```
