# Sistema de Estoque Max

Sistema de gestão de estoque com integração OAuth2 com a API do Bling para Max Renovação.

## 🚀 Características

- ✅ Autenticação OAuth2 com Bling
- ✅ Sincronização automática de produtos
- ✅ Banco de dados SQLite
- ✅ API RESTful completa
- ✅ Dashboard responsivo
- ✅ Busca de produtos
- ✅ Estatísticas de estoque

## 📋 Requisitos

- Node.js 14+
- npm ou yarn
- Conta Bling com credenciais OAuth configuradas

## ⚙️ Instalação

1. Clone o repositório:
```bash
git clone https://github.com/MaxEcomDrop/sistema-estoque-max.git
cd sistema-estoque-max
```

2. Instale as dependências:
```bash
npm install
```

3. Configure as variáveis de ambiente:
```bash
cp .env.example .env
```

4. Edite o arquivo `.env` com suas credenciais do Bling:
```env
BLING_CLIENT_ID=seu_client_id
BLING_CLIENT_SECRET=seu_client_secret
BLING_REDIRECT_URI=http://localhost:3000/api/auth/callback
JWT_SECRET=sua_chave_secreta_segura
PORT=3000
NODE_ENV=development
```

## 🔧 Desenvolvimento

Para rodar o servidor em modo desenvolvimento com hot-reload:

```bash
npm run dev
```

O servidor rodará em `http://localhost:3000`

## 📦 Produção

Para rodar o servidor em produção:

```bash
npm start
```

## 📁 Estrutura do Projeto

```
sistema-estoque-max/
├── config/
│   └── database.js           # Configuração SQLite
├── src/
│   ├── controllers/
│   │   ├── authController.js   # Controlador de autenticação
│   │   └── productController.js # Controlador de produtos
│   ├── middleware/
│   │   └── authMiddleware.js    # Middleware de autenticação
│   ├── routes/
│   │   ├── authRoutes.js       # Rotas de autenticação
│   │   └── productRoutes.js    # Rotas de produtos
│   └── services/
│       ├── authService.js      # Serviço de autenticação
│       └── blingService.js     # Serviço Bling API
├── public/
│   ├── index.html          # Página de login
│   └── dashboard.html      # Dashboard de produtos
├── app.js                  # Aplicação principal
├── .env.example           # Exemplo de variáveis de ambiente
└── package.json           # Dependências
```

## 🔐 Fluxo OAuth2 com Bling

1. **Login**: Usuário clica em "Autenticar com Bling"
2. **Autorização**: É redirecionado para Bling para autorizar acesso
3. **Callback**: Bling redireciona com um código de autorização
4. **Token**: Sistema troca o código por um access token
5. **Sincronização**: Produtos são importados e armazenados localmente
6. **Dashboard**: Usuário acessa o dashboard com seus produtos

## 🔌 Endpoints da API

### Autenticação
- `GET /api/auth/url` - Obtém URL de autorização Bling
- `GET /api/auth/callback?code=xxx` - Callback do Bling (automático)
- `POST /api/auth/logout` - Fazer logout
- `GET /api/auth/user` - Obter usuário autenticado

### Produtos
- `POST /api/produtos/sync` - Sincronizar produtos com Bling
- `GET /api/produtos` - Listar todos os produtos
- `GET /api/produtos/search?q=termo` - Buscar produtos
- `GET /api/produtos/:id` - Obter detalhes do produto

## 🗄️ Banco de Dados

O sistema usa SQLite com as seguintes tabelas:

### Users
```sql
id (INTEGER PRIMARY KEY)
bling_user_id (TEXT UNIQUE)
access_token (TEXT)
refresh_token (TEXT)
expires_at (INTEGER)
created_at (DATETIME)
updated_at (DATETIME)
```

### Products
```sql
id (INTEGER PRIMARY KEY)
user_id (INTEGER FOREIGN KEY)
bling_product_id (TEXT UNIQUE)
nome (TEXT)
codigo (TEXT)
preco (REAL)
estoque (INTEGER)
situacao (TEXT)
created_at (DATETIME)
updated_at (DATETIME)
```

## 🔄 Renovação de Token

Os tokens expiram em 1 hora. O sistema automaticamente renova o token usando o refresh_token quando necessário.

## 📝 Variáveis de Ambiente

```env
# Bling OAuth
BLING_CLIENT_ID          # ID do cliente Bling
BLING_CLIENT_SECRET      # Chave secreta do Bling
BLING_REDIRECT_URI       # URL de callback (deve ser igual na configuração Bling)

# Server
PORT                     # Porta do servidor (padrão: 3000)
NODE_ENV                 # Ambiente (development/production)
JWT_SECRET               # Chave secreta para JWT
```

## 🚀 Deploy

### Vercel
1. Conecte seu repositório GitHub ao Vercel
2. Configure as variáveis de ambiente
3. Deploy automático ao fazer push

**Nota**: O SQLite funciona melhor com Vercel usando KV storage ou um banco de dados externo em produção.

### Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

## 📚 Dependências

- **express** - Framework web
- **sqlite3** - Banco de dados
- **axios** - Cliente HTTP
- **dotenv** - Variáveis de ambiente
- **jsonwebtoken** - Autenticação JWT
- **cors** - CORS middleware
- **cookie-parser** - Parser de cookies

## 🤝 Contribuindo

1. Fork o projeto
2. Crie uma branch para sua feature (`git checkout -b feature/AmazingFeature`)
3. Commit suas mudanças (`git commit -m 'Add some AmazingFeature'`)
4. Push para a branch (`git push origin feature/AmazingFeature`)
5. Abra um Pull Request

## 📄 Licença

ISC

## 📧 Contato

- Email: guienhjo2019@gmail.com
- GitHub: [@MaxEcomDrop](https://github.com/MaxEcomDrop)

---

**Desenvolvido com ❤️ para Max Renovação**
