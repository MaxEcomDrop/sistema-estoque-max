# Estoque Max

Sistema de gestão de estoque, produtos e financeiro integrado ao Bling e ao Mercado Livre.

## Produção

A aplicação de produção é hospedada exclusivamente na Hostinger:

- URL: `https://green-echidna-518767.hostingersite.com`
- Runtime: Node.js 22.x
- Servidor: Express
- Entrada: `index.js`
- Gerenciador: npm 10
- Banco principal: MySQL Hostinger
- Firebase: opcional, usado somente para login Google e push notifications

Arquivos e instruções de Vercel foram removidos. O repositório mantém um único lockfile, `package-lock.json`.

## Desenvolvimento

Requisitos:

- Node.js 22.x
- npm 10.x

Instalação:

```bash
npm install
copy .env.example .env
npm test
npm run dev
```

Em Linux/macOS, use `cp .env.example .env`.

## Variáveis de ambiente

Use `.env.example` como referência. Em produção, cadastre as mesmas variáveis no painel da aplicação Node.js da Hostinger.

Principais grupos:

- `BLING_*`: OAuth e callback do Bling;
- `ML_*`: OAuth e callback do Mercado Livre;
- `ADMIN_*` e `JWT_SECRET`: acesso ao painel;
- `MYSQL_*`: banco MySQL da Hostinger;
- `FIREBASE_SERVICE_ACCOUNT`: opcional para login Google e push;
- `CRON_SECRET`: obrigatório para proteger tarefas agendadas;
- `PORT`: fornecida automaticamente pela hospedagem.

Callbacks de produção:

```text
https://green-echidna-518767.hostingersite.com/api/auth/callback
https://green-echidna-518767.hostingersite.com/api/ml/callback
```

## MySQL Hostinger

Configuração esperada:

```env
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_DATABASE=u377662950_estoquemax
MYSQL_USER=u377662950_estoquemax
MYSQL_PASSWORD=senha_definida_no_hpanel
MYSQL_CONNECTION_LIMIT=5
MYSQL_SSL=false
```

Confirme o nome exato do banco e o host no hPanel. O sistema cria automaticamente a tabela `app_documents` no primeiro acesso.

Teste de leitura e escrita:

```bash
npm run db:check
```

### Migração do Firestore

Se a produção anterior contém dados no Firestore, mantenha temporariamente `FIREBASE_SERVICE_ACCOUNT` e execute primeiro uma simulação:

```bash
npm run db:migrate:firestore -- --dry-run
```

Depois execute a migração real uma única vez:

```bash
npm run db:migrate:firestore
```

A operação é idempotente: documentos com o mesmo identificador são atualizados no MySQL.

## Configuração da aplicação na Hostinger

```text
Preset: Express
Branch de produção: main
Node version: 22.x
Root directory: ./
Package manager: npm
Entry file: index.js
Build command: vazio
Start command: npm start
```

## Publicações agrupadas

Para evitar um deploy a cada pequena melhoria:

1. desenvolva e teste em uma branch que não seja `main`;
2. agrupe as mudanças em um único Pull Request;
3. só faça merge depois de `npm test`, `npm audit` e teste de inicialização;
4. mantenha a Hostinger observando apenas a branch `main`;
5. faça um único merge quando o pacote estiver pronto;
6. com a implantação automática desativada no hPanel, acione uma implantação manual após o merge.

Não faça pushes diretos na `main`. A produção só deve ser publicada manualmente, depois de um pacote aprovado.

## Tarefas agendadas

Configure no agendador da Hostinger usando o domínio de produção e o cabeçalho `x-cron-secret`:

- `/api/cron/push`: a cada 5 minutos;
- `/api/cron/sync-vendas`: diariamente;
- `/api/cron/sync-estoque`: diariamente;
- `/api/cron/resumo`: nos horários dos resumos;
- `/api/cron/estoque`: no horário do alerta de estoque.

O workflow `.github/workflows/notificacoes.yml` dispara apenas notificações e não realiza deploy.

## Verificações antes de publicar

```bash
npm install
npm audit --omit=dev
npm test
npm start
```

Depois da publicação:

```text
GET /health
GET /api/diagnostico
```

O diagnóstico do painel mostra o provedor do banco, o nome configurado e o resultado da conexão sem expor a senha.

## Segurança

- Nunca versione `.env`, senhas MySQL ou service accounts.
- Use uma senha forte e exclusiva para o banco.
- Mantenha `CRON_SECRET` preenchido em produção.
- Firebase não é necessário para persistência; remova `FIRESTORE_DB_ID` depois de concluir e validar a migração.

## Licença

ISC
