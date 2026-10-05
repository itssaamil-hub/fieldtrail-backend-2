const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const route=fs.readFileSync(require.resolve('../src/routes/dealPurge.routes'),'utf8');
const migration=fs.readFileSync(require.resolve('../src/migrations/110_atomic_deal_purge.sql'),'utf8');
const app=fs.readFileSync(require.resolve('../src/app'),'utf8');

test('permanent Deal purge is admin-only, atomic and payment-scoped',()=>{
 assert.match(route,/requireRole\('admin'\)/);
 assert.match(route,/BEGIN/);
 assert.match(route,/FOR UPDATE/);
 assert.match(route,/payment_request_ledger/);
 assert.match(route,/DELETE FROM lead_payments/);
 assert.match(route,/DELETE FROM collection_accounts/);
 assert.match(route,/DELETE FROM leads/);
 assert.match(route,/ROLLBACK/);
 assert.match(route,/COMMIT/);
 assert.doesNotMatch(route,/DELETE FROM quotations/);
 assert.doesNotMatch(route,/UPDATE quotations/);
});

test('payment lifecycle guard bypass is transaction-local and delete-only',()=>{
 assert.match(migration,/TG_OP = 'DELETE'/);
 assert.match(migration,/current_setting\('app\.deal_purge', true\) = 'on'/);
 assert.match(route,/set_config\('app\.deal_purge','on',true\)/);
});

test('atomic Deal purge route overrides legacy admin delete path',()=>{
 const purge=app.indexOf('dealPurge.routes');
 const legacy=app.indexOf('app.use("/admin", adminRoutes)');
 assert.ok(purge>=0&&legacy>=0&&purge<legacy);
});
