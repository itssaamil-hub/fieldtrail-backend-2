const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('manual quotation void routes are permanently retired',()=>{
 const src=read('src/routes/quotationLifecycle.routes.js');
 assert.doesNotMatch(src,/async function voidQuotation/);
 assert.doesNotMatch(src,/router\.post\('\/:id\/void'/);
 assert.doesNotMatch(src,/router\.post\('\/:id\/cancel-deal'/);
 assert.doesNotMatch(src,/Delete all recorded payments before voiding this quotation/);
 assert.match(src,/canVoid:false/);
});

test('financial activity is retained in audit and does not delete payment records',()=>{
 const src=read('src/routes/quotationLifecycle.routes.js');
 assert.match(src,/SELECT EXISTS\([\s\S]*FROM lead_payments p[\s\S]*p\.account_id=\$1[\s\S]*p\.lead_id=\$2[\s\S]*\) AS found/);
 assert.match(src,/action IN \('payment\.recorded','payment\.corrected','payment\.deleted'\)/);
 assert.match(src,/const financialActivity=!!\(directPayment\|\|auditedPayment\|\|account\?\.voided_at\)/);
 assert.match(src,/financial_activity_found/);
 assert.doesNotMatch(src,/Financial activity exists for this accepted quotation/);
 assert.doesNotMatch(src,/DELETE FROM collection_accounts/);
 assert.match(src,/INSERT INTO quotation_deletion_audit/);
});