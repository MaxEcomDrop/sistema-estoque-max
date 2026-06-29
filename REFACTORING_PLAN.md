# Plano de Refatoração Arquitetural

## Visão Geral

O projeto `sistema-estoque-max` possui uma estrutura modular em `src/` (controllers, middleware, routes, services) que não está sendo utilizada na configuração de produção. O arquivo `index.js` atua como um monolito, concentrando toda a lógica da aplicação. Este documento propõe um plano de refatoração para consolidar a arquitetura e melhorar a manutenibilidade.

## Problemas Atuais

### 1. Código Monolítico

O arquivo `index.js` contém aproximadamente 876 linhas, incluindo:
- Configuração de middleware
- Rotas de autenticação
- Rotas de produtos
- Rotas de pedidos
- Rotas de notas fiscais
- Rotas de notificações push
- Rotas de contas a pagar/receber
- Lógica de negócio misturada com lógica HTTP

**Impacto:** Dificulta a manutenção, testes e reutilização de código.

### 2. Duplicação de Lógica

Existem duas implementações paralelas:
- **Implementação 1:** `index.js` (em produção)
- **Implementação 2:** `src/` (modular, não utilizada)

Ambas implementam autenticação, manipulação de produtos e integração com o Bling, mas de formas diferentes.

**Impacto:** Confusão sobre qual código usar, duplicação de esforço na manutenção.

### 3. Falta de Separação de Responsabilidades

A lógica de negócio está misturada com a lógica HTTP, dificultando:
- Testes unitários
- Reutilização de código
- Compreensão do fluxo de dados

## Arquitetura Proposta

```
sistema-estoque-max/
├── src/
│   ├── app.js                    # Configuração Express
│   ├── config/
│   │   ├── environment.js        # Validação de variáveis de ambiente
│   │   ├── database.js           # Configuração de banco de dados
│   │   └── firebase.js           # Configuração Firebase
│   ├── middleware/
│   │   ├── auth.js               # Middleware de autenticação
│   │   ├── errorHandler.js       # Middleware de tratamento de erros
│   │   └── logger.js             # Middleware de logging
│   ├── routes/
│   │   ├── index.js              # Agregador de rotas
│   │   ├── auth.js               # Rotas de autenticação
│   │   ├── produtos.js           # Rotas de produtos
│   │   ├── pedidos.js            # Rotas de pedidos
│   │   ├── notas.js              # Rotas de notas fiscais
│   │   ├── notificacoes.js       # Rotas de notificações
│   │   └── contas.js             # Rotas de contas
│   ├── controllers/
│   │   ├── authController.js     # Lógica de autenticação
│   │   ├── produtosController.js # Lógica de produtos
│   │   ├── pedidosController.js  # Lógica de pedidos
│   │   ├── notasController.js    # Lógica de notas
│   │   ├── notificacoesController.js # Lógica de notificações
│   │   └── contasController.js   # Lógica de contas
│   ├── services/
│   │   ├── blingService.js       # Integração com API Bling
│   │   ├── authService.js        # Serviço de autenticação
│   │   ├── firebaseService.js    # Serviço Firebase
│   │   ├── notificacaoService.js # Serviço de notificações
│   │   └── utils.js              # Funções utilitárias
│   └── utils/
│       ├── errorResponse.js      # Helper para respostas de erro
│       ├── validators.js         # Validadores de entrada
│       └── constants.js          # Constantes da aplicação
├── index.js                      # Ponto de entrada
├── package.json
└── .env.example
```

## Fases de Refatoração

### Fase 1: Preparação (Semana 1)

**Objetivos:**
- Criar a estrutura de diretórios proposta
- Extrair configurações para arquivos separados
- Implementar validação de variáveis de ambiente

**Tarefas:**
1. Criar diretórios `src/config`, `src/utils`, `src/services`, `src/controllers`, `src/routes`
2. Mover validação de ambiente para `src/config/environment.js`
3. Mover helpers de erro para `src/utils/errorResponse.js`
4. Mover constantes para `src/utils/constants.js`

**Arquivos a Criar:**
- `src/config/environment.js`
- `src/utils/errorResponse.js`
- `src/utils/constants.js`

### Fase 2: Serviços (Semana 2)

**Objetivos:**
- Extrair lógica de integração com APIs externas
- Criar serviços reutilizáveis

