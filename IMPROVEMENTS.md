# Melhorias de Funcionalidade e Performance

## 1. Paginação Melhorada

### Problema Identificado

As rotas de API limitam a busca de dados a um número fixo de páginas:
- `/api/produtos`: máximo 5 páginas (500 produtos)
- `/api/financeiro`: máximo 3 páginas (300 pedidos)
- `/api/contas/:tipo`: máximo 3 páginas (300 contas)

Usuários com volumes maiores de dados perdem informações.

### Solução Proposta

Implementar paginação dinâmica com suporte a parâmetros de query:

```javascript
// Antes
app.get('/api/produtos', requireAuthJson, async (req, res) => {
  // ... busca até 5 páginas (hardcoded)
});

// Depois
app.get('/api/produtos', requireAuthJson, async (req, res) => {
  const { pagina = 1, limite = 100, maxPaginas = 10 } = req.query;
  // ... busca com parâmetros flexíveis
});
```

**Benefícios:**
- Usuários podem controlar quantos dados desejam buscar
- Melhor performance para usuários com poucos dados
- Compatibilidade com grandes volumes de dados

---

## 2. Cache de Dados

### Problema Identificado

Cada requisição para `/api/produtos` faz múltiplas chamadas à API do Bling, mesmo que os dados não tenham mudado.

### Solução Proposta

Implementar cache com TTL (Time To Live):

```javascript
const cache = new Map();

function setCache(key, value, ttl = 5 * 60 * 1000) { // 5 minutos
  cache.set(key, { value, expires: Date.now() + ttl });
}

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

// Usar em rotas
app.get('/api/produtos', requireAuthJson, async (req, res) => {
  const cacheKey = `produtos_${req.cookies.bling_token}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  
  // ... buscar dados
  setCache(cacheKey, result);
  res.json(result);
});
```

**Benefícios:**
- Reduz chamadas à API do Bling
- Melhora performance
- Reduz custos de banda

---

## 3. Validação de Input Robusta

### Problema Identificado

Falta validação adequada de parâmetros de entrada em muitas rotas.

### Solução Proposta

Usar biblioteca `joi` ou `zod` para validação:

```javascript
const { z } = require('zod');

const produtoSchema = z.object({
  nome: z.string().min(1),
  preco: z.number().positive(),
  estoque: z.number().int().nonnegative(),
});

app.post('/api/produtos', requireAuthJson, async (req, res) => {
  try {
    const dados = produtoSchema.parse(req.body);
    // ... processar dados validados
  } catch (err) {
    return res.status(400).json({ error: 'Dados inválidos', details: err.errors });
  }
});
```

**Benefícios:**
- Previne erros causados por dados inválidos
- Melhor documentação de API
- Facilita testes

---

## 4. Rate Limiting

### Problema Identificado

Sem proteção contra força bruta ou abuso de API.

### Solução Proposta

Implementar rate limiting nas rotas críticas:

```javascript
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // 5 tentativas
  message: 'Muitas tentativas de login. Tente novamente mais tarde.',
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 100, // 100 requisições
});

app.post('/api/auth/login', loginLimiter, (req, res) => {
  // ... lógica de login
});

app.use('/api/', apiLimiter);
```

**Benefícios:**
- Protege contra força bruta
- Protege contra DDoS
- Melhora segurança geral

---

## 5. Logging Estruturado

### Problema Identificado

Uso de `console.log` e `console.error` não é adequado para produção.

### Solução Proposta

Usar biblioteca Winston ou Pino:

```javascript
const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }));
}

// Usar
logger.info('Usuário autenticado', { userId: user.id });
logger.error('Erro ao buscar produtos', { error: err.message });
```

**Benefícios:**
- Logs estruturados
- Fácil integração com ferramentas de monitoramento
- Melhor rastreamento de problemas

---

## 6. Monitoramento de Performance

### Problema Identificado

Sem visibilidade sobre performance da aplicação.

### Solução Proposta

Adicionar middleware de monitoramento:

```javascript
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('Request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
    });
  });
  next();
});
```

**Benefícios:**
- Identifica gargalos
- Monitora saúde da aplicação
- Facilita otimização

---

## 7. Tratamento de Timeouts

### Problema Identificado

Requisições para API do Bling podem travar indefinidamente.

### Solução Proposta

Adicionar timeouts nas chamadas HTTP:

```javascript
const axiosInstance = axios.create({
  timeout: 10000, // 10 segundos
});

