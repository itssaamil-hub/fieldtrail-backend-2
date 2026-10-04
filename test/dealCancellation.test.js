const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('deal cancellation preserves financial history and locks future writes',()=>{
  const migration=read('src/migrations/104_deal_cancellation_and_void_accounts.sql');
  const collection=read('src/routes/collectionLifecycle.routes.js');
  const quotation=read('src/routes/quotationLifecycle.routes.js');
  const app=read('src/app.js');

  for(const field of ['voided_at','void_reason','voided_by','cancelled_at','cancel_reason','cancelled_by']){
    assert.match(migration,new RegExp(`\\b${field}\\b`));
  }
  assert.match(collection,/payment_account\.voided/);
  assert.match(collection,/router\.put\('\/:key\/due-date',guardActive\)/);
  assert.match(collection,/router\.post\('\/:key\/payments',guardActive\)/);
  assert.match(collection,/router\.patch\('\/:key\/payments\/:id',guardActive\)/);
  assert.match(collection,/router\.delete\('\/:key\/payments\/:id',guardActive\)/);
  assert.doesNotMatch(collection,/DELETE FROM lead_payments/);
  assert.doesNotMatch(collection,/DELETE FROM collection_accounts/);

  assert.match(quotation,/status==='accepted'/);
  assert.match(quotation,/deal_cancelled/);
  assert.match(quotation,/deal\.cancelled/);
  assert.match(quotation,/router\.post\('\/:id\/revise'/);
  assert.match(quotation,/router\.post\('\/:id\/action'/);
  assert.match(quotation,/router\.get\('\/:id\/summary'/);
  assert.doesNotMatch(quotation,/DELETE FROM quotations/);

  const lifecycleCollections=app.indexOf('collectionLifecycle.routes');
  const legacyCollections=app.indexOf('collections.routes');
  const lifecycleQuotes=app.indexOf('quotationLifecycle.routes');
  const legacyQuotes=app.indexOf('quotations.routes');
  assert.ok(lifecycleCollections>=0&&lifecycleCollections<legacyCollections,'collection lifecycle guard must run before legacy collection routes');
  assert.ok(lifecycleQuotes>=0&&lifecycleQuotes<legacyQuotes,'quotation lifecycle guard must run before legacy quotation routes');
});
