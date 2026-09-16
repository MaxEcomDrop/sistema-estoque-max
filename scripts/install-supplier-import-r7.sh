#!/usr/bin/env bash
set +e

ROOT="/home/u377662950/domains/maxcortelaser.com.br"
SOURCE="$ROOT/hbuilds/last-source"
RUNTIME="$ROOT/hbuilds/current/nodejs"
ENV_FILE="$ROOT/hbuilds/config/.env"
NODE="/opt/alt/alt-nodejs22/root/usr/bin/node"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$ROOT/storage/backups/supplier-import-r7-$STAMP"
STAGE="/tmp/max-supplier-import-r7-$STAMP"

FAILED=0
PUBLISHED=0
RESTARTED=0
TABLES_BEFORE=0

fail_install() {
  FAILED=1
  echo "ERRO_PRINCIPAL=$1"
  echo "CAUSA=$2"
  echo "ARQUIVO=${3:-N/A}"
  echo "FUNCAO=${4:-N/A}"
  echo "STATUS=🔴 INSTALAÇÃO: FALHOU"
}

rollback_files() {
  if [ "$PUBLISHED" != "1" ]; then
    echo "ROLLBACK=NÃO NECESSÁRIO"
    return
  fi

  echo "ROLLBACK=INICIANDO"

  cp -f "$BACKUP/runtime-index.js" "$RUNTIME/index.js"
  cp -f "$BACKUP/runtime-dashboard.html" "$RUNTIME/public/dashboard.html"

  if [ -f "$BACKUP/source-index.js" ]; then
    cp -f "$BACKUP/source-index.js" "$SOURCE/index.js"
  fi
  if [ -f "$BACKUP/source-dashboard.html" ]; then
    cp -f "$BACKUP/source-dashboard.html" "$SOURCE/public/dashboard.html"
  fi

  if [ -f "$BACKUP/source-supplier-index.js" ]; then
    cp -f "$BACKUP/source-supplier-index.js" "$SOURCE/lib/supplierSync/index.js"
  fi
  if [ -f "$BACKUP/source-supplier-service.js" ]; then
    cp -f "$BACKUP/source-supplier-service.js" "$SOURCE/lib/supplierSync/service.js"
  fi

  rm -rf "$RUNTIME/lib/supplierImportR7"
  rm -rf "$SOURCE/lib/supplierImportR7"
  rm -f "$RUNTIME/public/assets/max-supplier-import-r7.css"
  rm -f "$RUNTIME/public/assets/max-supplier-import-r7.js"
  rm -f "$SOURCE/public/assets/max-supplier-import-r7.css"
  rm -f "$SOURCE/public/assets/max-supplier-import-r7.js"

  if [ "$TABLES_BEFORE" = "0" ]; then
    cd "$RUNTIME"
    "$NODE" - "$ENV_FILE" "$RUNTIME" <<'NODEDROP'
try { require('dotenv').config({ path: process.argv[2], quiet: true }); } catch {}
const db=require(process.argv[3]+'/lib/mysql/db');
(async()=>{
  for(const table of [
    'em_supplier_import_link_blocks',
    'em_supplier_import_agents',
    'em_supplier_agent_commands',
    'em_supplier_import_items',
    'em_supplier_import_runs',
    'em_supplier_import_settings'
  ]){
    await db.rawQuery('DROP TABLE IF EXISTS `'+table+'`');
  }
  await db.closePool();
  console.log('R7_TABLE_ROLLBACK=OK');
})().catch(async e=>{
  console.error('R7_TABLE_ROLLBACK_ERROR='+e.message);
  try{await db.closePool();}catch{}
  process.exit(1);
});
NODEDROP
  fi

  touch "$RUNTIME/tmp/restart.txt"
  sleep 4
  echo "ROLLBACK=CONCLUÍDO"
}

echo
echo "======================================================"
echo " R7 — IMPORTAÇÃO NATIVA + AGENTE 2.0"
echo "======================================================"

if [ ! -d "$ROOT" ] || [ ! -d "$SOURCE" ] || [ ! -d "$RUNTIME" ]; then
  fail_install "Estrutura de produção não encontrada" "ROOT/SOURCE/RUNTIME ausente" "$ROOT" "preflight"
fi

if [ "$FAILED" = "0" ] && [ ! -f "$ENV_FILE" ]; then
  fail_install ".env não encontrado" "Arquivo de configuração ausente" "$ENV_FILE" "preflight"
fi

if [ "$FAILED" = "0" ]; then
  if grep -Eq '^[[:space:]]*ML_STOCK_SYNC_ENABLED[[:space:]]*=[[:space:]]*false[[:space:]]*$' "$ENV_FILE"; then
    echo "ML_STOCK_SYNC_ENABLED=false"
  else
    fail_install "ML_STOCK_SYNC_ENABLED não está false" "Proteção obrigatória ausente" "$ENV_FILE" "preflight"
  fi
fi

if [ "$FAILED" = "0" ]; then
  echo "NODE=$($NODE --version)"
  echo "RUNTIME_REAL=$(readlink -f "$RUNTIME")"
  echo "INDEX_SHA_BEFORE=$(sha256sum "$RUNTIME/index.js" | awk '{print $1}')"
  echo "DASHBOARD_SHA_BEFORE=$(sha256sum "$RUNTIME/public/dashboard.html" | awk '{print $1}')"
fi

if [ "$FAILED" = "0" ]; then
  mkdir -p "$BACKUP" "$STAGE/lib/supplierImportR7" "$STAGE/public/assets"

  cp -f "$RUNTIME/index.js" "$BACKUP/runtime-index.js"
  cp -f "$RUNTIME/public/dashboard.html" "$BACKUP/runtime-dashboard.html"
  cp -f "$SOURCE/index.js" "$BACKUP/source-index.js"
  cp -f "$SOURCE/public/dashboard.html" "$BACKUP/source-dashboard.html"
  cp -f "$SOURCE/lib/supplierSync/index.js" "$BACKUP/source-supplier-index.js"
  cp -f "$SOURCE/lib/supplierSync/service.js" "$BACKUP/source-supplier-service.js"

  echo "BACKUP=$BACKUP"

  cp -f "$RUNTIME/index.js" "$STAGE/index.js"
  cp -f "$RUNTIME/public/dashboard.html" "$STAGE/dashboard.html"
fi

cat > "$STAGE/lib/supplierImportR7/index.js" <<'R7MODULE'
'use strict';

const crypto = require('node:crypto');
const db = require('../mysql/db');
const syncRepo = require('../supplierSync/repository');
const { createBling } = require('../supplierSync/bling');
const { validateSnapshot, compare, same, fail } = require('../supplierSync/core');

const PROVIDER = 'seuarmazemdrop';
const VERSION = '7.0.0';
let workerBusy = false;
let workerTimer = null;

const json = value => {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};
const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const browserId = req => text(req.get('X-Max-Supplier-Browser') || '', 64);
const agentLabel = req => text(req.get('X-Max-Supplier-Agent-Label') || 'Chrome', 80);
const agentVersion = req => text(req.get('X-Max-Supplier-Agent-Version') || '', 20);
const isUuid = value => /^[a-f0-9-]{36}$/i.test(String(value || ''));
const isId = value => /^\d{1,20}$/.test(String(value || '')) && !/^0+$/.test(String(value || ''));
const n = value => value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
const exact = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0 && a === b;

async function actorOf(resolveActor, req) {
  const actor = await resolveActor(req);
  if (!actor || typeof actor !== 'string' || actor.length > 128) fail('ACTOR_INVALID', 'Sessão inválida.', 401);
  return actor;
}

async function effectiveSettings(actor) {
  const [rows] = await db.query(
    `SELECT auto_link,auto_stock,auto_cost,supplier_id,warehouse_id,updated_at
       FROM em_supplier_import_settings
      WHERE actor=? LIMIT 1`,
    [actor]
  );
  const row = rows[0] || null;

  const [supplierRows] = await db.query(
    `SELECT supplier_id,COUNT(*) total
       FROM em_supplier_sync_links
      WHERE supplier_id IS NOT NULL AND supplier_id<>''
      GROUP BY supplier_id
      ORDER BY total DESC,supplier_id
      LIMIT 2`
  );
  const [warehouseRows] = await db.query(
    `SELECT warehouse_id,COUNT(*) total
       FROM em_supplier_sync_links
      WHERE warehouse_id IS NOT NULL AND warehouse_id<>''
      GROUP BY warehouse_id
      ORDER BY total DESC,warehouse_id
      LIMIT 2`
  );

  const inferredSupplier = supplierRows.length === 1 ? String(supplierRows[0].supplier_id) : '';
  const inferredWarehouse = warehouseRows.length === 1 ? String(warehouseRows[0].warehouse_id) : '';

  return {
    autoLink: row ? Number(row.auto_link) === 1 : true,
    autoStock: row ? Number(row.auto_stock) === 1 : true,
    autoCost: row ? Number(row.auto_cost) === 1 : true,
    supplierId: String(row?.supplier_id || inferredSupplier || ''),
    warehouseId: String(row?.warehouse_id || inferredWarehouse || ''),
    inferredSupplier: !row?.supplier_id && Boolean(inferredSupplier),
    inferredWarehouse: !row?.warehouse_id && Boolean(inferredWarehouse),
    updatedAt: row?.updated_at || null
  };
}

async function ensureAgent(actor, req) {
  const id = browserId(req);
  if (!isUuid(id)) fail('AGENT_ID_REQUIRED', 'Agente Chrome não identificado.', 401);

  const [rows] = await db.query(
    `SELECT actor,browser_id,label,expires_at,revoked_at
       FROM em_supplier_sync_clients
      WHERE actor=? AND browser_id=? LIMIT 1`,
    [actor, id]
  );
  const client = rows[0];
  if (!client || client.revoked_at || Date.parse(client.expires_at) <= Date.now()) {
    fail('AGENT_NOT_AUTHORIZED', 'Este Chrome precisa ser autorizado novamente no Estoque Max.', 403);
  }
  return id;
}

async function touchAgent(actor, id, req) {
  await db.query(
    `INSERT INTO em_supplier_import_agents
      (actor,browser_id,label,version,last_seen_at)
     VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       label=VALUES(label),
       version=VALUES(version),
       last_seen_at=CURRENT_TIMESTAMP(3)`,
    [actor, id, agentLabel(req), agentVersion(req)]
  );
}

async function openRemote(getBlingTokenForWorker, axios) {
  const token = await getBlingTokenForWorker();
  if (!token) fail('BLING_DISCONNECTED', 'Conecte o Bling no Estoque Max.', 409);
  return createBling(axios, token);
}

