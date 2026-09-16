echo "🟢🟢🟢 COMEÇO DA RESPOSTA — COPIE A PARTIR DAQUI 🟢🟢🟢"

set +e

bash <<'MAXPATCH'
set -Eeuo pipefail

ROOT="/home/u377662950/domains/maxcortelaser.com.br"
SOURCE="$ROOT/hbuilds/last-source"
RUNTIME="$ROOT/hbuilds/current/nodejs"
ENV_FILE="$ROOT/hbuilds/config/.env"
NODE="/opt/alt/alt-nodejs22/root/usr/bin/node"

INDEX_S="$SOURCE/index.js"
INDEX_R="$RUNTIME/index.js"
EXPECTED_INDEX="e2a34bcf9acfebc5e5a25e665d6df19957cd5e1d7d480403f827404e609f258d"
EXPECTED_PACKAGE="0a66676ccc70fe0b294b8a00e059545b39633f01dfd048d87aed78dc77168943"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="$ROOT/storage/backups/max-supplier-backend-v1-$TS"
TMP="$ROOT/storage/backups/.max-supplier-backend-v1-$TS"
PUBLISHED=0
MIGRATION_STARTED=0
MIGRATION_DONE=0

ERROR_MAIN="Falha não identificada"
CAUSE="Validação não identificada"
ERROR_FILE="$INDEX_S"
ERROR_FUNCTION="MAX FORNECEDOR BACKEND V1"

fail(){
  ERROR_MAIN="$1"
  CAUSE="$2"
  ERROR_FILE="$3"
  return 1
}

restart_backend(){
  mkdir -p "$RUNTIME/tmp"
  touch "$RUNTIME/tmp/restart.txt"
  sleep 8
}

wait_health(){
  local code="000"
  for try in $(seq 1 45); do
    code="$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' "https://maxcortelaser.com.br/health?max_supplier=$TS" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then
      echo "HEALTH_HTTP=200"
      return 0
    fi
    sleep 1
  done
  echo "HEALTH_HTTP=$code"
  return 1
}

rollback(){
  set +e
  if [ -f "$BACKUP/index.source.before.js" ]; then cp -f "$BACKUP/index.source.before.js" "$INDEX_S"; fi
  if [ -f "$BACKUP/index.runtime.before.js" ]; then cp -f "$BACKUP/index.runtime.before.js" "$INDEX_R"; fi
  rm -rf "$SOURCE/lib/supplierSync" "$RUNTIME/lib/supplierSync"
  restart_backend >/dev/null 2>&1 || true
}

on_error(){
  rc=$?
  line="$1"
  cmd="$2"
  trap - ERR
  set +e

  if [ "$ERROR_MAIN" = "Falha não identificada" ]; then
    ERROR_MAIN="Comando técnico falhou"
    CAUSE="linha=$line comando=$cmd"
  fi

  STATUS="🔴 INSTALAÇÃO: FALHOU"
  RB="NÃO NECESSÁRIO"

  if [ "$PUBLISHED" = "1" ]; then
    rollback
    STATUS="🟠 INSTALAÇÃO FALHOU, MAS ROLLBACK DE CÓDIGO FOI CONCLUÍDO"
    RB="CÓDIGO RESTAURADO; TABELAS ADITIVAS PRESERVADAS"
  elif [ "$MIGRATION_DONE" = "1" ]; then
    RB="TABELAS ADITIVAS PRESERVADAS; PRODUÇÃO NÃO PUBLICADA"
  elif [ "$MIGRATION_STARTED" = "1" ]; then
    RB="MIGRAÇÃO PODE TER CRIADO TABELAS ADITIVAS PARCIAIS; PRODUÇÃO NÃO PUBLICADA"
  fi

  rm -rf "$TMP" >/dev/null 2>&1 || true

  echo
  echo "ERRO_PRINCIPAL=$ERROR_MAIN"
  echo "CAUSA=$CAUSE"
  echo "ARQUIVO=$ERROR_FILE"
  echo "FUNCAO=$ERROR_FUNCTION"
  echo "STATUS=$STATUS"
  echo "ROLLBACK=$RB"
  echo "PROXIMO_PASSO=Me envie esta saída."
  exit "$rc"
}

trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

mkdir -p "$TMP" "$BACKUP"

echo
echo "======================================================"
echo " MAX FORNECEDOR AUTOMÁTICO — BACKEND V1"
echo "======================================================"

[ "$ROOT" = "/home/u377662950/domains/maxcortelaser.com.br" ] || fail "ROOT inesperado" "Proteção de domínio" "$ROOT"
case "$ROOT" in *sistemamaxflux.com.br*|*hostingersite.com*) fail "Domínio proibido" "Proteção acionada" "$ROOT";; esac

for f in "$INDEX_S" "$INDEX_R" "$SOURCE/package.json" "$RUNTIME/package.json" "$SOURCE/lib/mysql/db.js" "$ENV_FILE"; do
  [ -f "$f" ] || fail "Arquivo obrigatório ausente" "Preflight" "$f"
done

cmp -s "$INDEX_S" "$INDEX_R" || fail "Index Source/Runtime divergente" "Patch recusado" "$INDEX_S"
cmp -s "$SOURCE/package.json" "$RUNTIME/package.json" || fail "Package Source/Runtime divergente" "Patch recusado" "$SOURCE/package.json"

INDEX_SHA="$(sha256sum "$INDEX_S" | awk '{print $1}')"
PACKAGE_SHA="$(sha256sum "$SOURCE/package.json" | awk '{print $1}')"
[ "$INDEX_SHA" = "$EXPECTED_INDEX" ] || fail "index.js mudou desde a auditoria" "esperado=$EXPECTED_INDEX atual=$INDEX_SHA" "$INDEX_S"
[ "$PACKAGE_SHA" = "$EXPECTED_PACKAGE" ] || fail "package.json mudou desde a auditoria" "esperado=$EXPECTED_PACKAGE atual=$PACKAGE_SHA" "$SOURCE/package.json"

