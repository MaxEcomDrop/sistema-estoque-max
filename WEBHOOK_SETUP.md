# Configuração de Webhooks do Bling

Este documento explica como configurar os webhooks do Bling para sincronização automática de produtos e estoques.

## 🎯 O que é um Webhook?

Um webhook é uma forma de o Bling notificar seu servidor em tempo real quando algo muda. Exemplo:

1. Você cria um novo produto no Bling
2. Bling envia um POST para seu servidor automaticamente
3. Seu servidor processa e atualiza o banco de dados
4. ✅ Novo produto aparece no dashboard automaticamente

## 📋 Eventos Suportados

- **produto.criacao** - Quando um novo produto é criado no Bling
- **produto.atualizacao** - Quando um produto é editado no Bling
- **estoque.atualizacao** - Quando o estoque de um produto muda

## 🔧 Passo 1: Obter URL do Webhook

Sua URL de webhook é:

```
https://sistema-estoque-max.vercel.app/api/webhook/bling
```

Ou em desenvolvimento:

```
http://localhost:3000/api/webhook/bling
```

## 📝 Passo 2: Configurar no Bling

1. Acesse sua conta Bling
2. Vá para **Configurações → Integrações → Webhooks**
3. Clique em **Criar Novo Webhook**
4. Configure:
   - **URL**: `https://sistema-estoque-max.vercel.app/api/webhook/bling`
   - **Eventos**: Selecione:
     - ✅ Produto Criado
     - ✅ Produto Atualizado
     - ✅ Estoque Atualizado
5. Salve a configuração

## 🧪 Passo 3: Testar o Webhook

### Verificar Status

```bash
curl https://sistema-estoque-max.vercel.app/api/webhook/bling
```

Resposta esperada:

```json
{
  "message": "Webhook do Bling está funcionando",
  "supported_events": [
    "produto.criacao",
    "produto.atualizacao",
    "estoque.atualizacao"
  ],
  "endpoint": "/api/webhook/bling"
}
```

### Testar com curl (simulando webhook)

```bash
curl -X POST https://sistema-estoque-max.vercel.app/api/webhook/bling \
  -H "Content-Type: application/json" \
  -d '{
    "sequencia": 12345,
    "tipo": "produto.criacao",
    "idRegistro": 54321
  }'
```

## 🔄 Fluxo de Sincronização

```
[Mudança no Bling]
         ↓
[Bling envia POST para /api/webhook/bling]
         ↓
[Server recebe webhook]
         ↓
[Server faz requisição GET /produtos/{id} ao Bling]
         ↓
[Server recebe dados completos do produto]
         ↓
[Server atualiza SQLite com INSERT OR REPLACE]
         ↓
[✅ Produto sincronizado automaticamente]
```

## 📊 Estrutura do Webhook

Quando o Bling envia um webhook, o corpo é:

```json
{
  "sequencia": 98765,
  "tipo": "produto.criacao",
  "idRegistro": 54321
}
```

- **sequencia**: Número sequencial do evento
- **tipo**: Tipo de evento (produto.criacao, produto.atualizacao, estoque.atualizacao)
- **idRegistro**: ID do produto que foi alterado

## 🛠️ Troubleshooting

### Webhook não é acionado

1. Verifique se a URL está correta no Bling
2. Certifique-se de que a aplicação está deployada na Vercel
3. Verifique os logs da Vercel: `vercel logs`
4. Teste manualmente com curl

### Produto não aparece após webhook

1. Verifique se há um usuário autenticado no banco (tabela `users`)
2. Verifique o log do servidor: `npm run dev`
3. Confirme que o token não expirou
4. Verifique se o produto existe no Bling

### Erro: "Nenhum usuário autenticado encontrado"

Isso significa que nenhum usuário fez login na aplicação ainda. O webhook precisa de um usuário autenticado para fazer requisições ao Bling.

**Solução**: Faça login na aplicação pelo menos uma vez antes de criar produtos no Bling.

## 📈 Logs e Monitoramento

Os webhooks registram em detalhes:

```
[WEBHOOK] Tipo: produto.criacao, ID: 54321, Sequencia: 98765
[WEBHOOK] Produto 54321 sincronizado com sucesso
```

Para acompanhar em tempo real:

```bash
npm run dev
```

E procure por `[WEBHOOK]` nos logs.

## 🔒 Segurança

Atualmente, o webhook aceita requisições de qualquer origem. Em produção, você pode adicionar verificação:

1. **Token de verificação**: Bling pode enviar um token que você verifica
2. **IP whitelist**: Permitir apenas IPs do Bling
3. **Assinatura HMAC**: Verificar assinatura criptográfica

Exemplo de token de verificação no .env:

```env
WEBHOOK_SECRET=sua_chave_secreta_aqui
```

## 📞 Suporte

Se tiver dúvidas:

1. Consulte a [Documentação da API do Bling](https://www.bling.com.br/api)
2. Verifique os logs com `npm run dev`
3. Teste manualmente com curl

## ✅ Checklist de Configuração

- [ ] Obtive a URL do webhook
- [ ] Configurei o webhook no Bling
- [ ] Testei o status do webhook com curl
- [ ] Fiz login na aplicação (autenticação OAuth)
- [ ] Criei um novo produto no Bling
- [ ] Verifico que o produto apareceu automaticamente
- [ ] Atualizei o estoque no Bling
- [ ] Verifico que a quantidade foi atualizada automaticamente

**Após completar todos os passos, sua sincronização automática estará funcionando! 🎉**
