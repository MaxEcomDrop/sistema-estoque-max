# Sistema de Estoque Max

Sistema de gestão de estoque para Max Renovação.

## Requisitos

- Node.js 14+
- npm ou yarn

## Instalação

```bash
npm install
```

## Desenvolvimento

Para rodar o servidor em modo desenvolvimento com hot-reload:

```bash
npm run dev
```

## Produção

Para rodar o servidor em produção:

```bash
npm start
```

O servidor rodará na porta 3000 por padrão ou na porta definida pela variável `PORT`.

## Estrutura do Projeto

```
sistema-estoque-max/
├── src/
│   ├── controllers/    # Controladores
│   ├── routes/         # Rotas da API
│   ├── models/         # Modelos de dados
│   └── middleware/     # Middleware customizado
├── config/             # Arquivos de configuração
├── public/             # Arquivos estáticos
├── tests/              # Testes
├── app.js              # Arquivo principal
└── package.json        # Dependências
```

## Licença

ISC
