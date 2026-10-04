const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('manual void mutations are retired while historical guards remain safe',()=>{
  const migration=read('src/migrations/104_deal_cancellation_and_void_accounts.sql');
  const collection=read('src/routes/collectionLifecycle.routes.js');
  const quotation=read('src/routes/quotationLifecycle.routes.js');
  const app=read('src/app.js');

  for(const field of ['voided_at','void_reason','voided_by','cancelled_at','cancel_reason','cancelled_by']){
    assert.match(migration,new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(collection,/router\.post\('\/:key\/void'/);
  assert.doesNotMatch(collection,/payment_account\.voided/);
  assert.match(collection,/c\.voided_at IS NULL/);
  assert.match(collection,/router\.put\('\/:key\/due-date',guardActive\)/);
  assert.match(collection,/router\.post\('\/:key\/payments',guardActive\)/);
  assert.match(collection,/router\.patch\('\/:key\/payments\/:id',guardActive\)/);
  assert.match(collection,/router\.delete\('\/:key\/payments\/:id',guardActive\)/);
  assert.doesNotMatch(collection,/DELETE FROM lead_payments/);

  assert.match(quotation,/canVoid:false/);
  assert.doesNotMatch(quotation,/router\.post\('\/:id\/void'/);
  assert.doesNotMatch(quotation,/router\.post\('\/:id\/cancel-deal'/);
  assert.match(quotation,/router\.post\('\/:id\/revise'/);
  assert.match(quotation,/router\.post\('\/:id\/action'/);
  assert.match(quotation,/router\.get\('\/:id\/summary'/);

  const lifecycleCollections=app.indexOf('collectionLifecycle.routes');
  const legacyCollections=app.indexOf('collections.routes');
  const lifecycleQuotes=app.indexOf('quotationLifecycle.routes');
  const legacyQuotes=app.indexOf('quotations.routes');
  assert.ok(lifecycleCollections>=0&&lifecycleCollections<legacyCollections,'collection lifecycle guard must run before legacy collection routes');
  assert.ok(lifecycleQuotes>=0&&lifecycleQuotes<legacyQuotes,'quotation lifecycle guard must run before legacy quotation routes');
});

test('admin quotation deletion is audited and preserves financial records',()=>{
  const deletionMigration=read('src/migrations/105_quotation_deletion_audit.sql');
  const paymentMigration=read('src/migrations/042_payment_collections.sql');
  const quotation=read('src/routes/quotationLifecycle.routes.js');
  assert.match(deletionMigration,/CREATE TABLE IF NOT EXISTS quotation_deletion_audit/);
  assert.match(deletionMigration,/financial_activity_found/);
  assert.match(paymentMigration,/quote_id UUID UNIQUE REFERENCES quotations\(id\) ON DELETE SET NULL/);
  assert.match(quotation,/if\(user\.role==='admin'\)return \{canDelete:true/);
  assert.match(quotation,/Enter a deletion reason of at least 5 characters/);
  assert.match(quotation,/FROM lead_payments/);
  assert.match(quotation,/payment\.recorded/);
  assert.match(quotation,/payment\.corrected/);
  assert.match(quotation,/payment\.deleted/);
  assert.match(quotation,/const financialActivity=!!\(directPayment\|\|auditedPayment\|\|account\?\.voided_at\)/);
  assert.match(quotation,/INSERT INTO quotation_deletion_audit/);
  assert.doesNotMatch(quotation,/DELETE FROM collection_accounts/);
  assert.match(quotation,/DELETE FROM quotations/);
  assert.match(quotation,/preservedPaymentAccount:!!accountId/);
});
