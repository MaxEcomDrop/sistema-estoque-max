grep -Eq '^[[:space:]]*ML_STOCK_SYNC_ENABLED[[:space:]]*=[[:space:]]*false[[:space:]]*$' "$ENV_FILE" || fail "ML_STOCK_SYNC_ENABLED não está false" "Proteção obrigatória" "$ENV_FILE"

[ ! -e "$SOURCE/lib/supplierSync" ] || fail "lib/supplierSync já existe no Source" "Recusada sobrescrita" "$SOURCE/lib/supplierSync"
[ ! -e "$RUNTIME/lib/supplierSync" ] || fail "lib/supplierSync já existe no Runtime" "Recusada sobrescrita" "$RUNTIME/lib/supplierSync"
! grep -Fq 'ESTOQUE_MAX_SUPPLIER_SYNC_V1_START' "$INDEX_S" || fail "Hook supplierSync já existe" "Recusada duplicação" "$INDEX_S"

grep -Fq 'async function ensureBlingToken(req,res)' "$INDEX_S" || fail "ensureBlingToken não localizado" "Contrato mudou" "$INDEX_S"
grep -Fq 'async function getCronBlingToken()' "$INDEX_S" || fail "getCronBlingToken não localizado" "Worker não pode retomar com segurança" "$INDEX_S"
grep -Fq 'async function estoqueMaxPersistConfirmedMaster(' "$INDEX_S" || fail "Persistidor mestre não localizado" "Contrato mudou" "$INDEX_S"
grep -Fq 'async function getProductOverridePersistent(' "$INDEX_S" || fail "Leitura de override não localizada" "Contrato mudou" "$INDEX_S"
grep -Fq 'localProductsRepo' "$INDEX_S" || fail "localProductsRepo não localizado" "Contrato mudou" "$INDEX_S"
grep -Fq 'localInventoryRepo' "$INDEX_S" || fail "localInventoryRepo não localizado" "Contrato mudou" "$INDEX_S"

MARKER_COUNT="$(grep -Fc '// ── 404 ──────────────────────────────────────────────────────────────' "$INDEX_S" || true)"
[ "$MARKER_COUNT" = "1" ] || fail "Marcador 404 inesperado" "count=$MARKER_COUNT" "$INDEX_S"

echo "PREFLIGHT=OK"
echo "INDEX_SHA=$INDEX_SHA"
echo "PACKAGE_SHA=$PACKAGE_SHA"
echo "NODE=$($NODE --version)"
echo "ML_STOCK_SYNC_ENABLED=false"

cp -a "$INDEX_S" "$BACKUP/index.source.before.js"
cp -a "$INDEX_R" "$BACKUP/index.runtime.before.js"
echo "BACKUP=$BACKUP"

REMOTE_BASE="https://raw.githubusercontent.com/MaxEcomDrop/sistema-estoque-max/max-supplier-continuation-20260915/ops/max-supplier-backend-core"
for PART in 01 02 03 04; do
  curl -fsSL "$REMOTE_BASE.part$PART.b64" -o "$TMP/core.part$PART.b64" || fail "Falha ao baixar pacote do branch" "part=$PART" "$REMOTE_BASE.part$PART.b64"
done
cat "$TMP"/core.part*.b64 > "$TMP/supplier-backend-core.tgz.b64"
B64_SHA="$(sha256sum "$TMP/supplier-backend-core.tgz.b64" | awk '{print $1}')"
[ "$B64_SHA" = "876fc2abb7432f6eeecfa4eb824eaffce53f55ab536989a62d99cd0d6aa20460" ] || fail "Pacote base64 divergiu" "sha=$B64_SHA" "$TMP/supplier-backend-core.tgz.b64"
base64 -d "$TMP/supplier-backend-core.tgz.b64" > "$TMP/supplier-backend-core.tgz"
TGZ_SHA="$(sha256sum "$TMP/supplier-backend-core.tgz" | awk '{print $1}')"
[ "$TGZ_SHA" = "8b7d3a2accb08f38e55c366b5327eb73da3927d0ec9b625cd5df82ab324845fa" ] || fail "Pacote tgz divergiu" "sha=$TGZ_SHA" "$TMP/supplier-backend-core.tgz"
base64 -d "$TMP/supplier-backend-core.tgz.b64" > "$TMP/supplier-backend-core.tgz"
mkdir -p "$TMP/pkg"
tar -xzf "$TMP/supplier-backend-core.tgz" -C "$TMP/pkg"

for f in "$TMP/pkg"/lib/supplierSync/*.js; do
  "$NODE" --check "$f" >/dev/null
  echo "SYNTAX_OK=$(basename "$f")"
done

cp -a "$INDEX_S" "$TMP/index.js"

"$NODE" - "$TMP/index.js" <<'NODE'
const fs=require('fs');
const file=process.argv[2];
let src=fs.readFileSync(file,'utf8');
const marker='// ── 404 ──────────────────────────────────────────────────────────────';
if(src.split(marker).length-1!==1) throw new Error('404_MARKER_COUNT');
const block=`/* ESTOQUE_MAX_SUPPLIER_SYNC_V1_START */

async function maxSupplierResolveActorV1(req){
  const payload=jwt.verify(
    req?.cookies?.system_token || '',
    JWT_SECRET
  );

  const email=String(payload?.email || '')
    .trim()
    .toLowerCase();

  if(!email){
    const error=new Error('A sessão autenticada não possui identidade estável.');
    error.code='AUTH_IDENTITY_REQUIRED';
    error.status=401;
    throw error;
  }

  return email;
}

async function maxSupplierPersistLocalV1(productId,fields){
  const clean={};

  if(
    fields?.estoque !== undefined &&
    fields?.estoque !== null &&