**Tarefas:**
1. Consolidar `blingService.js` com lógica do `index.js`
2. Criar `authService.js` com lógica de autenticação
3. Criar `firebaseService.js` com lógica de notificações
4. Criar `notificacaoService.js` com lógica de agendamento

**Arquivos a Atualizar:**
- `src/services/blingService.js`
- `src/services/authService.js`
- `src/services/firebaseService.js`
- `src/services/notificacaoService.js`

### Fase 3: Controllers (Semana 3)

**Objetivos:**
- Extrair lógica de negócio das rotas
- Criar controllers reutilizáveis

**Tarefas:**
1. Criar `authController.js` com lógica de login, logout, OAuth
2. Criar `produtosController.js` com lógica de CRUD de produtos
3. Criar `pedidosController.js` com lógica de pedidos
4. Criar `notasController.js` com lógica de notas fiscais
5. Criar `notificacoesController.js` com lógica de notificações
6. Criar `contasController.js` com lógica de contas a pagar/receber

**Arquivos a Criar:**
- `src/controllers/authController.js`
- `src/controllers/produtosController.js`
- `src/controllers/pedidosController.js`
- `src/controllers/notasController.js`
- `src/controllers/notificacoesController.js`
- `src/controllers/contasController.js`

### Fase 4: Rotas (Semana 4)

**Objetivos:**
- Reorganizar rotas usando controllers
- Criar arquivo agregador de rotas

**Tarefas:**
1. Atualizar `src/routes/auth.js` para usar `authController`
2. Criar `src/routes/produtos.js` para usar `produtosController`
3. Criar `src/routes/pedidos.js` para usar `pedidosController`
4. Criar `src/routes/notas.js` para usar `notasController`
5. Criar `src/routes/notificacoes.js` para usar `notificacoesController`
6. Criar `src/routes/contas.js` para usar `contasController`
7. Criar `src/routes/index.js` agregador

**Arquivos a Atualizar:**
- `src/routes/auth.js`
- `src/routes/produtos.js`
- `src/routes/pedidos.js`
- `src/routes/notas.js`
- `src/routes/notificacoes.js`
- `src/routes/contas.js`
- `src/routes/index.js`

### Fase 5: Middleware (Semana 5)

**Objetivos:**
- Consolidar middleware em arquivos separados
- Melhorar tratamento de erros

**Tarefas:**
1. Criar `src/middleware/auth.js` com middleware de autenticação
2. Criar `src/middleware/errorHandler.js` com tratamento de erros
3. Criar `src/middleware/logger.js` com logging

**Arquivos a Criar:**
- `src/middleware/auth.js`
- `src/middleware/errorHandler.js`
- `src/middleware/logger.js`

### Fase 6: Aplicação Principal (Semana 6)

**Objetivos:**
- Consolidar configuração Express em `src/app.js`
- Simplificar `index.js`

**Tarefas:**
1. Criar `src/app.js` com configuração Express
2. Atualizar `index.js` para apenas iniciar o servidor
3. Remover código duplicado

**Arquivos a Atualizar:**
- `src/app.js`
- `index.js`

### Fase 7: Testes e Validação (Semana 7)

**Objetivos:**
- Testar a aplicação refatorada
- Validar que todas as funcionalidades funcionam

**Tarefas:**
1. Testar todas as rotas de autenticação
2. Testar todas as rotas de produtos
3. Testar todas as rotas de pedidos
4. Testar todas as rotas de notas fiscais
5. Testar todas as rotas de notificações
6. Testar todas as rotas de contas
7. Validar tratamento de erros
8. Validar logging

### Fase 8: Limpeza e Documentação (Semana 8)

**Objetivos:**
- Remover código morto
- Documentar a nova arquitetura

**Tarefas:**
1. Remover `app.js`, `app-simple.js` (se não forem necessários)
2. Atualizar `README.md` com nova estrutura
3. Criar documentação de API
4. Criar guia de desenvolvimento

## Exemplo de Refatoração

### Antes (index.js - monolito)

