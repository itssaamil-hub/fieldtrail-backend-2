const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('accepted quotation cannot be voided while recorded payments still exist',()=>{
 const src=read('src/routes/quotationLifecycle.routes.js');
 assert.match(src,/SELECT EXISTS\([\s\S]*FROM lead_payments p[\s\S]*p\.account_id=\$1[\s\S]*p\.lead_id=\$2[\s\S]*\) AS found/);
 assert.match(src,/if\(activePayment\)throw bad\('Delete all recorded payments before voiding this quotation\.',409\)/);
});

test('deleted payment audit history does not itself block quotation void',()=>{
 const src=read('src/routes/quotationLifecycle.routes.js');
 const voidBlock=src.slice(src.indexOf('async function voidQuotation'),src.indexOf("router.post('/:id/void'"));
 assert.doesNotMatch(voidBlock,/payment\.deleted/);
 assert.match(voidBlock,/UPDATE quotations SET cancelled_at=now\(\)/);
 assert.match(voidBlock,/UPDATE collection_accounts SET voided_at=now\(\)/);
});