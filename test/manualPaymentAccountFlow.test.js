const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('accepting a quotation never creates a payment account implicitly',()=>{
  const staffActions=read('src/routes/quotations.routes.js');
  const publicActions=read('src/routes/publicQuotation.routes.js');

  for(const src of [staffActions,publicActions]){
    assert.doesNotMatch(src,/INSERT\s+INTO\s+collection_accounts/i);
    assert.doesNotMatch(src,/\bC\.convert\s*\(/);
  }
  assert.match(staffActions,/status=b\.action/);
  assert.match(publicActions,/SET status=\$3,version=version\+1/);
});

test('payment account lifecycle is Deal-driven and quotation conversion is retired',()=>{
  const lifecycle=read('src/routes/collectionLifecycle.routes.js');
  const canonical=read('src/migrations/111_canonical_deal_payment_accounts.sql');

  assert.match(lifecycle,/router\.post\('\/from-quotation\/:id'/);
  assert.match(lifecycle,/Quotation-to-payment conversion has been retired/);
  assert.doesNotMatch(lifecycle,/router\.post\('\/:key\/void'/);

  assert.match(canonical,/IF NEW\.status = 'won'/);
  assert.match(canonical,/INSERT INTO collection_accounts/);
  assert.match(canonical,/ON CONFLICT \(lead_id\) DO UPDATE/);
  assert.match(canonical,/archived_at = NULL/);
  assert.match(canonical,/OLD\.status = 'won' AND NEW\.status <> 'won'/);
  assert.match(canonical,/quote_id = NULL/);
  assert.match(canonical,/quote_number = NULL/);
  assert.match(canonical,/quote_revision = NULL/);
});

test('Deal payment workflow keeps payment and receipt endpoints intact',()=>{
  const routes=read('src/routes/collections.routes.js');
  const lifecycle=read('src/routes/collectionLifecycle.routes.js');

  assert.match(routes,/router\.post\('\/:key\/payments'/);
  assert.match(routes,/router\.get\('\/:key\/payments\/:id\/receipt'/);
  assert.match(lifecycle,/Move the Deal to Won before recording payment/);
  assert.match(lifecycle,/This payment account is archived because the deal is no longer Won/);
});