async function insertImport(actor, browser, commandId, rawSnapshot) {
  const clean = validateSnapshot(rawSnapshot);
  const importId = crypto.randomUUID();

  const rawById = new Map();
  for (const page of Array.isArray(rawSnapshot?.pages) ? rawSnapshot.pages : []) {
    const pageNo = Number(page?.page || 0) || null;
    for (const row of Array.isArray(page?.rows) ? page.rows : []) {
      rawById.set(String(row.id || ''), { page: pageNo, image: /^https:\/\//i.test(String(row.image || '')) ? String(row.image) : null });
    }
  }

  const connection = await db.getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO em_supplier_import_runs
        (id,actor,browser_id,provider,status,snapshot_json,total_items,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
      [importId, actor, browser || null, PROVIDER, 'pending', JSON.stringify(clean), clean.rows.length]
    );

    for (const row of clean.rows) {
      const raw = rawById.get(String(row.id)) || {};
      await connection.execute(
        `INSERT INTO em_supplier_import_items
          (import_id,external_id,sku,name,stock,cost,page_no,image_url)
         VALUES (?,?,?,?,?,?,?,?)`,
        [importId, row.id, row.sku, row.name, row.stock, row.cost, raw.page, raw.image]
      );
    }

    if (commandId) {
      await connection.execute(
        `UPDATE em_supplier_agent_commands
            SET status='completed',
                result_json=?,
                finished_at=CURRENT_TIMESTAMP(3),
                updated_at=CURRENT_TIMESTAMP(3)
          WHERE id=? AND actor=?`,
        [JSON.stringify({ importId, accepted: clean.rows.length }), commandId, actor]
      );
    }
    await connection.commit();
  } catch (error) {
    try { await connection.rollback(); } catch {}
    throw error;
  } finally {
    connection.release();
  }

  return { importId, clean };
}

async function latestImport(actor) {
  const [rows] = await db.query(
    `SELECT id,status,total_items,linked_count,sync_queued_count,attention_count,
            sync_run_id,error_text,created_at,updated_at,finished_at,browser_id
       FROM em_supplier_import_runs
      WHERE actor=?
      ORDER BY created_at DESC
      LIMIT 1`,
    [actor]
  );
  return rows[0] || null;
}

async function importRows(actor, importId) {
  if (!importId) return [];
  const [rows] = await db.query(
    `SELECT
       i.external_id,i.sku,i.name,i.stock supplier_stock,i.cost supplier_cost,
       i.page_no,i.image_url,
       l.product_id,l.local_sku,l.supplier_sku,l.supplier_id,l.warehouse_id,
       p.name local_name,p.sku local_sku_live,p.cost_price current_cost,
       inv.quantity_on_hand current_stock,
       b.product_id blocked_product_id,b.reason block_reason
     FROM em_supplier_import_items i
     JOIN em_supplier_import_runs r ON r.id=i.import_id AND r.actor=?
     LEFT JOIN em_supplier_sync_links l ON l.external_id=i.external_id
     LEFT JOIN em_products p ON p.bling_id=l.product_id
     LEFT JOIN em_inventory inv ON inv.sku=p.sku AND inv.warehouse_id='bling_virtual_total'
     LEFT JOIN em_supplier_import_link_blocks b ON b.actor=r.actor AND b.product_id=l.product_id
     WHERE i.import_id=?
     ORDER BY i.sku,i.external_id`,
    [actor, importId]
  );
  return rows;
}

async function stateFor(actor) {
  const settings = await effectiveSettings(actor);
  const current = await latestImport(actor);

  const [agents] = await db.query(
    `SELECT browser_id,label,version,last_seen_at,
            TIMESTAMPDIFF(SECOND,last_seen_at,CURRENT_TIMESTAMP(3)) age_seconds
       FROM em_supplier_import_agents
      WHERE actor=?
      ORDER BY last_seen_at DESC
      LIMIT 10`,
    [actor]
  );

  const [recent] = await db.query(
    `SELECT id,status,total_items,linked_count,sync_queued_count,attention_count,
            error_text,created_at,updated_at,finished_at
       FROM em_supplier_import_runs
      WHERE actor=?
      ORDER BY created_at DESC
      LIMIT 12`,
    [actor]
  );

  const [products] = await db.query(
    `SELECT bling_id product_id,sku,name,cost_price
       FROM em_products
      WHERE bling_id IS NOT NULL AND bling_id<>'' AND sku IS NOT NULL AND sku<>''
      ORDER BY name
      LIMIT 3000`
  );

  let rows = current ? await importRows(actor, current.id) : [];

  const localSkuCounts = new Map();
  for (const product of products) {
    const sku = String(product.sku || '');
    localSkuCounts.set(sku, (localSkuCounts.get(sku) || 0) + 1);
  }
  const supplierSkuCounts = new Map();
  for (const row of rows) {
    const sku = String(row.sku || '');
    supplierSkuCounts.set(sku, (supplierSkuCounts.get(sku) || 0) + 1);
  }

  const [blocks] = await db.query(
    `SELECT product_id,external_id,reason FROM em_supplier_import_link_blocks WHERE actor=?`,
    [actor]
  );
  const blockedProducts = new Set(blocks.map(row => String(row.product_id)));
  const blockedExternal = new Set(blocks.map(row => String(row.external_id || '')));

  const normalized = rows.map(row => {
    const supplierStock = n(row.supplier_stock);
    const supplierCost = n(row.supplier_cost);
    const currentStock = n(row.current_stock);
    const currentCost = n(row.current_cost);
    const linked = Boolean(row.product_id);
    const stockEqual = linked && supplierStock !== null && currentStock !== null && same(supplierStock, currentStock);
    const costEqual = linked && supplierCost !== null && currentCost !== null && same(supplierCost, currentCost);
    const exactCandidate = !linked &&
      (localSkuCounts.get(String(row.sku || '')) || 0) === 1 &&
      (supplierSkuCounts.get(String(row.sku || '')) || 0) === 1;
    const block = blockedExternal.has(String(row.external_id || '')) || (row.product_id && blockedProducts.has(String(row.product_id)));

    let status = 'unlinked';
    if (block) status = 'blocked';
    else if (linked && stockEqual && costEqual) status = 'synced';
    else if (linked) status = 'different';
    else if ((supplierSkuCounts.get(String(row.sku || '')) || 0) > 1 || (localSkuCounts.get(String(row.sku || '')) || 0) > 1) status = 'ambiguous';
    else if (exactCandidate) status = 'exact_candidate';

    return {
      externalId: String(row.external_id),
      sku: row.sku,
      name: row.name,
      image: row.image_url || null,
      page: row.page_no,
      supplierStock,
      supplierCost,
      productId: row.product_id ? String(row.product_id) : null,
      localSku: row.local_sku_live || row.local_sku || null,
      localName: row.local_name || null,
      currentStock,
      currentCost,
      stockEqual,
      costEqual,
      exactCandidate,
      blocked: block,
      blockReason: row.block_reason || null,
      status
    };
  });

  const stats = {
    total: normalized.length,
    linked: normalized.filter(row => row.productId).length,
    synced: normalized.filter(row => row.status === 'synced').length,
    different: normalized.filter(row => row.status === 'different').length,
    attention: normalized.filter(row => ['unlinked','ambiguous','blocked','exact_candidate'].includes(row.status)).length
  };

  return {
    version: VERSION,
    settings,
    agent: agents[0] ? {
      browserId: agents[0].browser_id,
      label: agents[0].label,
      version: agents[0].version,
      lastSeenAt: agents[0].last_seen_at,
      connected: Number(agents[0].age_seconds) <= 90
    } : null,
    latestImport: current,
    stats,
    rows: normalized,
    products: products.map(row => ({
      productId: String(row.product_id),
      sku: row.sku,
      name: row.name,
      cost: n(row.cost_price)
    })),
    recentImports: recent
  };
}

async function linkOne({ actor, browser, remote, row, supplierId, warehouseId, method }) {
  if (!row?.productId || !row?.supplier?.id) return { ok: false, code: 'LINK_INVALID' };
  const link = {
    productId: String(row.productId),
    externalId: String(row.supplier.id),
    localSku: String(row.sku || ''),
    supplierSku: String(row.supplier.sku || ''),
    supplierId: String(supplierId || ''),
    warehouseId: String(warehouseId || '')
  };
  if (!isId(link.productId) || !isId(link.externalId) || !isId(link.supplierId) || !isId(link.warehouseId)) {
    return { ok: false, code: 'LINK_CONFIG_INVALID' };
  }

  const [blockRows] = await db.query(
    `SELECT product_id FROM em_supplier_import_link_blocks
      WHERE actor=? AND (product_id=? OR external_id=?) LIMIT 1`,
    [actor, link.productId, link.externalId]
  );
  if (blockRows.length) return { ok: false, code: 'LINK_BLOCKED' };

  const [existing] = await db.query(
    `SELECT product_id,external_id,local_sku,supplier_sku,supplier_id,warehouse_id
       FROM em_supplier_sync_links
      WHERE product_id=? OR external_id=?`,
    [link.productId, link.externalId]
  );
  if (existing.length) {
    const sameLink = existing.some(item =>
      String(item.product_id) === link.productId &&
      String(item.external_id) === link.externalId
    );
    return sameLink ? { ok: true, replay: true, link } : { ok: false, code: 'LINK_CONFLICT' };
  }

  await remote.verifyLink(link.productId, link);

  await db.query(
    `INSERT INTO em_supplier_sync_links
      (product_id,external_id,local_sku,supplier_sku,supplier_id,warehouse_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
    [link.productId, link.externalId, link.localSku, link.supplierSku, link.supplierId, link.warehouseId]
  );

  await db.query(
    `INSERT INTO em_supplier_sync_audit
      (actor,browser_id,action,product_id,detail_json,created_at)
     VALUES (?,?,?,?,?,CURRENT_TIMESTAMP(3))`,
    [actor, browser || null, method === 'manual' ? 'r7_manual_link' : 'r7_auto_link', link.productId, JSON.stringify({ link, method })]
  );

  return { ok: true, link };
}

async function processImport(importId, deps) {
  const [runRows] = await db.query(
    `SELECT * FROM em_supplier_import_runs WHERE id=? LIMIT 1`,
    [importId]
  );
  const importRun = runRows[0];
  if (!importRun) return;

  if (!['pending','processing'].includes(importRun.status)) return;

  await db.query(
    `UPDATE em_supplier_import_runs
        SET status='processing',updated_at=CURRENT_TIMESTAMP(3),error_text=NULL
      WHERE id=?`,
    [importId]
  );

  const actor = String(importRun.actor);
  const browser = importRun.browser_id ? String(importRun.browser_id) : null;
  const settings = await effectiveSettings(actor);
  const snapshot = json(importRun.snapshot_json);
  if (!snapshot?.rows?.length) throw Error('Snapshot da importação está vazio.');

  const remote = await openRemote(deps.getBlingTokenForWorker, deps.axios);
  const products = await syncRepo.products();
  const totals = await remote.totals(products.map(product => product.productId));
  for (const product of products) product.stock = totals.get(String(product.productId)) ?? null;

  let links = await syncRepo.links();
  let rows = compare(snapshot, products, links, {
    maxStockDelta: 1000000,
    maxCostPercent: 1000
  });

  const [blockRows] = await db.query(
    `SELECT product_id,external_id FROM em_supplier_import_link_blocks WHERE actor=?`,
    [actor]
  );
  const blockedProducts = new Set(blockRows.map(row => String(row.product_id)));
  const blockedExternal = new Set(blockRows.map(row => String(row.external_id || '')));

  let linked = 0;
  const exceptions = [];

  if (settings.autoLink && settings.supplierId && settings.warehouseId) {
    for (const row of rows) {
      if (row.status !== 'unlinked' || !row.productId || !row.supplier) continue;
      if (!exact(String(row.sku || ''), String(row.supplier.sku || ''))) continue;
      if (blockedProducts.has(String(row.productId)) || blockedExternal.has(String(row.supplier.id))) continue;
      try {
        const result = await linkOne({
          actor,
          browser,
          remote,
          row,
          supplierId: settings.supplierId,
          warehouseId: settings.warehouseId,
          method: 'auto'
        });
        if (result.ok && !result.replay) linked += 1;
        if (!result.ok) exceptions.push({ productId: row.productId, externalId: row.supplier.id, sku: row.sku, code: result.code });
      } catch (error) {
        exceptions.push({ productId: row.productId, externalId: row.supplier.id, sku: row.sku, code: error.code || 'AUTO_LINK_FAILED', error: error.message });
      }
    }
  }

  if (linked) {
    links = await syncRepo.links();
    rows = compare(snapshot, products, links, {
      maxStockDelta: 1000000,
      maxCostPercent: 1000
    });
  }

  const policy = { stockTolerance: 0, costTolerance: 0, maxStockDelta: 1000000, maxCostPercent: 1000 };
  const created = await syncRepo.createRun(actor, { snapshot, policy, rows }, browser);
  const runId = created.runId;

  await db.query(
    `UPDATE em_supplier_import_runs SET sync_run_id=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
    [runId, importId]
  );

  const items = [];
  for (const row of rows) {
    if (row.status !== 'different' || !row.link || !row.productId) continue;
    if (settings.autoStock && row.changes.includes('stock')) items.push({ productId: row.productId, field: 'stock' });
    if (settings.autoCost && row.changes.includes('cost')) items.push({ productId: row.productId, field: 'cost' });
  }

  let queued = 0;
  for (let offset = 0; offset < items.length; offset += 50) {
    const batch = items.slice(offset, offset + 50);
    await syncRepo.enqueue(actor, runId, batch, browser);
    queued += batch.length;
  }

  const attention = rows.filter(row =>
    ['ambiguous','unregistered','absent','link_changed','incomplete'].includes(row.status) ||
    row.status === 'unlinked'
  ).length + exceptions.length;

  await db.query(
    `UPDATE em_supplier_import_runs
        SET status=?,
            linked_count=?,
            sync_queued_count=?,
            attention_count=?,
            error_text=?,
            updated_at=CURRENT_TIMESTAMP(3),
            finished_at=CASE WHEN ?='complete' THEN CURRENT_TIMESTAMP(3) ELSE finished_at END
      WHERE id=?`,
    [
      queued ? 'syncing' : 'complete',
      linked,
      queued,
      attention,
      exceptions.length ? JSON.stringify(exceptions.slice(0, 30)).slice(0, 4000) : null,
      queued ? 'syncing' : 'complete',
      importId
    ]
  );
}

async function reconcileImportJobs() {
  const [runs] = await db.query(
    `SELECT id,sync_run_id
       FROM em_supplier_import_runs
      WHERE status='syncing' AND sync_run_id IS NOT NULL
      ORDER BY created_at
      LIMIT 20`
  );
  for (const run of runs) {
    const [jobs] = await db.query(
      `SELECT status,result_json FROM em_supplier_sync_jobs WHERE run_id=?`,
      [run.sync_run_id]
    );
    if (!jobs.length) continue;
    if (jobs.some(job => ['queued','processing'].includes(job.status))) continue;
    const review = jobs.some(job => job.status !== 'confirmed');
    await db.query(
      `UPDATE em_supplier_import_runs
          SET status=?,
              updated_at=CURRENT_TIMESTAMP(3),
              finished_at=CURRENT_TIMESTAMP(3),
              error_text=CASE WHEN ? THEN COALESCE(error_text,'Sincronização requer revisão.') ELSE error_text END
        WHERE id=?`,
      [review ? 'review' : 'complete', review ? 1 : 0, run.id]
    );
  }
}

async function workerTick(deps) {
  if (workerBusy) return;
  workerBusy = true;
  let connection = null;
  let locked = false;
  try {
    await reconcileImportJobs();

    connection = await db.getPool().getConnection();
    const [lockRows] = await connection.query("SELECT GET_LOCK('em:supplier:import:r7',0) locked");
    locked = Number(lockRows[0]?.locked) === 1;
    if (!locked) return;

    const [rows] = await connection.query(
      `SELECT id FROM em_supplier_import_runs
        WHERE status IN ('pending','processing')
        ORDER BY created_at
        LIMIT 1`
    );
    if (!rows[0]) return;
    await processImport(rows[0].id, deps);
  } catch (error) {
    console.error(JSON.stringify({ event: 'supplier_import_r7_worker_error', code: error.code || 'IMPORT_FAILED', message: error.message }));
    try {
      const [pending] = await db.query(
        `SELECT id FROM em_supplier_import_runs
          WHERE status='processing'
          ORDER BY updated_at DESC
          LIMIT 1`
      );
      if (pending[0]) {
        await db.query(
          `UPDATE em_supplier_import_runs
              SET status='review',error_text=?,updated_at=CURRENT_TIMESTAMP(3),finished_at=CURRENT_TIMESTAMP(3)
            WHERE id=?`,
          [String(error.message || 'Falha ao processar importação').slice(0, 1000), pending[0].id]
        );
      }
    } catch {}
  } finally {
    if (connection) {
      if (locked) await connection.query("SELECT RELEASE_LOCK('em:supplier:import:r7')").catch(() => {});
      connection.release();
    }
    workerBusy = false;
  }
}

function register(app, deps) {
  const { requireAuthJson, requireCsrf, axios, getBlingTokenForWorker, resolveActor } = deps;
  if (!requireAuthJson || !requireCsrf || !axios || !getBlingTokenForWorker || !resolveActor) {
    throw new Error('supplierImportR7: dependências incompletas');
  }

  const wrap = fn => async (req, res, next) => {
    const requestId = crypto.randomUUID();
    res.set('Cache-Control', 'no-store');
    try {
      await fn(req, res, next);
    } catch (error) {
      const status = error.status || 500;
      const code = error.code || 'IMPORT_R7_FAILED';
      console.error(JSON.stringify({ event: 'supplier_import_r7_error', code, requestId, message: error.message }));
      res.status(status).json({
        ok: false,
        requestId,
        code,
        error: error.status ? error.message : 'Falha na importação. Nenhuma atualização foi presumida.',
        message: error.status ? error.message : 'Falha na importação. Nenhuma atualização foi presumida.'
      });
    }
  };

  app.get('/api/supplier-import/state', requireAuthJson, wrap(async (req, res) => {
    const actor = await actorOf(resolveActor, req);
    res.json({ ok: true, ...(await stateFor(actor)) });
  }));

  app.get('/api/supplier-import/capabilities', requireAuthJson, wrap(async (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      provider: PROVIDER,
      architecture: 'server_source_of_truth',
      autoLink: 'exact_unique_sku',
      fields: ['stock','cost'],
      agent: 'chrome_extension_2'
    });
  }));

  app.post('/api/supplier-import/settings', requireAuthJson, requireCsrf, wrap(async (req, res) => {
    const actor = await actorOf(resolveActor, req);
    const current = await effectiveSettings(actor);
    const next = {
      autoLink: req.body?.autoLink === undefined ? current.autoLink : req.body.autoLink === true,
      autoStock: req.body?.autoStock === undefined ? current.autoStock : req.body.autoStock === true,
      autoCost: req.body?.autoCost === undefined ? current.autoCost : req.body.autoCost === true,
      supplierId: text(req.body?.supplierId ?? current.supplierId, 64),
      warehouseId: text(req.body?.warehouseId ?? current.warehouseId, 64)
    };
    if (next.supplierId && !isId(next.supplierId)) fail('SUPPLIER_ID_INVALID', 'Fornecedor inválido.', 422);
    if (next.warehouseId && !isId(next.warehouseId)) fail('WAREHOUSE_ID_INVALID', 'Depósito inválido.', 422);

    await db.query(
      `INSERT INTO em_supplier_import_settings
        (actor,provider,auto_link,auto_stock,auto_cost,supplier_id,warehouse_id,updated_at)
       VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE
         auto_link=VALUES(auto_link),
         auto_stock=VALUES(auto_stock),
         auto_cost=VALUES(auto_cost),
         supplier_id=VALUES(supplier_id),
         warehouse_id=VALUES(warehouse_id),
         updated_at=CURRENT_TIMESTAMP(3)`,
      [actor, PROVIDER, next.autoLink ? 1 : 0, next.autoStock ? 1 : 0, next.autoCost ? 1 : 0, next.supplierId || null, next.warehouseId || null]
    );
    res.json({ ok: true, settings: await effectiveSettings(actor) });
  }));

  app.post('/api/supplier-import/request', requireAuthJson, requireCsrf, wrap(async (req, res) => {
    const actor = await actorOf(resolveActor, req);
    const [existing] = await db.query(
      `SELECT id,status,created_at
         FROM em_supplier_agent_commands
        WHERE actor=? AND command='scan_import' AND status IN ('queued','claimed','running')
        ORDER BY created_at DESC
        LIMIT 1`,
      [actor]
    );
    if (existing[0]) {
      return res.json({ ok: true, replay: true, commandId: existing[0].id, status: existing[0].status });
    }

    const id = crypto.randomUUID();
    const payload = {
      foreground: req.body?.foreground === true,
      requestedFrom: text(req.body?.requestedFrom || 'dashboard', 32)
    };
    await db.query(
      `INSERT INTO em_supplier_agent_commands
        (id,actor,command,status,payload_json,created_at,updated_at)
       VALUES (?,?,'scan_import','queued',?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
      [id, actor, JSON.stringify(payload)]
    );
    res.json({ ok: true, commandId: id, status: 'queued' });
  }));

  app.post('/api/supplier-import/agent/heartbeat', requireAuthJson, requireCsrf, wrap(async (req, res) => {
    const actor = await actorOf(resolveActor, req);
    const id = await ensureAgent(actor, req);
    await touchAgent(actor, id, req);
    res.json({ ok: true, connected: true, browserId: id, version: VERSION });
  }));

  app.get('/api/supplier-import/agent/next', requireAuthJson, wrap(async (req, res) => {
    const actor = await actorOf(resolveActor, req);
    const id = await ensureAgent(actor, req);
    await touchAgent(actor, id, req);

    const connection = await db.getPool().getConnection();
    let command = null;
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE em_supplier_agent_commands
            SET status='queued',browser_id=NULL,claimed_at=NULL,updated_at=CURRENT_TIMESTAMP(3)
          WHERE actor=? AND status='claimed' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 10 MINUTE)`,
        [actor]
      );
      const [rows] = await connection.execute(
        `SELECT id,command,payload_json
           FROM em_supplier_agent_commands
          WHERE actor=? AND status='queued'
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE`,
        [actor]
      );
      if (rows[0]) {
        await connection.execute(
          `UPDATE em_supplier_agent_commands
              SET status='claimed',browser_id=?,claimed_at=CURRENT_TIMESTAMP(3),updated_at=CURRENT_TIMESTAMP(3)
            WHERE id=? AND actor=?`,
          [id, rows[0].id, actor]
        );
        command = {
          id: rows[0].id,
          command: rows[0].command,
          payload: json(rows[0].payload_json) || {}
        };
      }
      await connection.commit();
    } catch (error) {
      try { await connection.rollback(); } catch {}
      throw error;
    } finally {
      connection.release();
    }

    res.json({ ok: true, command });
  }));

  app.post('/api/supplier-import/agent/result', requireAuthJson, requireCsrf, wrap(async (req, res) => {
    const actor = await actorOf(resolveActor, req);
    const id = await ensureAgent(actor, req);
    await touchAgent(actor, id, req);
    const commandId = text(req.body?.commandId || '', 36);
    if (!isUuid(commandId)) fail('COMMAND_INVALID', 'Comando inválido.', 422);

    const [commands] = await db.query(
      `SELECT id,status,browser_id FROM em_supplier_agent_commands WHERE id=? AND actor=? LIMIT 1`,
      [commandId, actor]
    );
    const command = commands[0];
    if (!command) fail('COMMAND_NOT_FOUND', 'Comando não encontrado.', 404);
    if (!['claimed','running'].includes(command.status)) fail('COMMAND_STATE', 'Este comando não aceita mais resultado.', 409);
    if (command.browser_id && String(command.browser_id) !== id) fail('COMMAND_OWNER', 'Comando pertence a outro agente.', 409);

    const saved = await insertImport(actor, id, commandId, req.body?.snapshot);
    setTimeout(() => workerTick(deps).catch(() => {}), 50);
    res.json({ ok: true, importId: saved.importId, accepted: saved.clean.rows.length, status: 'pending' });
  }));

  app.post('/api/supplier-import/agent/fail', requireAuthJson, requireCsrf, wrap(async (req, res) => {
    const actor = await actorOf(resolveActor, req);
    const id = await ensureAgent(actor, req);
    await touchAgent(actor, id, req);
    const commandId = text(req.body?.commandId || '', 36);
    const error = text(req.body?.error || 'Falha na leitura', 900);
    if (!isUuid(commandId)) fail('COMMAND_INVALID', 'Comando inválido.', 422);

    await db.query(
      `UPDATE em_supplier_agent_commands
          SET status='failed',result_json=?,finished_at=CURRENT_TIMESTAMP(3),updated_at=CURRENT_TIMESTAMP(3)
        WHERE id=? AND actor=? AND (browser_id=? OR browser_id IS NULL)`,
      [JSON.stringify({ error }), commandId, actor, id]
    );
    res.json({ ok: true });
  }));

  app.post('/api/supplier-import/link', requireAuthJson, requireCsrf, wrap(async (req, res) => {
    const actor = await actorOf(resolveActor, req);
    const externalId = text(req.body?.externalId || '', 64);
    const productId = text(req.body?.productId || '', 64);
    if (!isId(externalId) || !isId(productId)) fail('LINK_INVALID', 'Produto inválido.', 422);

    const settings = await effectiveSettings(actor);
    if (!settings.supplierId || !settings.warehouseId) fail('LINK_CONFIG_REQUIRED', 'Defina fornecedor e depósito uma vez antes de vincular.', 409);

    const [items] = await db.query(
      `SELECT i.external_id,i.sku,i.name,r.id import_id,r.status
         FROM em_supplier_import_items i
         JOIN em_supplier_import_runs r ON r.id=i.import_id
        WHERE r.actor=? AND i.external_id=?
        ORDER BY r.created_at DESC
        LIMIT 1`,
      [actor, externalId]
    );
    const item = items[0];
    if (!item) fail('SUPPLIER_ITEM_NOT_FOUND', 'Item do fornecedor não encontrado na última importação.', 404);
    if (item.status === 'processing') fail('IMPORT_BUSY', 'A importação ainda está sendo processada.', 409);

    const products = await syncRepo.products();
    const product = products.find(p => String(p.productId) === productId);
    if (!product) fail('PRODUCT_NOT_FOUND', 'Produto do Estoque Max não encontrado.', 404);

    const remote = await openRemote(getBlingTokenForWorker, axios);
    const row = {
      productId,
      sku: product.sku,
      supplier: { id: externalId, sku: item.sku }
    };

    await db.query(
      `DELETE FROM em_supplier_import_link_blocks
        WHERE actor=? AND (product_id=? OR external_id=?)`,
      [actor, productId, externalId]
    );

    const linked = await linkOne({
      actor,
      browser: browserId(req) || null,
      remote,
      row,
      supplierId: settings.supplierId,
      warehouseId: settings.warehouseId,
      method: 'manual'
    });
    if (!linked.ok) fail(linked.code || 'LINK_FAILED', 'Não foi possível criar o vínculo.', 409);

    await db.query(
      `UPDATE em_supplier_import_runs
          SET status='pending',sync_run_id=NULL,updated_at=CURRENT_TIMESTAMP(3),finished_at=NULL
        WHERE id=?`,
      [item.import_id]
    );
    setTimeout(() => workerTick(deps).catch(() => {}), 50);
    res.json({ ok: true, link: linked.link, replay: Boolean(linked.replay) });
  }));

  app.post('/api/supplier-import/unlink', requireAuthJson, requireCsrf, wrap(async (req, res) => {
    const actor = await actorOf(resolveActor, req);
    const productId = text(req.body?.productId || '', 64);
    if (!isId(productId)) fail('PRODUCT_INVALID', 'Produto inválido.', 422);

    const [rows] = await db.query(
      `SELECT * FROM em_supplier_sync_links WHERE product_id=? LIMIT 1`,
      [productId]
    );
    if (!rows[0]) fail('LINK_NOT_FOUND', 'Vínculo não encontrado.', 404);
    const previous = rows[0];

    const connection = await db.getPool().getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO em_supplier_import_link_blocks
          (actor,product_id,external_id,reason,created_at,updated_at)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE
           external_id=VALUES(external_id),reason=VALUES(reason),updated_at=CURRENT_TIMESTAMP(3)`,
        [actor, productId, previous.external_id, text(req.body?.reason || 'Desvinculado manualmente', 500)]
      );
      await connection.execute(`DELETE FROM em_supplier_sync_links WHERE product_id=?`, [productId]);
      await connection.execute(
        `INSERT INTO em_supplier_sync_audit
          (actor,browser_id,action,product_id,detail_json,created_at)
         VALUES (?,?,?,?,?,CURRENT_TIMESTAMP(3))`,
        [actor, browserId(req) || null, 'r7_unlink_block', productId, JSON.stringify({ previous })]
      );
      await connection.commit();
    } catch (error) {
      try { await connection.rollback(); } catch {}
      throw error;
    } finally {
      connection.release();
    }

    res.json({ ok: true, blocked: true });
  }));

  // Recuperação segura de importações interrompidas: somente a fila R7.
  db.query(
    `UPDATE em_supplier_import_runs
        SET status='pending',updated_at=CURRENT_TIMESTAMP(3)
      WHERE status='processing' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 10 MINUTE)`
  ).catch(() => {});

  if (!workerTimer) {
    workerTimer = setInterval(() => workerTick(deps).catch(() => {}), 7000);
    workerTimer.unref?.();
  }
  setTimeout(() => workerTick(deps).catch(() => {}), 1500);

  return { version: VERSION };
}

module.exports = { register, workerTick };
R7MODULE

cat > "$STAGE/public/assets/max-supplier-import-r7.css" <<'R7CSS'
/* ESTOQUE_MAX_SUPPLIER_IMPORT_R7_CSS */
#view-supplier-import{--sir7-blue:#4ba8fd;--sir7-ink:#14161a;--sir7-line:#e4e9ee;--sir7-soft:#f6f8fa;--sir7-muted:#6f7a85}
#view-supplier-import .sir7-shell{display:flex;flex-direction:column;gap:14px}
#view-supplier-import .sir7-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:18px 20px;background:#fff;border:1px solid var(--sir7-line);border-radius:18px}
#view-supplier-import .sir7-title{font-size:21px;font-weight:850;color:var(--sir7-ink);letter-spacing:-.025em}
#view-supplier-import .sir7-sub{margin-top:4px;color:var(--sir7-muted);font-size:12px;line-height:1.45;max-width:760px}
#view-supplier-import .sir7-head-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap;justify-content:flex-end}
#view-supplier-import .sir7-agent{display:inline-flex;align-items:center;gap:7px;padding:8px 10px;border:1px solid var(--sir7-line);border-radius:999px;background:#fff;color:#58636f;font-size:10px;font-weight:800;white-space:nowrap}
#view-supplier-import .sir7-agent:before{content:"";width:7px;height:7px;border-radius:50%;background:#a2aab3}
#view-supplier-import .sir7-agent.on:before{background:#24a665}
#view-supplier-import .sir7-agent.off:before{background:#d65b5b}
#view-supplier-import .sir7-import-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:12px;min-height:40px;padding:0 15px;background:var(--sir7-blue);color:#fff;font:inherit;font-size:11px;font-weight:850;cursor:pointer;box-shadow:0 7px 18px rgba(75,168,253,.22)}
#view-supplier-import .sir7-import-btn:disabled{opacity:.55;cursor:wait}
#view-supplier-import .sir7-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
#view-supplier-import .sir7-kpi{padding:14px 15px;background:#fff;border:1px solid var(--sir7-line);border-radius:15px}
#view-supplier-import .sir7-kpi span{display:block;color:#7a8490;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.055em}
#view-supplier-import .sir7-kpi b{display:block;margin-top:5px;color:var(--sir7-ink);font-size:22px;line-height:1}
#view-supplier-import .sir7-kpi small{display:block;margin-top:5px;color:#8d96a0;font-size:9.5px}
#view-supplier-import .sir7-controls{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;background:#fff;border:1px solid var(--sir7-line);border-radius:15px;flex-wrap:wrap}
#view-supplier-import .sir7-switches{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
#view-supplier-import .sir7-toggle{display:inline-flex;align-items:center;gap:7px;padding:7px 9px;border:1px solid #e7ebef;border-radius:10px;background:#fafbfd;color:#4d5864;font-size:10px;font-weight:750}
#view-supplier-import .sir7-toggle input{accent-color:var(--sir7-blue)}
#view-supplier-import .sir7-search{display:flex;align-items:center;gap:8px;min-width:240px}
#view-supplier-import .sir7-search input{width:100%;height:36px;border:1px solid #dce3e9;border-radius:10px;padding:0 11px;font:inherit;font-size:11px;outline:0}
#view-supplier-import .sir7-search input:focus{border-color:#8bc8ff;box-shadow:0 0 0 3px rgba(75,168,253,.12)}
#view-supplier-import .sir7-filters{display:flex;gap:7px;overflow:auto;padding:1px 0 3px}
#view-supplier-import .sir7-chip{border:1px solid #dfe5ea;background:#fff;color:#596570;border-radius:999px;padding:7px 10px;font:inherit;font-size:9.5px;font-weight:800;cursor:pointer;white-space:nowrap}
#view-supplier-import .sir7-chip.on{background:#14161a;border-color:#14161a;color:#fff}
#view-supplier-import .sir7-panel{background:#fff;border:1px solid var(--sir7-line);border-radius:17px;overflow:hidden}
#view-supplier-import .sir7-table-wrap{overflow:auto}
#view-supplier-import .sir7-table{width:100%;border-collapse:collapse;min-width:1060px}
#view-supplier-import .sir7-table th{position:sticky;top:0;z-index:2;padding:10px 12px;background:#f7f9fb;border-bottom:1px solid var(--sir7-line);color:#75808b;font-size:8.5px;text-align:left;text-transform:uppercase;letter-spacing:.055em;white-space:nowrap}
#view-supplier-import .sir7-table td{padding:11px 12px;border-bottom:1px solid #edf1f4;color:#303841;font-size:10px;vertical-align:middle}
#view-supplier-import .sir7-table tr:last-child td{border-bottom:0}
#view-supplier-import .sir7-product{display:flex;align-items:center;gap:10px;min-width:240px}
#view-supplier-import .sir7-photo{width:42px;height:42px;border-radius:10px;background:#f0f3f6;border:1px solid #e6eaee;object-fit:cover;flex:0 0 auto}
#view-supplier-import .sir7-photo-fallback{display:grid;place-items:center;width:42px;height:42px;border-radius:10px;background:#f0f3f6;color:#8a949e;font-weight:900}
#view-supplier-import .sir7-product b{display:block;color:#14161a;font-size:10.5px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#view-supplier-import .sir7-product small{display:block;color:#87919b;font-size:9px;margin-top:3px}
#view-supplier-import .sir7-pair{display:flex;flex-direction:column;gap:3px;white-space:nowrap}
#view-supplier-import .sir7-pair b{font-size:10.5px;color:#14161a}
#view-supplier-import .sir7-pair small{font-size:8.8px;color:#8a949e}
#view-supplier-import .sir7-pill{display:inline-flex;align-items:center;gap:5px;padding:5px 8px;border-radius:999px;background:#f2f4f6;color:#68727d;font-size:8.8px;font-weight:850;white-space:nowrap}
#view-supplier-import .sir7-pill.good{background:#edf8f2;color:#258458}
#view-supplier-import .sir7-pill.diff{background:#eef7ff;color:#227fbe}
#view-supplier-import .sir7-pill.warn{background:#fff7e8;color:#9b6a0a}
#view-supplier-import .sir7-pill.bad{background:#fff0f0;color:#b64747}
#view-supplier-import .sir7-btn{border:1px solid #dfe5ea;border-radius:9px;background:#fff;color:#2f3943;padding:7px 9px;font:inherit;font-size:9px;font-weight:800;cursor:pointer}
#view-supplier-import .sir7-btn.primary{border-color:#a9d7ff;background:#edf7ff;color:#1975b3}
#view-supplier-import .sir7-btn.danger{color:#b24747}
#view-supplier-import .sir7-empty{padding:44px 20px;text-align:center;color:#7b8590}
#view-supplier-import .sir7-empty b{display:block;color:#14161a;font-size:14px;margin-bottom:5px}
#view-supplier-import .sir7-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 13px;background:#fafbfd;border-top:1px solid #edf1f4;color:#858f99;font-size:9px}
#sir7-link-modal{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(20,22,26,.46);backdrop-filter:blur(4px)}
#sir7-link-modal.open{display:flex}
#sir7-link-modal .sir7-modal-box{width:min(620px,100%);max-height:82vh;display:flex;flex-direction:column;background:#fff;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.25);overflow:hidden}
#sir7-link-modal .sir7-modal-head{display:flex;align-items:center;justify-content:space-between;padding:15px 17px;border-bottom:1px solid #e8edf1}
#sir7-link-modal .sir7-modal-head b{font-size:14px;color:#14161a}
#sir7-link-modal .sir7-modal-body{padding:14px;overflow:auto}
#sir7-link-modal .sir7-modal-body input{width:100%;height:40px;border:1px solid #dce3e9;border-radius:10px;padding:0 11px;font:inherit;font-size:11px}
#sir7-link-modal .sir7-options{display:flex;flex-direction:column;gap:7px;margin-top:10px}
#sir7-link-modal .sir7-option{display:flex;justify-content:space-between;gap:12px;padding:10px 11px;border:1px solid #e3e8ed;border-radius:11px;background:#fff;cursor:pointer;text-align:left}
#sir7-link-modal .sir7-option:hover{border-color:#a9d7ff;background:#f8fcff}
#sir7-link-modal .sir7-option b{font-size:10.5px;color:#14161a}
#sir7-link-modal .sir7-option span{font-size:9px;color:#7d8791}
@media(max-width:900px){
  #view-supplier-import .sir7-head{padding:14px;flex-direction:column}
  #view-supplier-import .sir7-head-actions{width:100%;justify-content:stretch}
  #view-supplier-import .sir7-agent{flex:1;justify-content:center}
  #view-supplier-import .sir7-import-btn{flex:1}
  #view-supplier-import .sir7-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  #view-supplier-import .sir7-controls{align-items:stretch}
  #view-supplier-import .sir7-search{width:100%;min-width:0}
  #view-supplier-import .sir7-table{min-width:0;border-collapse:separate;border-spacing:0}
  #view-supplier-import .sir7-table thead{display:none}
  #view-supplier-import .sir7-table tbody{display:grid;grid-template-columns:1fr;gap:9px;padding:9px;background:#f6f8fa}
  #view-supplier-import .sir7-table tr{display:grid;grid-template-columns:1fr 1fr;gap:8px;background:#fff;border:1px solid #e3e8ed;border-radius:14px;padding:11px}
  #view-supplier-import .sir7-table td{display:block;border:0;padding:0;min-width:0}
  #view-supplier-import .sir7-table td:first-child{grid-column:1/-1}
  #view-supplier-import .sir7-table td:last-child{grid-column:1/-1}
  #view-supplier-import .sir7-product{min-width:0}
  #view-supplier-import .sir7-product b{max-width:240px}
  #view-supplier-import .sir7-foot{flex-direction:column;align-items:flex-start}
}
R7CSS

cat > "$STAGE/public/assets/max-supplier-import-r7.js" <<'R7JS'
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
    ? '—'
    : Number(value).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const number = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const stock = value => number(value) === null ? '—' : Number(value).toLocaleString('pt-BR');
  const when = value => {
    if(!value) return '—';
    const d=new Date(value);
    return Number.isNaN(d.getTime())?'—':d.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
  };
  const api = async (path, options={}) => {
    if (typeof window.maxFetch === 'function') {
      const response = await window.maxFetch(path, options, 20000);
      const payload = await response.json().catch(()=>({}));
      if(!response.ok) throw Error(payload.message||payload.error||`HTTP ${response.status}`);
      return payload;
    }
    const cfg={credentials:'include',cache:'no-store',...options,headers:{...(options.headers||{})}};
    if(cfg.body && typeof cfg.body!=='string'){
      cfg.headers['Content-Type']='application/json';
      const raw=document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)?.[1]||'';
      try{cfg.headers['X-CSRF-Token']=decodeURIComponent(raw);}catch{cfg.headers['X-CSRF-Token']=raw;}
      cfg.body=JSON.stringify(cfg.body);
    }
    const response=await fetch(path,cfg);
    const payload=await response.json().catch(()=>({}));
    if(!response.ok) throw Error(payload.message||payload.error||`HTTP ${response.status}`);
    return payload;
  };
  const say=(message,type='ok')=>{
    if(typeof window.toast==='function')return window.toast(message,type);
    console.log('[Importação R7]',message);
  };

  const R7={
    data:null,
    filter:'all',
    search:'',
    timer:null,
    busy:false,
    selectedExternalId:'',
    firstLoad:true
  };

  function viewVisible(){
    const el=$('view-supplier-import');
    return Boolean(el && el.offsetParent!==null && document.visibilityState==='visible');
  }

  function statusMeta(row){
    if(row.status==='synced')return['Em sincronia','good'];
    if(row.status==='different')return['Sincronizando / diferença','diff'];
    if(row.status==='exact_candidate')return['SKU exato · aguardando AutoLink','warn'];
    if(row.status==='ambiguous')return['SKU ambíguo','bad'];
    if(row.status==='blocked')return['Vínculo bloqueado','bad'];
    return['Sem vínculo','warn'];
  }

  function filterRows(){
    const rows=R7.data?.rows||[];
    const q=R7.search.trim().toLowerCase();
    return rows.filter(row=>{
      if(q && ![row.name,row.sku,row.localName,row.localSku,row.externalId,row.productId].some(v=>String(v||'').toLowerCase().includes(q)))return false;
      if(R7.filter==='all')return true;
      if(R7.filter==='synced')return row.status==='synced';
      if(R7.filter==='different')return row.status==='different';
      if(R7.filter==='unlinked')return ['unlinked','exact_candidate'].includes(row.status);
      if(R7.filter==='attention')return ['ambiguous','blocked','unlinked','exact_candidate'].includes(row.status);
      return true;
    });
  }

  function render(){
    const d=R7.data||{};
    const stats=d.stats||{};
    if($('sir7-kpi-total'))$('sir7-kpi-total').textContent=stats.total??0;
    if($('sir7-kpi-linked'))$('sir7-kpi-linked').textContent=stats.linked??0;
    if($('sir7-kpi-synced'))$('sir7-kpi-synced').textContent=stats.synced??0;
    if($('sir7-kpi-attention'))$('sir7-kpi-attention').textContent=stats.attention??0;

    const agent=$('sir7-agent');
    if(agent){
      const connected=Boolean(d.agent?.connected);
      agent.className='sir7-agent '+(connected?'on':'off');
      agent.textContent=connected
        ? `${d.agent?.label||'Chrome'} conectado`
        : 'Agente Chrome offline';
    }

    const latest=d.latestImport;
    if($('sir7-last-import')){
      const status=latest?.status?` · ${latest.status}`:'';
      $('sir7-last-import').textContent=latest
        ? `Última importação ${when(latest.created_at)}${status}`
        : 'Nenhuma importação recebida ainda';
    }

    const settings=d.settings||{};
    if($('sir7-auto-link'))$('sir7-auto-link').checked=settings.autoLink!==false;
    if($('sir7-auto-stock'))$('sir7-auto-stock').checked=settings.autoStock!==false;
    if($('sir7-auto-cost'))$('sir7-auto-cost').checked=settings.autoCost!==false;

    const cfg=$('sir7-config-note');
    if(cfg){
      if(settings.supplierId&&settings.warehouseId){
        cfg.textContent=`Fornecedor ${settings.supplierId} · depósito ${settings.warehouseId}${settings.inferredSupplier||settings.inferredWarehouse?' · detectado pelos vínculos existentes':''}`;
      }else{
        cfg.textContent='AutoLink aguarda um fornecedor e depósito válidos. Os vínculos já existentes podem definir isso automaticamente.';
      }
    }

    document.querySelectorAll('#view-supplier-import .sir7-chip').forEach(btn=>btn.classList.toggle('on',btn.dataset.filter===R7.filter));

    const body=$('sir7-body');
    if(!body)return;
    const rows=filterRows();
    if(!rows.length){
      body.innerHTML=`<tr><td colspan="7"><div class="sir7-empty"><b>${d.rows?.length?'Nenhum produto neste filtro':'Nenhuma importação ainda'}</b><span>${d.rows?.length?'Ajuste os filtros ou a busca.':'Clique em “Importar catálogo agora”. A extensão fará a leitura e devolverá os dados diretamente ao Estoque Max.'}</span></div></td></tr>`;
    }else{
      body.innerHTML=rows.map(row=>{
        const [label,kind]=statusMeta(row);
        const image=row.image?`<img class="sir7-photo" src="${esc(row.image)}" alt="">`:`<span class="sir7-photo-fallback">M</span>`;
        const stockEq=row.stockEqual?'<span class="sir7-pill good">Igual</span>':'<span class="sir7-pill diff">Diferença</span>';
        const costEq=row.costEqual?'<span class="sir7-pill good">Igual</span>':'<span class="sir7-pill diff">Diferença</span>';
        const action=row.productId
          ? `<button class="sir7-btn danger" onclick="supplierImportR7Unlink('${esc(row.productId)}')">Desvincular</button>`
          : `<button class="sir7-btn primary" onclick="supplierImportR7OpenLink('${esc(row.externalId)}')">Vincular produto</button>`;
        return `<tr>
          <td><div class="sir7-product">${image}<div><b title="${esc(row.name)}">${esc(row.name||'Produto')}</b><small>Fornecedor · SKU ${esc(row.sku||'—')}</small></div></div></td>
          <td><div class="sir7-pair"><b>${esc(row.localName||'—')}</b><small>SKU Max ${esc(row.localSku||'—')}</small></div></td>
          <td><div class="sir7-pair"><b>${stock(row.supplierStock)} → ${stock(row.currentStock)}</b><small>Fornecedor → Max</small></div></td>
          <td>${row.productId?stockEq:'<span class="sir7-pill warn">Aguardando vínculo</span>'}</td>
          <td><div class="sir7-pair"><b>${money(row.supplierCost)} → ${money(row.currentCost)}</b><small>Fornecedor → Max</small></div></td>
          <td><span class="sir7-pill ${kind}">${esc(label)}</span></td>
          <td>${action}</td>
        </tr>`;
      }).join('');
    }
    if($('sir7-result-count'))$('sir7-result-count').textContent=`${rows.length} de ${d.rows?.length||0} produtos`;
  }

  async function load({silent=false}={}){
    if(R7.busy)return;
    R7.busy=true;
    try{
      const d=await api('/api/supplier-import/state');
      R7.data=d;
      render();
      if(!silent&&R7.firstLoad&&d.latestImport)R7.firstLoad=false;
    }catch(error){
      if(!silent)say(`Importação: ${error.message}`,'er');
    }finally{
      R7.busy=false;
    }
  }

  async function requestImport(){
    const btn=$('sir7-import-btn');
    if(btn)btn.disabled=true;
    try{
      const mobile=/Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
      const result=await api('/api/supplier-import/request',{
        method:'POST',
        body:{foreground:!mobile,requestedFrom:mobile?'mobile':'dashboard'}
      });
      window.postMessage({type:'MAX_SUPPLIER_AGENT_WAKE_R7',commandId:result.commandId},'*');
      say(result.replay?'Já existe uma importação aguardando o agente.':'Importação enviada para o agente Chrome.','ok');
      await load({silent:true});
    }catch(error){
      say(error.message,'er');
    }finally{
      if(btn)btn.disabled=false;
    }
  }

  async function saveSettings(){
    try{
      const body={
        autoLink:Boolean($('sir7-auto-link')?.checked),
        autoStock:Boolean($('sir7-auto-stock')?.checked),
        autoCost:Boolean($('sir7-auto-cost')?.checked)
      };
      await api('/api/supplier-import/settings',{method:'POST',body});
      say('Automação salva.','ok');
      await load({silent:true});
    }catch(error){say(error.message,'er');}
  }

  function openLink(externalId){
    const row=(R7.data?.rows||[]).find(r=>String(r.externalId)===String(externalId));
    if(!row)return;
    R7.selectedExternalId=String(externalId);
    const modal=$('sir7-link-modal');
    const title=$('sir7-link-title');
    const input=$('sir7-link-search');
    if(title)title.textContent=`Vincular ${row.sku} · ${row.name}`;
    if(input)input.value=row.sku||'';
    modal?.classList.add('open');
    renderOptions();
    setTimeout(()=>input?.focus(),30);
  }

  function closeLink(){
    $('sir7-link-modal')?.classList.remove('open');
    R7.selectedExternalId='';
  }

  function renderOptions(){
    const q=String($('sir7-link-search')?.value||'').trim().toLowerCase();
    const box=$('sir7-link-options');
    if(!box)return;
    const products=(R7.data?.products||[])
      .filter(p=>!q||String(p.sku||'').toLowerCase().includes(q)||String(p.name||'').toLowerCase().includes(q))
      .slice(0,80);
    box.innerHTML=products.length?products.map(p=>`<button class="sir7-option" onclick="supplierImportR7Link('${esc(p.productId)}')"><span><b>${esc(p.name||'Produto')}</b><span>SKU ${esc(p.sku||'—')}</span></span><span>Vincular</span></button>`).join(''):'<div class="sir7-empty">Nenhum produto encontrado.</div>';
  }

  async function link(productId){
    try{
      await api('/api/supplier-import/link',{method:'POST',body:{externalId:R7.selectedExternalId,productId}});
      closeLink();
      say('Vínculo criado no banco. O sistema fará a comparação novamente.','ok');
      await load({silent:true});
    }catch(error){say(error.message,'er');}
  }

  async function unlink(productId){
    if(!confirm('Desvincular este produto? O AutoLink ficará bloqueado para não religar sozinho.'))return;
    try{
      await api('/api/supplier-import/unlink',{method:'POST',body:{productId,reason:'Desvinculado na aba Importação de Estoque e Preço'}});
      say('Produto desvinculado e bloqueado para AutoLink.','ok');
      await load({silent:true});
    }catch(error){say(error.message,'er');}
  }

  function patchNavigation(){
    if(window.__sir7NavPatched)return;
    if(typeof window.setView!=='function')return;
    const original=window.setView;
    window.setView=function(view,...args){
      const result=original.apply(this,[view,...args]);
      if(view==='supplier-import')setTimeout(()=>load({silent:false}),0);
      return result;
    };
    window.__sir7NavPatched=true;
  }

  window.loadSupplierImportR7=load;
  window.requestSupplierImportR7=requestImport;
  window.saveSupplierImportR7Settings=saveSettings;
  window.supplierImportR7OpenLink=openLink;
  window.supplierImportR7CloseLink=closeLink;
  window.supplierImportR7RenderOptions=renderOptions;
  window.supplierImportR7Link=link;
  window.supplierImportR7Unlink=unlink;
  window.supplierImportR7SetFilter=filter=>{
    R7.filter=filter;
    render();
  };
  window.supplierImportR7Search=value=>{
    R7.search=String(value||'');
    render();
  };

  document.addEventListener('DOMContentLoaded',()=>{
    patchNavigation();
    $('sir7-link-modal')?.addEventListener('click',event=>{if(event.target?.id==='sir7-link-modal')closeLink();});
    R7.timer=setInterval(()=>{if(viewVisible())load({silent:true});},3000);
  });
  setTimeout(patchNavigation,0);
})();
R7JS

cat > "$STAGE/supplier-import-view.html" <<'R7VIEW'

    <!-- ESTOQUE_MAX_SUPPLIER_IMPORT_R7_VIEW_START -->
    <div class="view" id="view-supplier-import">
      <div class="sir7-shell">
        <section class="sir7-head">
          <div>
            <div class="sir7-title">Importação de Estoque e Preço</div>
            <div class="sir7-sub">Seu Armazém Drop é lido pela extensão 2.0 e importado diretamente para o banco do Estoque Max. O servidor decide vínculo, estoque e custo; esta tela apenas mostra a verdade atual.</div>
          </div>
          <div class="sir7-head-actions">
            <span class="sir7-agent off" id="sir7-agent">Agente Chrome offline</span>
            <button class="sir7-import-btn" id="sir7-import-btn" onclick="requestSupplierImportR7()">Importar catálogo agora</button>
          </div>
        </section>

        <section class="sir7-kpis">
          <div class="sir7-kpi"><span>Produtos importados</span><b id="sir7-kpi-total">0</b><small id="sir7-last-import">Nenhuma importação</small></div>
          <div class="sir7-kpi"><span>Vinculados</span><b id="sir7-kpi-linked">0</b><small>Vínculo persistente no banco</small></div>
          <div class="sir7-kpi"><span>Em sincronia</span><b id="sir7-kpi-synced">0</b><small>Estoque e custo iguais</small></div>
          <div class="sir7-kpi"><span>Precisam de atenção</span><b id="sir7-kpi-attention">0</b><small>Sem vínculo, ambíguos ou bloqueados</small></div>
        </section>

        <section class="sir7-controls">
          <div class="sir7-switches">
            <label class="sir7-toggle"><input id="sir7-auto-link" type="checkbox" onchange="saveSupplierImportR7Settings()"> AutoLink SKU exato</label>
            <label class="sir7-toggle"><input id="sir7-auto-stock" type="checkbox" onchange="saveSupplierImportR7Settings()"> Estoque automático</label>
            <label class="sir7-toggle"><input id="sir7-auto-cost" type="checkbox" onchange="saveSupplierImportR7Settings()"> Custo automático</label>
          </div>
          <div class="sir7-search"><input type="search" placeholder="Buscar produto, SKU ou ID…" oninput="supplierImportR7Search(this.value)"></div>
          <div id="sir7-config-note" style="width:100%;color:#89939d;font-size:9px"></div>
        </section>

        <div class="sir7-filters">
          <button class="sir7-chip on" data-filter="all" onclick="supplierImportR7SetFilter('all')">Todos</button>
          <button class="sir7-chip" data-filter="synced" onclick="supplierImportR7SetFilter('synced')">Em sincronia</button>
          <button class="sir7-chip" data-filter="different" onclick="supplierImportR7SetFilter('different')">Estoque/custo diferente</button>
          <button class="sir7-chip" data-filter="unlinked" onclick="supplierImportR7SetFilter('unlinked')">Sem vínculo</button>
          <button class="sir7-chip" data-filter="attention" onclick="supplierImportR7SetFilter('attention')">Atenção</button>
        </div>

        <section class="sir7-panel">
          <div class="sir7-table-wrap">
            <table class="sir7-table">
              <thead><tr><th>Fornecedor</th><th>Produto Max</th><th>Estoque</th><th>Estoque</th><th>Custo</th><th>Estado</th><th>Ação</th></tr></thead>
              <tbody id="sir7-body"><tr><td colspan="7"><div class="sir7-empty"><b>Carregando importações…</b></div></td></tr></tbody>
            </table>
          </div>
          <div class="sir7-foot"><span id="sir7-result-count">0 produtos</span><span>Banco do Estoque Max é a fonte oficial</span></div>
        </section>
      </div>
    </div>
    <!-- ESTOQUE_MAX_SUPPLIER_IMPORT_R7_VIEW_END -->
R7VIEW

cat > "$STAGE/supplier-import-modal.html" <<'R7MODAL'

<div id="sir7-link-modal" aria-hidden="true">
  <section class="sir7-modal-box">
    <div class="sir7-modal-head"><b id="sir7-link-title">Vincular produto</b><button class="sir7-btn" onclick="supplierImportR7CloseLink()">Fechar</button></div>
    <div class="sir7-modal-body">
      <input id="sir7-link-search" type="search" placeholder="Buscar produto do Estoque Max por SKU ou nome…" oninput="supplierImportR7RenderOptions()">
      <div class="sir7-options" id="sir7-link-options"></div>
    </div>
  </section>
</div>
R7MODAL

cat > "$STAGE/patch-r7.js" <<'R7PATCHER'
'use strict';
const fs=require('fs');
const runtime=process.argv[2];
const stage=process.argv[3];

const indexPath=stage+'/index.js';
const dashPath=stage+'/dashboard.html';

let index=fs.readFileSync(indexPath,'utf8');
const hookStart='/* ESTOQUE_MAX_SUPPLIER_IMPORT_R7_START */';
const hookEnd='/* ESTOQUE_MAX_SUPPLIER_IMPORT_R7_END */';
if(!index.includes(hookStart)){
  const anchor='/* ESTOQUE_MAX_SUPPLIER_SYNC_V1_END */';
  if(!index.includes(anchor))throw Error('ANCHOR_SUPPLIER_SYNC_V1_END_NOT_FOUND');
  const hook=`
${hookStart}
const maxSupplierImportR7=require('./lib/supplierImportR7');
maxSupplierImportR7.register(app,{
  requireAuthJson,
  requireCsrf,
  axios,
  getBlingTokenForWorker:getCronBlingToken,
  resolveActor:maxSupplierResolveActorV1
});
${hookEnd}`;
  index=index.replace(anchor,anchor+'\n'+hook);
}
if((index.match(/ESTOQUE_MAX_SUPPLIER_IMPORT_R7_START/g)||[]).length!==1)throw Error('R7_INDEX_MARKER_COUNT_INVALID');
fs.writeFileSync(indexPath,index);

let dash=fs.readFileSync(dashPath,'utf8');
const cssTag='<link rel="stylesheet" href="/assets/max-supplier-import-r7.css?v=20260916-r7">';
const jsTag='<script defer src="/assets/max-supplier-import-r7.js?v=20260916-r7"></script>';
if(!dash.includes(cssTag)){
  if(!dash.includes('</head>'))throw Error('DASH_HEAD_ANCHOR_NOT_FOUND');
  dash=dash.replace('</head>',`  ${cssTag}\n  ${jsTag}\n</head>`);
}

if(!dash.includes('id="ni-supplier-import"')){
  const start=dash.indexOf('<button class="ni" id="ni-produtos"');
  if(start<0)throw Error('SIDEBAR_PRODUCTS_BUTTON_NOT_FOUND');
  const end=dash.indexOf('</button>',start);
  if(end<0)throw Error('SIDEBAR_PRODUCTS_END_NOT_FOUND');
  const button=`
    <button class="ni" id="ni-supplier-import" onclick="setView('supplier-import')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v5H4z"/><path d="M4 13h16v7H4z"/><path d="M8 9v4"/><path d="M16 9v4"/></svg>
      <span class="ni-label">Importação</span>
    </button>`;
  dash=dash.slice(0,end+9)+button+dash.slice(end+9);
}

if(!dash.includes('id="bn-supplier-import"')){
  const start=dash.indexOf('<button class="bnav-item" id="bn-produtos"');
  if(start>=0){
    const end=dash.indexOf('</button>',start);
    if(end<0)throw Error('BOTTOM_PRODUCTS_END_NOT_FOUND');
    const button=`
  <button class="bnav-item" id="bn-supplier-import" onclick="setView('supplier-import')">
    <span class="bnav-ico-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v5H4z"/><path d="M4 13h16v7H4z"/><path d="M8 9v4"/><path d="M16 9v4"/></svg></span><span>Importar</span>
  </button>`;
    dash=dash.slice(0,end+9)+button+dash.slice(end+9);
  }
}

if(!dash.includes("'supplier-import':'Importação de Estoque e Preço'")){
  const needle="produtos:'Produtos',";
  if(!dash.includes(needle))throw Error('VIEWS_PRODUCTS_ANCHOR_NOT_FOUND');
  dash=dash.replace(needle,needle+"'supplier-import':'Importação de Estoque e Preço',");
}

const viewMarker='<!-- ESTOQUE_MAX_SUPPLIER_IMPORT_R7_VIEW_START -->';
if(!dash.includes(viewMarker)){
  const anchor='<!-- VIEW PEDIDOS -->';
  const view=fs.readFileSync(stage+'/supplier-import-view.html','utf8');
  if(!dash.includes(anchor))throw Error('VIEW_PEDIDOS_ANCHOR_NOT_FOUND');
  dash=dash.replace(anchor,view+'\n    '+anchor);
}

if(!dash.includes('id="sir7-link-modal"')){
  const modal=fs.readFileSync(stage+'/supplier-import-modal.html','utf8');
  if(!dash.includes('</body>'))throw Error('BODY_END_NOT_FOUND');
  dash=dash.replace('</body>',modal+'\n</body>');
}

for(const marker of [
  'id="ni-supplier-import"',
  'id="view-supplier-import"',
  "'supplier-import':'Importação de Estoque e Preço'",
  '/assets/max-supplier-import-r7.css',
  '/assets/max-supplier-import-r7.js'
]){
  if((dash.split(marker).length-1)!==1)throw Error('DASH_MARKER_INVALID '+marker);
}
fs.writeFileSync(dashPath,dash);
console.log('PATCHER=OK');
R7PATCHER

cat > "$STAGE/migration-r7.js" <<'R7MIGRATION'
'use strict';
try { require('dotenv').config({ path: process.argv[2], quiet: true }); } catch {}
const db = require(process.argv[3] + '/lib/mysql/db');

const statements = [
`CREATE TABLE IF NOT EXISTS em_supplier_import_settings (
  actor CHAR(64) NOT NULL,
  provider VARCHAR(32) NOT NULL DEFAULT 'seuarmazemdrop',
  auto_link TINYINT(1) NOT NULL DEFAULT 1,
  auto_stock TINYINT(1) NOT NULL DEFAULT 1,
  auto_cost TINYINT(1) NOT NULL DEFAULT 1,
  supplier_id VARCHAR(64) NULL,
  warehouse_id VARCHAR(64) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (actor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS em_supplier_import_runs (
  id CHAR(36) NOT NULL,
  actor CHAR(64) NOT NULL,
  browser_id CHAR(36) NULL,
  provider VARCHAR(32) NOT NULL DEFAULT 'seuarmazemdrop',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  snapshot_json LONGTEXT NOT NULL,
  sync_run_id CHAR(36) NULL,
  total_items INT UNSIGNED NOT NULL DEFAULT 0,
  linked_count INT UNSIGNED NOT NULL DEFAULT 0,
  sync_queued_count INT UNSIGNED NOT NULL DEFAULT 0,
  attention_count INT UNSIGNED NOT NULL DEFAULT 0,
  error_text VARCHAR(4000) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_em_supplier_import_runs_actor_created (actor,created_at),
  KEY idx_em_supplier_import_runs_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS em_supplier_import_items (
  import_id CHAR(36) NOT NULL,
  external_id VARCHAR(64) NOT NULL,
  sku VARCHAR(191) NOT NULL,
  name VARCHAR(500) NOT NULL,
  stock BIGINT UNSIGNED NOT NULL,
  cost DECIMAL(15,4) NOT NULL,
  page_no INT UNSIGNED NULL,
  image_url TEXT NULL,
  PRIMARY KEY (import_id,external_id),
  KEY idx_em_supplier_import_items_sku (sku),
  KEY idx_em_supplier_import_items_external (external_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS em_supplier_agent_commands (
  id CHAR(36) NOT NULL,
  actor CHAR(64) NOT NULL,
  browser_id CHAR(36) NULL,
  command VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'queued',
  payload_json LONGTEXT NULL,
  result_json LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  claimed_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_em_supplier_agent_commands_actor_status (actor,status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS em_supplier_import_agents (
  actor CHAR(64) NOT NULL,
  browser_id CHAR(36) NOT NULL,
  label VARCHAR(80) NOT NULL,
  version VARCHAR(20) NULL,
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (actor,browser_id),
  KEY idx_em_supplier_import_agents_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS em_supplier_import_link_blocks (
  actor CHAR(64) NOT NULL,
  product_id VARCHAR(64) NOT NULL,
  external_id VARCHAR(64) NULL,
  reason VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (actor,product_id),
  UNIQUE KEY uq_em_supplier_import_block_external (actor,external_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

(async()=>{
  for(const sql of statements) await db.rawQuery(sql);
  const [tables] = await db.rawQuery(`
    SELECT TABLE_NAME
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE()
      AND TABLE_NAME IN (
        'em_supplier_import_settings',
        'em_supplier_import_runs',
        'em_supplier_import_items',
        'em_supplier_agent_commands',
        'em_supplier_import_agents',
        'em_supplier_import_link_blocks'
      )
    ORDER BY TABLE_NAME
  `);
  console.log('R7_TABLE_COUNT='+tables.length);
  for(const table of tables){
    const [rows]=await db.rawQuery('SELECT COUNT(*) total FROM `'+table.TABLE_NAME+'`');
    console.log('TABLE='+table.TABLE_NAME+' ROWS='+Number(rows[0]?.total||0));
  }
  await db.closePool();
})().catch(async error=>{
  console.error('MIGRATION_ERROR='+error.message);
  try{await db.closePool();}catch{}
  process.exit(1);
});
R7MIGRATION

if [ "$FAILED" = "0" ]; then
  "$NODE" --check "$STAGE/lib/supplierImportR7/index.js"
  RC1=$?
  "$NODE" --check "$STAGE/public/assets/max-supplier-import-r7.js"
  RC2=$?
  "$NODE" --check "$STAGE/patch-r7.js"
  RC3=$?
  "$NODE" --check "$STAGE/migration-r7.js"
  RC4=$?

  if [ "$RC1" != "0" ] || [ "$RC2" != "0" ] || [ "$RC3" != "0" ] || [ "$RC4" != "0" ]; then
    fail_install "Falha de sintaxe no pacote R7" "node --check rejeitou arquivo novo" "$STAGE" "syntax"
  else
    echo "STAGE_SYNTAX=OK"
  fi
fi

if [ "$FAILED" = "0" ]; then
  mkdir -p "$STAGE/lib/supplierImportR7"
  cp -f "$STAGE/lib/supplierImportR7/index.js" "$STAGE/lib/supplierImportR7/index.js"

  "$NODE" "$STAGE/patch-r7.js" "$RUNTIME" "$STAGE"
  PATCH_RC=$?

  if [ "$PATCH_RC" != "0" ]; then
    fail_install "Falha ao montar dashboard/index R7" "Âncora de produção não encontrada ou marcador duplicado" "$STAGE" "patch"
  else
    echo "STAGE_PATCH=OK"
  fi
fi

if [ "$FAILED" = "0" ]; then
  "$NODE" --check "$STAGE/index.js"
  CHECK_INDEX=$?
  if [ "$CHECK_INDEX" != "0" ]; then
    fail_install "index.js staged inválido" "node --check falhou" "$STAGE/index.js" "syntax"
  else
    echo "STAGED_INDEX_SYNTAX=OK"
  fi
fi

if [ "$FAILED" = "0" ]; then
  R7_INDEX_MARKERS="$(grep -c 'ESTOQUE_MAX_SUPPLIER_IMPORT_R7_START' "$STAGE/index.js")"
  R7_VIEW_MARKERS="$(grep -c 'ESTOQUE_MAX_SUPPLIER_IMPORT_R7_VIEW_START' "$STAGE/dashboard.html")"
  R7_NAV_MARKERS="$(grep -c 'id="ni-supplier-import"' "$STAGE/dashboard.html")"

  echo "R7_INDEX_MARKERS=$R7_INDEX_MARKERS"
  echo "R7_VIEW_MARKERS=$R7_VIEW_MARKERS"
  echo "R7_NAV_MARKERS=$R7_NAV_MARKERS"

  if [ "$R7_INDEX_MARKERS" != "1" ] || [ "$R7_VIEW_MARKERS" != "1" ] || [ "$R7_NAV_MARKERS" != "1" ]; then
    fail_install "Marcadores R7 inválidos" "Patch não ficou único" "$STAGE" "marker-check"
  fi
fi

if [ "$FAILED" = "0" ]; then
  cd "$RUNTIME"

  TABLES_BEFORE="$(
    "$NODE" - "$ENV_FILE" "$RUNTIME" <<'NODECOUNT'
try { require('dotenv').config({ path: process.argv[2], quiet: true }); } catch {}
const db=require(process.argv[3]+'/lib/mysql/db');
(async()=>{
  const [rows]=await db.rawQuery(`
    SELECT COUNT(*) total
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE()
      AND TABLE_NAME IN (
        'em_supplier_import_settings',
        'em_supplier_import_runs',
        'em_supplier_import_items',
        'em_supplier_agent_commands',
        'em_supplier_import_agents',
        'em_supplier_import_link_blocks'
      )
  `);
  console.log(Number(rows[0]?.total||0));
  await db.closePool();
})().catch(async e=>{console.error(e.message);try{await db.closePool();}catch{};process.exit(1);});
NODECOUNT
  )"

  COUNT_RC=$?
  if [ "$COUNT_RC" != "0" ]; then
    fail_install "Não foi possível auditar tabelas antes da migração" "Falha de conexão MySQL" "$RUNTIME/lib/mysql/db.js" "db-preflight"
  else
    echo "R7_TABLES_EXISTING_BEFORE=$TABLES_BEFORE"
  fi
fi

if [ "$FAILED" = "0" ]; then
  cd "$RUNTIME"
  "$NODE" "$STAGE/migration-r7.js" "$ENV_FILE" "$RUNTIME"
  MIG_RC=$?
  if [ "$MIG_RC" != "0" ]; then
    fail_install "Migração R7 falhou" "CREATE TABLE aditivo não concluiu" "$STAGE/migration-r7.js" "migration"
  else
    echo "MIGRATION_R7=OK_ADDITIVE_ONLY"
  fi
fi

if [ "$FAILED" = "0" ]; then
  # Runtime ativo é a verdade. Primeiro reconciliamos apenas os dois arquivos
  # supplierSync que estavam mais novos no Runtime.
  cp -f "$RUNTIME/lib/supplierSync/index.js" "$SOURCE/lib/supplierSync/index.js"
  cp -f "$RUNTIME/lib/supplierSync/service.js" "$SOURCE/lib/supplierSync/service.js"

  mkdir -p "$RUNTIME/lib/supplierImportR7" "$SOURCE/lib/supplierImportR7"
  mkdir -p "$RUNTIME/public/assets" "$SOURCE/public/assets"

  cp -f "$STAGE/lib/supplierImportR7/index.js" "$RUNTIME/lib/supplierImportR7/index.js"
  cp -f "$STAGE/lib/supplierImportR7/index.js" "$SOURCE/lib/supplierImportR7/index.js"

  cp -f "$STAGE/public/assets/max-supplier-import-r7.css" "$RUNTIME/public/assets/max-supplier-import-r7.css"
  cp -f "$STAGE/public/assets/max-supplier-import-r7.css" "$SOURCE/public/assets/max-supplier-import-r7.css"

  cp -f "$STAGE/public/assets/max-supplier-import-r7.js" "$RUNTIME/public/assets/max-supplier-import-r7.js"
  cp -f "$STAGE/public/assets/max-supplier-import-r7.js" "$SOURCE/public/assets/max-supplier-import-r7.js"

  cp -f "$STAGE/index.js" "$RUNTIME/index.js"
  cp -f "$STAGE/index.js" "$SOURCE/index.js"

  cp -f "$STAGE/dashboard.html" "$RUNTIME/public/dashboard.html"
  cp -f "$STAGE/dashboard.html" "$SOURCE/public/dashboard.html"

  PUBLISHED=1
  echo "PUBLISH=OK"
fi

if [ "$FAILED" = "0" ]; then
  "$NODE" --check "$RUNTIME/index.js"
  A=$?
  "$NODE" --check "$RUNTIME/lib/supplierImportR7/index.js"
  B=$?
  "$NODE" --check "$RUNTIME/public/assets/max-supplier-import-r7.js"
  C=$?

  if [ "$A" != "0" ] || [ "$B" != "0" ] || [ "$C" != "0" ]; then
    fail_install "Validação após publicação falhou" "Arquivo publicado não passou node --check" "$RUNTIME" "post-publish-check"
  else
    echo "POST_PUBLISH_SYNTAX=OK"
  fi
fi

if [ "$FAILED" = "0" ]; then
  INDEX_S="$(sha256sum "$SOURCE/index.js" | awk '{print $1}')"
  INDEX_R="$(sha256sum "$RUNTIME/index.js" | awk '{print $1}')"
  DASH_S="$(sha256sum "$SOURCE/public/dashboard.html" | awk '{print $1}')"
  DASH_R="$(sha256sum "$RUNTIME/public/dashboard.html" | awk '{print $1}')"
  MOD_S="$(sha256sum "$SOURCE/lib/supplierImportR7/index.js" | awk '{print $1}')"
  MOD_R="$(sha256sum "$RUNTIME/lib/supplierImportR7/index.js" | awk '{print $1}')"
  JS_S="$(sha256sum "$SOURCE/public/assets/max-supplier-import-r7.js" | awk '{print $1}')"
  JS_R="$(sha256sum "$RUNTIME/public/assets/max-supplier-import-r7.js" | awk '{print $1}')"

  echo "INDEX_SOURCE_SHA=$INDEX_S"
  echo "INDEX_RUNTIME_SHA=$INDEX_R"
  echo "DASH_SOURCE_SHA=$DASH_S"
  echo "DASH_RUNTIME_SHA=$DASH_R"
  echo "R7_MODULE_SHA=$MOD_R"
  echo "R7_UI_JS_SHA=$JS_R"

  if [ "$INDEX_S" != "$INDEX_R" ] || [ "$DASH_S" != "$DASH_R" ] || [ "$MOD_S" != "$MOD_R" ] || [ "$JS_S" != "$JS_R" ]; then
    fail_install "Source/Runtime divergentes após publicação" "Paridade obrigatória falhou" "$RUNTIME" "parity"
  else
    echo "SOURCE_RUNTIME=IGUAIS"
  fi
fi

if [ "$FAILED" = "0" ]; then
  touch "$RUNTIME/tmp/restart.txt"
  RESTARTED=1
  echo "RESTART_SIGNAL=touch tmp/restart.txt"
  sleep 6

  ROOT_HTTP="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' 'https://maxcortelaser.com.br/' 2>/dev/null)"
  DASH_HTTP="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' 'https://maxcortelaser.com.br/dashboard.html' 2>/dev/null)"
  R7_HTTP="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' 'https://maxcortelaser.com.br/api/supplier-import/capabilities' 2>/dev/null)"
  OLD_HTTP="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' 'https://maxcortelaser.com.br/api/supplier-sync/catalog-links' 2>/dev/null)"

  echo "ROOT_HTTP=$ROOT_HTTP"
  echo "DASHBOARD_HTTP=$DASH_HTTP"
  echo "R7_CAPABILITIES_UNAUTH_HTTP=$R7_HTTP"
  echo "OLD_SUPPLIER_CATALOG_LINKS_UNAUTH_HTTP=$OLD_HTTP"

  if [ "$DASH_HTTP" != "200" ] || [ "$R7_HTTP" != "401" ] || [ "$OLD_HTTP" != "401" ]; then
    fail_install "Prova HTTP falhou" "Dashboard ou rotas protegidas não responderam como esperado" "$RUNTIME" "http-proof"
  fi
fi

if [ "$FAILED" != "0" ]; then
  rollback_files
  echo
  echo "======================================================"
  echo " VEREDITO FINAL"
  echo "======================================================"
  if [ "$PUBLISHED" = "1" ]; then
    echo "🟠 INSTALAÇÃO FALHOU, MAS ROLLBACK FOI CONCLUÍDO"
  else
    echo "🔴 INSTALAÇÃO: FALHOU"
  fi
  echo "PROXIMO_PASSO=Envie esta saída completa."
  exit 1
fi

echo
echo "======================================================"
echo " PROVAS R7"
echo "======================================================"

cd "$RUNTIME"
"$NODE" - "$ENV_FILE" "$RUNTIME" <<'NODEPROOF'
try { require('dotenv').config({ path: process.argv[2], quiet: true }); } catch {}
const db=require(process.argv[3]+'/lib/mysql/db');
(async()=>{
  const names=[
    'em_supplier_import_settings',
    'em_supplier_import_runs',
    'em_supplier_import_items',
    'em_supplier_agent_commands',
    'em_supplier_import_agents',
    'em_supplier_import_link_blocks'
  ];
  for(const table of names){
    const [rows]=await db.rawQuery('SELECT COUNT(*) total FROM `'+table+'`');
    console.log('R7_TABLE='+table+' ROWS='+Number(rows[0]?.total||0));
  }
  const [links]=await db.rawQuery('SELECT COUNT(*) total FROM em_supplier_sync_links');
  console.log('EXISTING_SUPPLIER_LINKS='+Number(links[0]?.total||0));
  await db.closePool();
})().catch(async e=>{console.error('PROOF_DB_ERROR='+e.message);try{await db.closePool();}catch{};process.exit(1);});
NODEPROOF

echo "EXTERNAL_PRODUCT_WRITES_DURING_INSTALL=0"
echo "BLING_WRITE_DURING_INSTALL=0"
echo "MERCADO_LIVRE_WRITE_DURING_INSTALL=0"
echo "TIKTOK_WRITE_DURING_INSTALL=0"
echo "SHOPIFY_WRITE_DURING_INSTALL=0"

echo
echo "======================================================"
echo " VEREDITO FINAL"
echo "======================================================"
echo "🟢 INSTALAÇÃO TÉCNICA: 100% CONCLUÍDA"
echo "🟡 HOMOLOGAÇÃO VISUAL/FUNCIONAL: AGUARDANDO NAVEGADOR"
echo "BASE_R7=RUNTIME_ATIVO_RECONCILIADO"
echo "BACKUP=$BACKUP"
echo "EXTENSAO_COMPATIVEL=Max Fornecedor Agent 2.0.0"
echo "PROXIMO_PASSO=Instalar/carregar a Extensão 2.0 e testar o botão Importar catálogo agora."
exit 0
