# ⚙️ Como Configurar no Vercel - GUIA DEFINITIVO

## 🔴 PROBLEMA ATUAL
```
❌ Erro: Variáveis de ambiente não configuradas
```

## 🟢 SOLUÇÃO

### Passo 1: Obtenha suas credenciais do Bling

1. Acesse: https://www.bling.com.br
2. Vá em **Configurações → Integrações → Chaves de Acesso**
3. Anote:
   - **Client ID**: `56f15479eddae7460b8028e56f2d5f8a64970fe0`
   - **Client Secret**: `ef779c0b849b7ef04446320077e5a109e9e3c81c9abe8b9c0d437759b43b`

### Passo 2: Configure no Vercel Dashboard

1. Acesse: https://vercel.com/dashboard
2. Selecione seu projeto: `sistema-estoque-max`
3. Clique em **Settings**
4. Vá em **Environment Variables**
5. Adicione estas 3 variáveis:

```
Nome: BLING_CLIENT_ID
Valor: 56f15479eddae7460b8028e56f2d5f8a64970fe0

Nome: BLING_CLIENT_SECRET
Valor: ef779c0b849b7ef04446320077e5a109e9e3c81c9abe8b9c0d437759b43b

Nome: BLING_REDIRECT_URI
Valor: https://sistema-estoque-max.vercel.app/api/auth/callback
```

6. Clique em **Save**

### Passo 3: Vercel fará o redeploy automático

- Aguarde ~2-3 minutos
- Você verá "Deployment in progress" → "Deployment complete"

### Passo 4: Teste

Acesse: https://sistema-estoque-max.vercel.app

Se tudo estiver certo, você verá:
- ✅ Página de login profissional
- ✅ Botão "Autenticar com Bling" funcionando
- ✅ Dashboard carregando seus produtos REAIS

---

## 🔍 Como Verificar se Está Correto

Execute no seu navegador:
```javascript
fetch('https://sistema-estoque-max.vercel.app/api/auth/url')
  .then(r => r.json())
  .then(d => console.log(d))
```

Se retornar:
```json
{ "authUrl": "https://www.bling.com.br/Api/v3/oauth/authorize?..." }
```

✅ **ESTÁ CORRETO!**

---

## 🚨 Se Ainda Não Funcionar

1. **Verifique as variáveis:**
   - Vercel Dashboard → Settings → Environment Variables
   - Confirme que as 3 variáveis estão lá

2. **Aguarde o redeploy:**
   - Pode levar até 5 minutos
   - Clique em "Deployments" para acompanhar

3. **Limpe cache do navegador:**
   - Ctrl+Shift+Del (Windows)
   - Cmd+Shift+Del (Mac)

4. **Verifique os logs:**
   ```bash
   vercel logs --follow
   ```

---

## 📝 O que o sistema faz

1. **Login Real com Bling**
   - Você clica "Autenticar com Bling"
   - É redirecionado para autorizar
   - Retorna com token de acesso

2. **Busca Produtos Reais**
   - Dashboard conecta na API do Bling
   - Carrega seus VERDADEIROS produtos
   - Mostra quantidade real do estoque

3. **Edição em Tempo Real**
   - Você edita quantidade/preço
   - Envia de volta para o Bling
   - Dashboard atualiza

---

## ✅ RESUMO

| Etapa | Status |
|-------|--------|
| Código | ✅ Pronto |
| GitHub | ✅ Enviado |
| Vercel | ✅ Deployado |
| **Variáveis de Ambiente** | ⏳ **VOCÊ PRECISA CONFIGURAR** |
| Login Real | ⏳ Depois de configurar |
| Produtos Reais | ⏳ Depois de configurar |

**Configure as variáveis agora e ficará 100% funcional!**

---

## 💡 Próximos Passos

Depois de configurar:

1. **Login com Bling** ✅
2. **Seus produtos aparecem** ✅
3. **Edite quantidades** ✅
4. **Configure webhooks** (opcional)

Pronto! Sistema 100% SÉRIO E REAL! 🚀
