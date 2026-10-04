const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const sql=fs.readFileSync(path.join(__dirname,'..','src','migrations','107_payment_account_archive_audit.sql'),'utf8');

test('archive audit records actor and Won to non-Won stage change',()=>{
 assert.match(sql,/NEW\.changed_by/);
 assert.match(sql,/NEW\.old_status = 'won' AND NEW\.new_status <> 'won'/);
 assert.match(sql,/'payment_account\.archived'/);
 assert.match(sql,/'fromStatus'/);
 assert.match(sql,/'toStatus'/);
 assert.match(sql,/'leadId'/);
 assert.match(sql,/a\.archived_at IS NOT NULL/);
});

test('reactivation audit records non-Won to Won stage change',()=>{
 assert.match(sql,/NEW\.old_status <> 'won' AND NEW\.new_status = 'won'/);
 assert.match(sql,/'payment_account\.reactivated'/);
 assert.match(sql,/'state', 'reactivated'/);
 assert.match(sql,/a\.archived_at IS NULL/);
 assert.match(sql,/a\.voided_at IS NULL/);
});

test('audit is driven by canonical lead status history for all status writers',()=>{
 assert.match(sql,/AFTER INSERT ON lead_status_history/);
 assert.match(sql,/FOR EACH ROW/);
 assert.match(sql,/entity_type,entity_id,metadata/);
});
