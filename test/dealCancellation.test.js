const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('quotation void preserves financial history and locks future writes',()=>{
  const migration=read('src/migrations/104_deal_cancellation_and_void_accounts.sql');
  const collection=read('src/routes/collectionLifecycle.routes.js');
  const quotation=read('src/routes/quotationLifecycle.routes.js');
  const app=read('src/app.js');

  for(const field of ['voided_at','void_reason','voided_by','cancelled_at','cancel_reason','cancelled_by']){
    assert.match(migration,new RegExp(`\\b${field}\\b`));
  }
  assert.match(collection,/payment_account\.voided/);
  assert.match(collection,/quotation_voided/);
  assert.match(collection,/quotation\.voided/);
  assert.match(collection,/quotation_public_links/);
  assert.match(collection,/\$7='all' AND voided_at IS NULL/);
  assert.match(collection,/router\.put\('\/:key\/due-date',guardActive\)/);
  assert.match(collection,/router\.post\('\/:key\/payments',guardActive\)/);
  assert.match(collection,/router\.patch\('\/:key\/payments\/:id',guardActive\)/);
  assert.match(collection,/router\.delete\('\/:key\/payments\/:id',guardActive\)/);
  assert.doesNotMatch(collection,/DELETE FROM lead_payments/);

  assert.match(quotation,/quotation_voided/);
  assert.match(quotation,/quotation\.voided/);
  assert.match(quotation,/quotation_public_links/);
  assert.match(quotation,/router\.post\('\/:id\/void',voidQuotation\)/);
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

test('accepted quotation deletion is allowed only before any financial activity and is audited',()=>{
  const deletionMigration=read('src/migrations/105_quotation_deletion_audit.sql');
  const quotation=read('src/routes/quotationLifecycle.routes.js');
  assert.match(deletionMigration,/CREATE TABLE IF NOT EXISTS quotation_deletion_audit/);
  assert.match(deletionMigration,/financial_activity_found/);
  assert.match(quotation,/Only Admin can delete an accepted quotation/);
  assert.match(quotation,/Enter a deletion reason of at least 5 characters/);
  assert.match(quotation,/FROM lead_payments/);
  assert.match(quotation,/payment\.recorded/);
  assert.match(quotation,/payment\.corrected/);
  assert.match(quotation,/payment\.deleted/);
  assert.match(quotation,/Financial activity exists for this accepted quotation/);
  assert.match(quotation,/Voided quotations are permanent audit records and cannot be deleted/);
  assert.match(quotation,/INSERT INTO quotation_deletion_audit/);
  assert.match(quotation,/DELETE FROM collection_accounts/);
  assert.match(quotation,/DELETE FROM quotations/);
});