// Usar em vez de axios direto
const { data } = await axiosInstance.get('https://www.bling.com.br/Api/v3/produtos', {
  headers: { Authorization: `Bearer ${token}` },
});
```

**Benefícios:**
- Evita travamentos
- Melhora experiência do usuário
- Facilita tratamento de erros

---

## 8. Refresh Token Automático

### Problema Identificado

Quando o token Bling expira, o usuário é desconectado.

### Solução Proposta

Implementar refresh automático de token:

```javascript
async function getValidBlingToken(req, res) {
  let token = req.cookies?.bling_token;
  
  if (!token) {
    throw new Error('Token não encontrado');
  }
  
  // Verificar se token está próximo de expirar
  const expiresAt = req.cookies?.bling_token_expires;
  if (expiresAt && Date.now() > expiresAt - 5 * 60 * 1000) { // 5 minutos antes
    // Renovar token
    const refreshToken = req.cookies?.bling_refresh;
    if (refreshToken) {
      const newToken = await refreshBlingToken(refreshToken);
      token = newToken.access_token;
      res.cookie('bling_token', token, { httpOnly: true, secure: true });
      res.cookie('bling_token_expires', Date.now() + newToken.expires_in * 1000, { httpOnly: true });
    }
  }
  
  return token;
}
```

**Benefícios:**
- Experiência de usuário melhorada
- Menos interrupções
- Fluxo mais suave

---

## 9. Auditoria e Rastreamento

### Problema Identificado

Sem registro de quem fez o quê e quando.

### Solução Proposta

Implementar log de auditoria:

```javascript
async function logAuditoria(acao, usuario, dados) {
  await db.collection('auditoria').insertOne({
    acao,
    usuario,
    dados,
    timestamp: new Date(),
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
}

// Usar em operações críticas
app.patch('/api/produtos/:id', requireAuthJson, async (req, res) => {
  // ... atualizar produto
  await logAuditoria('PRODUTO_ATUALIZADO', req.user.email, {
    produtoId: req.params.id,
    mudancas: req.body,
  });
});
```

**Benefícios:**
- Rastreamento completo de mudanças
- Conformidade com regulamentações
- Facilita investigação de problemas

---

## 10. Documentação de API

### Problema Identificado

Falta documentação clara das endpoints da API.

### Solução Proposta

Usar Swagger/OpenAPI:

```javascript
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger.json');

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
```

**swagger.json:**
```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "Sistema Estoque Max API",
    "version": "1.0.0"
  },
  "paths": {
    "/api/produtos": {
      "get": {
        "summary": "Listar produtos",
        "parameters": [
          {
            "name": "pagina",
            "in": "query",
            "schema": { "type": "integer", "default": 1 }
          }
        ],
        "responses": {
          "200": {
            "description": "Lista de produtos"
          }
        }
      }
    }
  }
}
```

**Benefícios:**
- Documentação clara e interativa
- Facilita integração com clientes
- Melhora experiência do desenvolvedor

---

## 11. Testes Automatizados

### Problema Identificado

Sem testes automatizados para validar funcionalidades.

### Solução Proposta

Implementar testes com Jest:

```javascript
// __tests__/auth.test.js
describe('Autenticação', () => {
  test('deve fazer login com credenciais válidas', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'senha123' });
    
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
  
  test('deve rejeitar credenciais inválidas', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'errada' });
    
    expect(res.status).toBe(401);
  });
});
```

**Benefícios:**
- Confiança no código
- Facilita refatoração
- Reduz bugs

---

## 12. Backup e Recuperação de Dados

### Problema Identificado

Sem estratégia de backup de dados críticos.

### Solução Proposta

Implementar backup automático:

```javascript
const schedule = require('node-schedule');

// Fazer backup diariamente às 2 AM
schedule.scheduleJob('0 2 * * *', async () => {
  const backup = await db.collection('produtos').find({}).toArray();
  await fs.writeFile(
    `backups/produtos-${new Date().toISOString()}.json`,
    JSON.stringify(backup, null, 2)
  );
  logger.info('Backup realizado');
});
```

**Benefícios:**
- Proteção contra perda de dados
- Recuperação rápida em caso de problema
- Conformidade com regulamentações

---

## Priorização de Melhorias

### Alta Prioridade (Implementar Imediatamente)
1. Validação de Input Robusta
2. Rate Limiting
3. Logging Estruturado
4. Tratamento de Timeouts

### Média Prioridade (Implementar em 1-2 Meses)
5. Cache de Dados
6. Paginação Melhorada
7. Refresh Token Automático
8. Auditoria e Rastreamento

### Baixa Prioridade (Implementar em 2-3 Meses)
9. Monitoramento de Performance
10. Documentação de API
11. Testes Automatizados
12. Backup e Recuperação

---

## Estimativa de Esforço

| Melhoria | Esforço | Impacto |
|----------|---------|--------|
| Validação de Input | 8h | Alto |
| Rate Limiting | 4h | Alto |
| Logging Estruturado | 8h | Médio |
| Tratamento de Timeouts | 4h | Médio |
| Cache de Dados | 12h | Alto |
| Paginação Melhorada | 8h | Médio |
| Refresh Token | 12h | Médio |
| Auditoria | 16h | Médio |
| Monitoramento | 8h | Baixo |
| Documentação API | 12h | Médio |
| Testes | 20h | Alto |
| Backup | 8h | Médio |
| **Total** | **120h** | |

---

## Próximos Passos

1. Revisar e priorizar melhorias com a equipe
2. Criar issues no GitHub para cada melhoria
3. Implementar melhorias de alta prioridade primeiro
4. Testar cada melhoria antes de fazer merge
5. Documentar mudanças no CHANGELOG