```javascript
app.get('/api/produtos', requireAuthJson, async (req, res) => {
  const token = req.cookies?.bling_token;
  if (!token) return res.status(401).json({ error: 'Bling não conectado' });
  
  try {
    const limit = 100;
    let page = 1;
    let allProducts = [];
    let hasMore = true;
    
    while (hasMore && page <= 5) {
      const { data } = await axios.get('https://www.bling.com.br/Api/v3/produtos', {
        headers: { Authorization: `Bearer ${token}` },
        params: { limite: limit, pagina: page },
      });
      const items = Array.isArray(data?.data) ? data.data : [];
      allProducts = allProducts.concat(items);
      hasMore = items.length === limit;
      page++;
    }
    
    const products = allProducts.map(p => ({
      id: p.id,
      nome: p.nome || 'Sem nome',
      // ... mais campos
    }));
    
    res.json({ total: products.length, products });
  } catch (err) {
    if (err.response?.status === 401) {
      res.clearCookie('bling_token');
      return res.status(401).json({ error: 'Token expirado' });
    }
    res.status(500).json({ error: 'Erro ao buscar produtos', detail: err.message });
  }
});
```

### Depois (Refatorado)

**src/services/blingService.js:**
```javascript
class BlingService {
  async getProdutos(token) {
    const limit = 100;
    let page = 1;
    let allProducts = [];
    let hasMore = true;
    
    while (hasMore && page <= 5) {
      const { data } = await axios.get('https://www.bling.com.br/Api/v3/produtos', {
        headers: { Authorization: `Bearer ${token}` },
        params: { limite: limit, pagina: page },
      });
      const items = Array.isArray(data?.data) ? data.data : [];
      allProducts = allProducts.concat(items);
      hasMore = items.length === limit;
      page++;
    }
    
    return allProducts;
  }
}

module.exports = new BlingService();
```

**src/controllers/produtosController.js:**
```javascript
const blingService = require('../services/blingService');
const { sendErrorResponse } = require('../utils/errorResponse');

class ProdutosController {
  async listar(req, res) {
    const token = req.cookies?.bling_token;
    if (!token) {
      return res.status(401).json({ error: 'Bling não conectado' });
    }
    
    try {
      const allProducts = await blingService.getProdutos(token);
      
      const products = allProducts.map(p => ({
        id: p.id,
        nome: p.nome || 'Sem nome',
        // ... mais campos
      }));
      
      res.json({ total: products.length, products });
    } catch (err) {
      if (err.response?.status === 401) {
        res.clearCookie('bling_token');
        return res.status(401).json({ error: 'Token expirado' });
      }
      sendErrorResponse(res, 500, 'Erro ao buscar produtos', err.message);
    }
  }
}

module.exports = new ProdutosController();
```

**src/routes/produtos.js:**
```javascript
const express = require('express');
const produtosController = require('../controllers/produtosController');
const { requireAuthJson } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuthJson, (req, res) => produtosController.listar(req, res));

module.exports = router;
```

**src/app.js:**
```javascript
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const produtosRoutes = require('./routes/produtos');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors());
app.use(express.static('public', { index: false }));

app.use('/api/produtos', produtosRoutes);

app.use(errorHandler);

module.exports = app;
```

**index.js:**
```javascript
require('dotenv').config();
const app = require('./src/app');
const { validateEnvironment } = require('./src/config/environment');

if (require.main === module) {
  validateEnvironment();
  app.listen(process.env.PORT || 3000, () => {
    console.log(`✅ Servidor iniciado em http://localhost:${process.env.PORT || 3000}`);
  });
}

module.exports = app;
```

## Benefícios da Refatoração

1. **Manutenibilidade:** Código mais organizado e fácil de entender
2. **Testabilidade:** Lógica separada da HTTP, facilitando testes unitários
3. **Reutilização:** Serviços podem ser reutilizados em diferentes contextos
4. **Escalabilidade:** Fácil adicionar novas funcionalidades
5. **Colaboração:** Múltiplos desenvolvedores podem trabalhar em diferentes módulos
6. **Documentação:** Estrutura clara facilita documentação

## Timeline Estimada

- **Total:** 8 semanas
- **Esforço:** ~320 horas (1 desenvolvedor full-time)
- **Equipe Recomendada:** 2-3 desenvolvedores

## Próximos Passos

1. Revisar este plano com a equipe
2. Priorizar fases se necessário
3. Criar branches Git para cada fase
4. Implementar testes automatizados durante a refatoração
5. Documentar mudanças e decisões arquiteturais

## Referências

- [Express.js Best Practices](https://expressjs.com/en/advanced/best-practice-performance.html)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)
- [Clean Code in JavaScript](https://github.com/ryanmcdermott/clean-code-javascript)
