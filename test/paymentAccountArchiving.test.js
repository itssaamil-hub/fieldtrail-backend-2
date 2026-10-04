const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('real payment accounts archive when a Won deal leaves Won and reactivate on Won',()=>{
  const migration=read('src/migrations/106_payment_account_archiving.sql');
  assert.match(migration,/ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/);
  assert.match(migration,/IF OLD\.status = 'won' AND NEW\.status <> 'won'/);
  assert.match(migration,/SET archived_at = COALESCE\(archived_at, now\(\)\)/);
  assert.match(migration,/archive_reason = 'Deal moved from Won to ' \|\| NEW\.status/);
  assert.match(migration,/ELSIF NEW\.status = 'won'/);
  assert.match(migration,/SET archived_at = NULL,[\s\S]*archive_reason = NULL/);
  assert.match(migration,/WHERE lead_id = NEW\.id[\s\S]*voided_at IS NULL/);
  assert.match(migration,/AFTER UPDATE OF status ON leads/);
});

test('archived accounts are separate from active payment states and totals',()=>{
  const lifecycle=read('src/routes/collectionLifecycle.routes.js');
  assert.match(lifecycle,/['"]archived['"]/);
  assert.match(lifecycle,/c\.voided_at IS NULL/);
  assert.match(lifecycle,/\$7='archived' AND archived_at IS NOT NULL/);
  assert.match(lifecycle,/\$7='all' AND archived_at IS NULL/);
  assert.match(lifecycle,/\$7='pending' AND archived_at IS NULL/);
  assert.match(lifecycle,/sum\(collected\) FILTER\(WHERE archived_at IS NULL\)/);
  assert.match(lifecycle,/FROM totals WHERE archived_at IS NULL GROUP BY/);
});

test('archived accounts are read-only and manual voiding is retired',()=>{
  const lifecycle=read('src/routes/collectionLifecycle.routes.js');
  assert.match(lifecycle,/if\(row\?\.archived_at\)throw bad\('This payment account is archived because the deal is no longer Won/);
  assert.match(lifecycle,/router\.put\('\/:key\/due-date',guardActive\)/);
  assert.match(lifecycle,/router\.post\('\/:key\/payments',guardActive\)/);
  assert.match(lifecycle,/router\.patch\('\/:key\/payments\/:id',guardActive\)/);
  assert.match(lifecycle,/router\.delete\('\/:key\/payments\/:id',guardActive\)/);
  assert.doesNotMatch(lifecycle,/router\.post\('\/:key\/void'/);
});
