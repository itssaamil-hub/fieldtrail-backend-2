const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('quotation API exposes one authoritative lifecycle state',()=>{
 const src=read('src/routes/quotationLifecycle.routes.js');
 assert.match(src,/effectiveStatus:q\.cancelled_at\?'voided':current\.status/);
 assert.match(src,/canVoid:req\.user\.role==='admin'&&!q\.cancelled_at&&current\.status==='accepted'/);
 assert.match(src,/canDelete:deletion\.canDelete/);
 assert.match(src,/financialActivity:financial\.financialActivity/);
 assert.match(src,/paymentAccountVoided/);
 assert.match(src,/CASE WHEN q\.cancelled_at IS NOT NULL THEN 'voided'::text ELSE r\.status END AS status/);
 assert.match(src,/\$2='voided' AND q\.cancelled_at IS NOT NULL/);
 assert.match(src,/\$2<>'voided' AND q\.cancelled_at IS NULL AND r\.status=\$2/);
});

test('accepted deletion remains impossible after any financial activity or void',()=>{
 const src=read('src/routes/quotationLifecycle.routes.js');
 assert.match(src,/Voided quotations are permanent audit records and cannot be deleted/);
 assert.match(src,/payment\.recorded/);
 assert.match(src,/payment\.corrected/);
 assert.match(src,/payment\.deleted/);
 assert.match(src,/Financial activity exists for this accepted quotation/);
 assert.match(src,/INSERT INTO quotation_deletion_audit/);
 assert.match(src,/DELETE FROM collection_accounts/);
 assert.match(src,/DELETE FROM quotations/);
});