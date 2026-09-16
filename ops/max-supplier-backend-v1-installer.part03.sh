    Number.isFinite(Number(fields.estoque))
  ){
    clean.estoque=Number(fields.estoque);
  }

  if(
    fields?.precoCusto !== undefined &&
    fields?.precoCusto !== null &&
    Number.isFinite(Number(fields.precoCusto))
  ){
    clean.precoCusto=Number(fields.precoCusto);
  }

  if(
    clean.estoque === undefined &&
    clean.precoCusto === undefined
  ){
    throw new Error('Nenhum campo confirmado para persistir no Estoque Max.');
  }

  await estoqueMaxPersistConfirmedMaster(
    productId,
    clean,
    {
      success:true,
      verified:true,
      ...clean
    }
  );

  if(clean.estoque !== undefined){
    const local=await localProductsRepo.getByBlingId(String(productId));

    if(!local?.id || !local?.sku){
      const error=new Error('Produto confirmado no Bling, mas não localizado no catálogo local para espelhamento.');
      error.code='LOCAL_PRODUCT_NOT_FOUND';
      error.status=502;
      throw error;
    }

    await localInventoryRepo.upsertInventory({
      productId:local.id,
      sku:local.sku,
      warehouseId:'bling_virtual_total',
      quantityOnHand:clean.estoque,
      quantityReserved:0,
      quantityAvailable:clean.estoque,
      sourceProvider:'bling',
      syncStatus:'synced'
    });
  }

  return {success:true,verified:true,...clean};
}

async function maxSupplierReadLocalV1(productId,field){
  const saved=await getProductOverridePersistent(productId) || {};
  const key=field==='stock' ? 'estoque' : 'precoCusto';
  const raw=saved[key];

  if(raw === undefined || raw === null || raw === ''){
    return {value:null};
  }

  const value=Number(raw);
  return {value:Number.isFinite(value) ? value : null};
}

const maxSupplierSyncV1=require('./lib/supplierSync');

maxSupplierSyncV1.register(app,{
  requireAuthJson,
  requireCsrf,
  ensureBlingToken,
  axios,
  persistOverride:maxSupplierPersistLocalV1,
  readMaxField:maxSupplierReadLocalV1,
  resolveActor:maxSupplierResolveActorV1,
  getBlingTokenForWorker:getCronBlingToken
});

/* ESTOQUE_MAX_SUPPLIER_SYNC_V1_END */

`;
src=src.replace(marker,block+marker);
fs.writeFileSync(file,src);
console.log('INDEX_HOOK_INSERTED=SIM');
NODE

"$NODE" --check "$TMP/index.js" >/dev/null || fail "Index temporário inválido" "node --check falhou" "$TMP/index.js"

"$NODE" - "$INDEX_S" "$TMP/index.js" <<'NODE'
const fs=require('fs');
const before=fs.readFileSync(process.argv[2],'utf8');
const after=fs.readFileSync(process.argv[3],'utf8');
const start='/* ESTOQUE_MAX_SUPPLIER_SYNC_V1_START */';
const end='/* ESTOQUE_MAX_SUPPLIER_SYNC_V1_END */';
const s=after.indexOf(start), e=after.indexOf(end);
if(s<0||e<s) throw new Error('SUPPLIER_BLOCK_NOT_FOUND');
const prefix=after.slice(0,s);
const suffix=after.slice(e+end.length).replace(/^\n\n?/,'');
if(prefix+suffix!==before) throw new Error('INDEX_CHANGED_OUTSIDE_SUPPLIER_BLOCK');
console.log('INDEX_ONLY_SUPPLIER_BLOCK_CHANGED=SIM');
NODE

cd "$SOURCE"
MIGRATION_STARTED=1
"$NODE" - "$ENV_FILE" "$TMP/pkg/lib/supplierSync/migration.sql" <<'NODE'
const fs=require('fs');
try{require('dotenv').config({path:process.argv[2],quiet:true});}catch(_error){}
const db=require('./lib/mysql/db');
(async()=>{
  const [existing]=await db.query(`
    SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'em_supplier_sync_%'
  `);
  if(existing.length) throw new Error('SUPPLIER_TABLES_ALREADY_EXIST');

  const sql=fs.readFileSync(process.argv[3],'utf8');
  const statements=sql.split(';').map(s=>s.trim()).filter(s=>s && !s.split('\n').every(line=>!line.trim()||line.trim().startsWith('--'));
  for(const statement of statements) await db.query(statement);

  const [created]=await db.query(`
    SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'em_supplier_sync_%'
    ORDER BY TABLE_NAME
  `);
  const names=created.map(r=>r.TABLE_NAME);
  const expected=['em_supplier_sync_audit','em_supplier_sync_clients','em_supplier_sync_jobs','em_supplier_sync_links','em_supplier_sync_ops','em_supplier_sync_runs'];
