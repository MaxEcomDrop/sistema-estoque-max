# Webhook do Bling na Hostinger

O endpoint de produção é:

```text
https://green-echidna-518767.hostingersite.com/api/webhook/bling
```

Cadastre essa URL no Bling para os eventos necessários de pedidos, produtos,
estoque e notas fiscais. O servidor responde rapidamente e processa o evento
em seguida.

Quando `BLING_WEBHOOK_SECRET` estiver preenchido, o Bling deve enviar o mesmo
valor no cabeçalho `x-webhook-secret`. Não grave esse segredo no repositório.

Para testar o recebimento sem expor credenciais:

```bash
curl -X POST https://green-echidna-518767.hostingersite.com/api/webhook/bling \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: VALOR_CONFIGURADO_NO_HPANEL" \
  -d '{"tipo":"estoque.atualizacao","data":{"codigo":"SKU-TESTE","estoque":10}}'
```

Resposta esperada:

```json
{"received":true}
```

Consulte **Logs de execução** no hPanel para diagnosticar falhas. A persistência
do webhook usa o mesmo MySQL configurado pelas variáveis `MYSQL_*`.
