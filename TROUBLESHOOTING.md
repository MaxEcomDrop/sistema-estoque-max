# 🔧 Troubleshooting - Erros Comuns

## ❌ Erro 500 no Vercel

Se você está recebendo:
```
500 : ERRO_INTERNO_DO_SERVIDOR
Código: FUNCTION_INVOCATION_FAILED
```

### ✅ Solução Rápida

Este erro foi **corrigido**! A aplicação agora:
- ✅ Usa banco de dados em memória no Vercel
- ✅ Usa arquivo SQLite em desenvolvimento
- ✅ Tem melhor tratamento de erros

**Faça isto:**

```bash
git pull origin main
git push origin main
```

Vercel vai redeployer automaticamente em ~2-3 minutos.

---

## 🔍 Verificar Logs Vercel

```bash
vercel logs --follow
```

Procure por:
- `[DB]` - Inicialização do banco
- `[ERROR]` - Erros da aplicação
- `[WEBHOOK]` - Eventos de webhook

---

## 🚨 Erro: "Token não fornecido"

**Causa**: Cookie de autenticação não foi definido

**Solução**:
1. Certifique-se de que está logado (`/api/auth/user` deve retornar dados)
2. Limpe cookies: `Ctrl+Shift+Del` (Chrome)
3. Faça login novamente

---

## ⚠️ Erro: "Banco de dados não inicializado"

**Causa**: Banco de dados em memória perdeu dados (reinício do Vercel)

**Solução**:
1. Faça login novamente para recarregar produtos
2. Clique em "Sincronizar" para atualizar

---

## 🌐 CORS Error

**Erro**: `Access to XMLHttpRequest blocked by CORS policy`

**Solução**: Já está configurado no `vercel.json`. Se persistir:

1. Verifique se o domínio está certo
2. Limpe cache do navegador (`Ctrl+Shift+R`)

---

## 📊 Verificar Status da API

```bash
curl https://sistema-estoque-max.vercel.app/api/webhook/bling
```

Resposta esperada:
```json
{
  "message": "Webhook do Bling está funcionando",
  "supported_events": [...],
  "endpoint": "/api/webhook/bling"
}
```

---

## 🔑 Variáveis de Ambiente

Certifique-se de que TODAS estão configuradas no Vercel:

```bash
vercel env list
```

Você deve ver:
- ✅ BLING_CLIENT_ID
- ✅ BLING_CLIENT_SECRET
- ✅ BLING_REDIRECT_URI
- ✅ JWT_SECRET
- ✅ NODE_ENV=production

Se faltar alguma:

```bash
vercel env add NOME_VAR valor
```

---

## 🔄 Redeployer Completo

Se nada funcionar:

```bash
# Opção 1: Force redeploy
git commit --allow-empty -m "Force redeploy"
git push origin main

# Opção 2: Deletar e recriar no Vercel
# 1. Vá ao Vercel Dashboard
# 2. Clique em "Settings → Danger Zone"
# 3. Clique em "Delete Project"
# 4. Reconecte seu repositório
```

---

## 📱 Testar Webhook Localmente

```bash
# Terminal 1: Rodar servidor local
npm run dev

# Terminal 2: Enviar webhook de teste
curl -X POST http://localhost:3000/api/webhook/bling \
  -H "Content-Type: application/json" \
  -d '{
    "sequencia": 12345,
    "tipo": "produto.criacao",
    "idRegistro": 54321
  }'
```

---

## 💾 Dados em Produção

⚠️ **Importante**: 

- **SQLite em memória** = dados não persistem entre deploys
- Use para: Desenvolvimento e testes
- Para produção duradoura: Configure banco externo (PostgreSQL, MongoDB, etc.)

---

## 📞 Suporte Adicional

Se o erro persistir:

1. **Verifique Vercel Logs:**
   ```
   vercel logs --follow
   ```

2. **Verifique stderr:**
   ```
   vercel logs --follow --tail
   ```

3. **Teste localmente:**
   ```
   npm install
   npm run dev
   # Acesse http://localhost:3000
   ```

4. **Limpe tudo:**
   ```
   rm -rf node_modules package-lock.json
   npm install
   npm run dev
   ```

---

**Última atualização**: Sistema otimizado para Vercel ✅
