# 🚀 Deploy no Vercel - Guia Rápido

Sistema pronto para produção! Siga este guia para colocar sua aplicação no ar em poucos minutos.

## ⚡ Início Rápido (5 minutos)

### 1️⃣ Preparar Credenciais Bling

**Obtenha suas credenciais:**
1. Acesse [Bling.com.br](https://www.bling.com.br)
2. Vá em **Configurações → Integrações → Chaves de Acesso**
3. Copie:
   - **Client ID**: `56f15479eddae7460b8028e56f2d5f8a64970fe0`
   - **Client Secret**: `ef779c0b849b7ef04446320077e5a109e9e3c81c9abe8b9c0d437759b43b`

**Configure no Bling:**
1. Vá em **Configurações → Integrações → Aplicações**
2. Crie uma nova aplicação ou edite a existente
3. Configure as URLs:
   - **URL de Callback**: `https://sistema-estoque-max.vercel.app/api/auth/callback`
   - **URL de Webhook**: `https://sistema-estoque-max.vercel.app/api/webhook/bling`

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
BLING_CLIENT_ID=56f15479eddae7460b8028e56f2d5f8a64970fe0
BLING_CLIENT_SECRET=ef779c0b849b7ef04446320077e5a109e9e3c81c9abe8b9c0d437759b43b
BLING_REDIRECT_URI=https://sistema-estoque-max.vercel.app/api/auth/callback
JWT_SECRET=gerar-chave-aleatoria-aqui
NODE_ENV=production
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
