  if(JSON.stringify(names)!==JSON.stringify(expected)) throw new Error('SUPPLIER_SCHEMA_INCOMPLETE:'+JSON.stringify(names));
  console.log('MIGRATION_TABLES='+names.join(','));
  console.log('MIGRATION=OK_ADDITIVE_ONLY');
  await db.end?.();
})().catch(async error=>{
  console.error('MIGRATION_ERROR='+error.message);
  try{await db.end?.();}catch(_error){}
  process.exit(1);
});
NODE
MIGRATION_DONE=1

mkdir -p "$SOURCE/lib/supplierSync" "$RUNTIME/lib/supplierSync"
cp -a "$TMP/pkg/lib/supplierSync/." "$SOURCE/lib/supplierSync/"
cp -a "$TMP/pkg/lib/supplierSync/." "$RUNTIME/lib/supplierSync/"
cp -f "$TMP/index.js" "$INDEX_S"
cp -f "$TMP/index.js" "$INDEX_R"
PUBLISHED=1

cmp -s "$INDEX_S" "$INDEX_R" || fail "Index Source/Runtime divergente" "Publicação incompleta" "$INDEX_S"
for f in "$SOURCE"/lib/supplierSync/*.js; do
  rel="${f#$SOURCE/}"
  cmp -s "$f" "$RUNTIME/$rel" || fail "supplierSync Source/Runtime divergente" "$rel" "$f"
  "$NODE" --check "$f" >/dev/null || fail "Erro de sintaxe no supplierSync" "$rel" "$f"
done
"$NODE" --check "$INDEX_S" >/dev/null || fail "Index publicado inválido" "node --check falhou" "$INDEX_S"

restart_backend
wait_health || fail "Health não voltou 200" "Passenger não confirmou saúde" "$RUNTIME/tmp/restart.txt"

SESSION_HTTP="$(curl -sS --max-time 15 -o "$TMP/session.json" -w '%{http_code}' "https://maxcortelaser.com.br/api/supplier-sync/session?probe=$TS" 2>/dev/null || true)"
CAP_HTTP="$(curl -sS --max-time 15 -o "$TMP/cap.json" -w '%{http_code}' "https://maxcortelaser.com.br/api/supplier-sync/capabilities?probe=$TS" 2>/dev/null || true)"
[ "$SESSION_HTTP" = "401" ] || fail "Rota session não ficou protegida como esperado" "HTTP=$SESSION_HTTP" "/api/supplier-sync/session"
[ "$CAP_HTTP" = "401" ] || fail "Rota capabilities não ficou protegida como esperado" "HTTP=$CAP_HTTP" "/api/supplier-sync/capabilities"

cd "$SOURCE"
"$NODE" - "$ENV_FILE" <<'NODE'
try{require('dotenv').config({path:process.argv[2],quiet:true});}catch(_error){}
const db=require('./lib/mysql/db');
(async()=>{
  const tables=['links','clients','jobs','audit','runs','ops'];
  for(const suffix of tables){
    const table='em_supplier_sync_'+suffix;
    const [rows]=await db.query(`SELECT COUNT(*) total FROM ${table}`);
    console.log(table.toUpperCase()+'_ROWS='+Number(rows[0]?.total||0));
  }
  await db.end?.();
})().catch(async error=>{
  console.error('POSTCHECK_DB_ERROR='+error.message);
  try{await db.end?.();}catch(_error){}
  process.exit(1);
});
NODE

INDEX_NEW_SHA="$(sha256sum "$INDEX_S" | awk '{print $1}')"
MODULE_INDEX_SHA="$(sha256sum "$SOURCE/lib/supplierSync/index.js" | awk '{print $1}')"
rm -rf "$TMP"

echo
echo "======================================================"
echo " RESULTADO — MAX FORNECEDOR BACKEND V1"
echo "======================================================"
echo "ACTOR=JWT_EMAIL_VERIFICADO_E_HASH_INTERNO"
echo "WORKER_TOKEN=getCronBlingToken"
echo "ESTOQUE=SALDO_FISICO_TOTAL"
echo "MASTER_PERSIST=estoqueMaxPersistConfirmedMaster"
echo "LOCAL_STOCK_MIRROR=bling_virtual_total"
echo "FILA=em_supplier_sync_jobs"
echo "FILA_DE_VENDAS_EXISTENTE=INALTERADA"
echo "EM_SYNC_QUEUE=INALTERADA"
echo "PACKAGE_JSON=INALTERADO"
echo "DASHBOARD=INALTERADO"
echo "EXTENSAO=AINDA_NAO_PUBLICADA"
echo "PRODUTOS_ALTERADOS=0"
echo "BLING_WRITE=NENHUMA"
echo "MERCADO_LIVRE_WRITE=NENHUMA"
echo "TIKTOK_WRITE=NENHUMA"
echo "SHOPIFY_WRITE=NENHUMA"
echo "MIGRACAO=6_TABELAS_ADITIVAS_EXCLUSIVAS"
echo "SESSION_UNAUTH_HTTP=$SESSION_HTTP"
echo "CAPABILITIES_UNAUTH_HTTP=$CAP_HTTP"
echo "HEALTH_HTTP=200"
echo "SOURCE_RUNTIME=IGUAIS"
echo "INDEX_SHA256=$INDEX_NEW_SHA"
echo "SUPPLIER_MODULE_SHA256=$MODULE_INDEX_SHA"
echo "BACKUP=$BACKUP"

echo
echo "======================================================"
echo " VEREDITO FINAL"
echo "======================================================"
echo "🟢 INSTALAÇÃO TÉCNICA: 100% CONCLUÍDA"
echo "🟡 HOMOLOGAÇÃO FUNCIONAL COM EXTENSÃO: AGUARDANDO CHROME"
echo "🟡 ESCRITA REAL EM PRODUTO: NÃO TESTADA / NÃO AUTORIZADA"
echo "PROXIMO_PASSO=Não aplique estoque/custo ainda. Me envie esta saída; depois validamos Conectar Estoque Max no Chrome e escolhemos um SKU de teste autorizado."

MAXPATCH

echo "🔴🔴🔴 ✅ TERMINOU — COPIE ATÉ AQUI 🔴🔴🔴"
