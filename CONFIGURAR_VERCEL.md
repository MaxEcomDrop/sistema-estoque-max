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
   - **Client ID**: `SEU_CLIENT_ID_AQUI`
   - **Client Secret**: `SEU_CLIENT_SECRET_AQUI`

### Passo 2: Configure no Vercel Dashboard

1. Acesse: https://vercel.com/dashboard
2. Selecione seu projeto: `sistema-estoque-max`
3. Clique em **Settings**
4. Vá em **Environment Variables**
5. Adicione estas variáveis (troque `sistema-estoque-max.vercel.app` pelo domínio real do seu projeto, se for diferente):

```
Nome: BLING_CLIENT_ID
Valor: SEU_CLIENT_ID_AQUI

Nome: BLING_CLIENT_SECRET
Valor: SEU_CLIENT_SECRET_AQUI

Nome: BLING_REDIRECT_URI
Valor: https://sistema-estoque-max.vercel.app/api/auth/callback

Nome: ADMIN_EMAIL
Valor: seu@email.com

Nome: ADMIN_PASSWORD
Valor: defina_uma_senha_forte

Nome: JWT_SECRET
Valor: (gere com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

**Opcional — Mercado Livre** (aba fica desativada sem isso, mostrando erro ao clicar em "Conectar"):
```
Nome: ML_CLIENT_ID
Valor: obtenha em https://developers.mercadolivre.com.br/

Nome: ML_CLIENT_SECRET
Valor: obtenha em https://developers.mercadolivre.com.br/

Nome: ML_REDIRECT_URI
Valor: https://sistema-estoque-max.vercel.app/api/ml/callback
```

**IMPORTANTE:** a URL cadastrada aqui em `BLING_REDIRECT_URI`/`ML_REDIRECT_URI` precisa ser **idêntica, caractere por caractere**, à URL de callback cadastrada nos apps do Bling e do Mercado Livre. Qualquer diferença (http vs https, barra no final, domínio errado) causa o erro `redirect_uri_mismatch`.

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
