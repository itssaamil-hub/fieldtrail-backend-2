const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('legacy voided Won account is reactivated in place and payment history survives',async()=>{
 const db=new PGlite();
 await db.exec(`
  CREATE TABLE leads(id uuid PRIMARY KEY,status text NOT NULL,business_name text NOT NULL,salesman_id uuid,contact_name text,phone text,deal_value numeric);
  CREATE TABLE collection_accounts(
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lead_id uuid UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
   owner_id uuid,customer jsonb NOT NULL DEFAULT '{}'::jsonb,snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,total numeric NOT NULL,currency text NOT NULL,
   version integer NOT NULL DEFAULT 1,archived_at timestamptz,archive_reason text,voided_at timestamptz,voided_by uuid,void_reason text
  );
  CREATE TABLE lead_payments(id uuid PRIMARY KEY,lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,account_id uuid REFERENCES collection_accounts(id) ON DELETE CASCADE,amount numeric NOT NULL);
 `);
 const lead='11111111-1111-4111-8111-111111111111';
 const account='22222222-2222-4222-8222-222222222222';
 const payment='33333333-3333-4333-8333-333333333333';
 await db.query("INSERT INTO leads(id,status,business_name,deal_value) VALUES($1,'won','Legacy Cafe',10000)",[lead]);
 await db.query("INSERT INTO collection_accounts(id,lead_id,total,currency,voided_at,void_reason) VALUES($1,$2,10000,'INR',now(),'legacy void')",[account,lead]);
 await db.query('INSERT INTO lead_payments(id,lead_id,account_id,amount) VALUES($1,$2,$3,2000)',[payment,lead,account]);
 await db.exec(read('src/migrations/112_normalize_legacy_voided_won_accounts.sql'));
 const row=(await db.query('SELECT * FROM collection_accounts WHERE id=$1',[account])).rows[0];
 assert.equal(row.voided_at,null);
 assert.equal(row.voided_by,null);
 assert.equal(row.void_reason,null);
 assert.equal(row.archived_at,null);
 assert.equal((await db.query('SELECT count(*)::int n FROM collection_accounts WHERE lead_id=$1',[lead])).rows[0].n,1);
 assert.equal((await db.query('SELECT amount FROM lead_payments WHERE id=$1',[payment])).rows[0].amount,'2000');
 await db.query("UPDATE leads SET status='lost' WHERE id=$1",[lead]);
 assert.ok((await db.query('SELECT archived_at FROM collection_accounts WHERE id=$1',[account])).rows[0].archived_at);
 await db.query("UPDATE leads SET status='won' WHERE id=$1",[lead]);
 const active=(await db.query('SELECT * FROM collection_accounts WHERE id=$1',[account])).rows[0];
 assert.equal(active.id,account);
 assert.equal(active.archived_at,null);
 assert.equal(active.voided_at,null);
 assert.equal((await db.query('SELECT amount FROM lead_payments WHERE id=$1',[payment])).rows[0].amount,'2000');
 await db.close();
});
