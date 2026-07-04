# Pós-Venda Capture

Microsserviço serverless que recebe webhooks do **Bling** e do **Mercado Livre**,
resolve o contato do comprador (telefone/celular/email) e mantém um cache no
**Firestore** (`customers/{cpf}`), reduzindo latência e consumo da API v3 do Bling.

## Fluxo

1. `POST /api/webhook-capture` recebe o payload (Bling ou ML).
2. Valida método (405), Content-Type/JSON/estrutura (400) e autenticidade:
   - Bling: HMAC-SHA256 do corpo cru vs `BLING_WEBHOOK_SECRET`;
   - ML: `application_id` vs `ML_APP_ID` + re-busca do recurso na API oficial.
3. Extrai CPF/CNPJ (`cleanDocument()` deixa só dígitos). Webhook do ML não traz
   documento no payload: o pedido é buscado na API do ML com o token compartilhado.
4. Consulta `customers/{cpf}`; se `updatedAt` dentro de `CACHE_TTL_HOURS`,
   responde na hora sem tocar o Bling (`action: cache_hit`).
5. Cache frio → `GET /contatos?numeroDocumento=...` no Bling; extrai SOMENTE
   `telefone`, `celular`, `email` (máscaras preservadas).
6. Upsert `set(..., { merge: true })` com `cpf`, contatos, `source`, `updatedAt`.
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

## Estrutura

```
api/webhook-capture.ts        handler HTTP (Vercel Function)
src/config/{env,firebase}.ts  zod env + Firebase Admin (banco nomeado ok)
src/services/                 bling (OAuth compartilhado + contatos), ml, firestore
src/repositories/             customers (get/upsert merge)
src/controllers/              orquestração do fluxo do webhook
src/middlewares/              método/Content-Type/JSON/assinatura HMAC
src/utils/                    cleanDocument, retry/backoff, dedup, logger
src/types, src/constants      contratos e constantes
```
