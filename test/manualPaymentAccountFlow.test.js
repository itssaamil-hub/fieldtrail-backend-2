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

test('won leads do not appear as payment accounts before explicit creation',()=>{
  const collections=read('src/utils/collections.js');
  assert.doesNotMatch(collections,/UNION ALL SELECT 'lead:'/);
  assert.doesNotMatch(collections,/FROM leads l WHERE l\.status='won'/);
  assert.match(collections,/const source=`SELECT .* FROM collection_accounts a LEFT JOIN leads l ON l\.id=a\.lead_id`;/s);
});

test('payment account creation is explicit, accepted-only and retry-safe',()=>{
  const routes=read('src/routes/collections.routes.js');
  const lifecycle=read('src/routes/collectionLifecycle.routes.js');
  const collections=read('src/utils/collections.js');
  const migration=read('src/migrations/042_payment_collections.sql');

  assert.match(routes,/router\.post\('\/from-quotation\/:id'.*C\.convert/s);
  assert.match(lifecycle,/router\.post\('\/from-quotation\/:id'/);
  assert.match(lifecycle,/voided and cannot create or reopen a payment account/);
  assert.match(collections,/if\(!r\|\|r\.status!=='accepted'\)throw bad\('Accept the current quotation revision first\.'/);
  assert.match(collections,/SELECT id FROM collection_accounts WHERE quote_id=\$1/);
  assert.match(collections,/if\(old\)return \{key:old\.id,existing:true\}/);
  assert.match(migration,/quote_id UUID UNIQUE REFERENCES quotations\(id\)/);
});

test('manual conversion preserves the existing payment workflow contract',()=>{
  const collections=read('src/utils/collections.js');
  const routes=read('src/routes/collections.routes.js');

  assert.match(collections,/Existing payments exceed this quotation total/);
  assert.match(collections,/UPDATE collection_accounts SET quote_id=/);
  assert.match(collections,/INSERT INTO collection_accounts\(lead_id,quote_id,owner_id/);
  assert.match(routes,/router\.post\('\/:key\/payments'/);
  assert.match(routes,/router\.get\('\/:key\/payments\/:id\/receipt'/);
});
