const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('quotation API exposes one authoritative lifecycle state with manual void disabled',()=>{
 const src=read('src/routes/quotationLifecycle.routes.js');
 assert.match(src,/effectiveStatus:q\.cancelled_at\?'voided':current\.status/);
 assert.match(src,/canVoid:false/);
 assert.doesNotMatch(src,/router\.post\('\/:id\/void'/);
 assert.doesNotMatch(src,/router\.post\('\/:id\/cancel-deal'/);
 assert.match(src,/canDelete:deletion\.canDelete/);
 assert.match(src,/financialActivity:financial\.financialActivity/);
 assert.match(src,/CASE WHEN q\.cancelled_at IS NOT NULL THEN 'voided'::text ELSE r\.status END AS status/);
 assert.match(src,/\$2='voided' AND q\.cancelled_at IS NOT NULL/);
 assert.match(src,/\$2<>'voided' AND q\.cancelled_at IS NULL AND r\.status=\$2/);
});

test('admin can delete any quotation while payment account and financial history are preserved',()=>{
 const src=read('src/routes/quotationLifecycle.routes.js');
 assert.match(src,/if\(user\.role==='admin'\)return \{canDelete:true/);
 assert.match(src,/if\(req\.user\.role!=='admin'\)/);
 assert.match(src,/financialActivityPreserved:financialActivity/);
 assert.match(src,/preservedPaymentAccount:!!accountId/);
 assert.match(src,/INSERT INTO quotation_deletion_audit/);
 assert.doesNotMatch(src,/DELETE FROM collection_accounts/);
 assert.match(src,/DELETE FROM quotations/);
});

test('accepted admin deletion still requires a reason',()=>{
 const src=read('src/routes/quotationLifecycle.routes.js');
 assert.match(src,/preview\.status==='accepted'&&reason\.length<5/);
 assert.match(src,/r\.status==='accepted'&&finalReason\.length<5/);
});

test('lifecycle GET does not steal quotation settings customers or alerts routes',()=>{
 const src=read('src/routes/quotationLifecycle.routes.js');
 assert.match(src,/router\.get\('\/:id',async\(req,res,next\)=>\{\s*if\(!UUID\.test\(req\.params\.id\)\)return next\(\);/s);
});