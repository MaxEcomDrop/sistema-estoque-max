# 🚀 Deploy no Vercel - Guia Rápido

Sistema pronto para produção! Siga este guia para colocar sua aplicação no ar em poucos minutos.

## ⚡ Início Rápido (5 minutos)

### 1️⃣ Preparar Credenciais Bling

**Obtenha suas credenciais:**
1. Acesse [Bling.com.br](https://www.bling.com.br)
2. Vá em **Configurações → Integrações → Chaves de Acesso**
3. Copie:
   - **Client ID**: `SEU_CLIENT_ID_AQUI`
   - **Client Secret**: `SEU_CLIENT_SECRET_AQUI`

**Configure no Bling:**
1. Vá em **Configurações → Integrações → Aplicações**
2. Crie uma nova aplicação ou edite a existente
3. Configure as URLs (troque pelo domínio real do seu projeto no Vercel):
   - **URL de Callback**: `https://sistema-estoque-max.vercel.app/api/auth/callback`
   - **URL de Webhook**: `https://sistema-estoque-max.vercel.app/api/webhook/bling`

**Configure no Mercado Livre (opcional):**
1. Crie um app em https://developers.mercadolivre.com.br/
2. **URL de Redirect**: `https://sistema-estoque-max.vercel.app/api/ml/callback`

**IMPORTANTE:** a URL de callback/redirect cadastrada no Bling e no Mercado Livre precisa ser **idêntica, caractere por caractere**, ao valor de `BLING_REDIRECT_URI`/`ML_REDIRECT_URI` configurado no Vercel. Qualquer diferença causa o erro `redirect_uri_mismatch`.

### 2️⃣ Deploy no Vercel

```bash
# Clone o repositório (se ainda não tiver)
git clone https://github.com/MaxEcomDrop/sistema-estoque-max.git
cd sistema-estoque-max

# Push suas mudanças
git push origin main
```

**Ou via Website:**

1. Acesse [vercel.com](https://vercel.com)
2. Clique em **New Project**
3. Selecione seu repositório GitHub (`sistema-estoque-max`)
4. Clique em **Import**

### 3️⃣ Configurar Variáveis de Ambiente

No dashboard do Vercel:

1. Projeto → **Settings**
2. **Environment Variables**
3. Adicione:

```env
BLING_CLIENT_ID=SEU_CLIENT_ID_AQUI
BLING_CLIENT_SECRET=SEU_CLIENT_SECRET_AQUI
BLING_REDIRECT_URI=https://sistema-estoque-max.vercel.app/api/auth/callback
ADMIN_EMAIL=seu@email.com
ADMIN_PASSWORD=defina_uma_senha_forte
JWT_SECRET=gerar-chave-aleatoria-aqui
NODE_ENV=production

# Opcional — Mercado Livre (sem isso a aba fica desativada)
ML_CLIENT_ID=
ML_CLIENT_SECRET=
ML_REDIRECT_URI=https://sistema-estoque-max.vercel.app/api/ml/callback

# Opcional — login com Google e persistência do token do Mercado Livre
FIREBASE_SERVICE_ACCOUNT=
```

**Gerar JWT_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4️⃣ Disparar Deploy

```bash
git commit --allow-empty -m "Deploy em produção"
git push origin main
```

Ou clique em **Deploy** no Vercel. ✅

### 5️⃣ Verificar Deploy

1. Aguarde ~2-3 minutos
2. Acesse: `https://sistema-estoque-max.vercel.app`
3. Clique em **Autenticar com Bling**
4. Se funcionar, você está pronto! 🎉

## 📋 Checklist Final

- [ ] Credenciais do Bling obtidas
- [ ] URLs configuradas no Bling (callback + webhook)
- [ ] Repositório enviado para GitHub
- [ ] Projeto criado no Vercel
- [ ] Variáveis de ambiente configuradas
- [ ] Deploy concluído com sucesso
- [ ] Login com Bling funcionando
- [ ] Produtos aparecendo no dashboard
- [ ] Webhooks configurados no Bling

## 🎯 Resultado Final

Sua aplicação está agora em produção!

```
https://sistema-estoque-max.vercel.app
```

### ✅ Funcionalidades Ativas

- Login OAuth2 com Bling
- Sincronização automática de produtos ao fazer login
- Edição inline de quantidades e preços
- Webhooks em tempo real
- Dashboard responsivo

## 📞 Suporte

Se tiver problemas:

1. **Verificar logs Vercel:**
   ```
   vercel logs --follow
   ```

2. **Verificar variáveis de ambiente:**
   - Projeto → Settings → Environment Variables

3. **Validar URLs no Bling:**
   - Callback: `https://sistema-estoque-max.vercel.app/api/auth/callback`
   - Webhook: `https://sistema-estoque-max.vercel.app/api/webhook/bling`

---

**🎊 Parabéns! Seu sistema está em produção!**
