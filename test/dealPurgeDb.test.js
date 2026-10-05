const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');

const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const DEAL='11111111-1111-4111-8111-111111111111';
const ACCOUNT='22222222-2222-4222-8222-222222222222';
const PAYMENT='33333333-3333-4333-8333-333333333333';
const REQUEST='44444444-4444-4444-8444-444444444444';
const USER='55555555-5555-4555-8555-555555555555';
const QUOTE='66666666-6666-4666-8666-666666666666';

async function setup(){
 const db=new PGlite();
 await db.exec(`
  CREATE TABLE users(id uuid PRIMARY KEY);
  CREATE TABLE leads(id uuid PRIMARY KEY,status text NOT NULL,business_name text NOT NULL);
  CREATE TABLE quotations(id uuid PRIMARY KEY,lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE collection_accounts(
   id uuid PRIMARY KEY,
   lead_id uuid UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
   archived_at timestamptz,
   voided_at timestamptz
  );
  CREATE TABLE lead_payments(
   id uuid PRIMARY KEY,
   lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
   account_id uuid REFERENCES collection_accounts(id) ON DELETE CASCADE,
   request_id uuid,
   recorded_by uuid REFERENCES users(id),
   paid_at timestamptz NOT NULL DEFAULT now(),
   amount numeric NOT NULL,
   note text,
   method text NOT NULL DEFAULT 'unspecified',
   reference text NOT NULL DEFAULT ''
  );
  CREATE TABLE payment_request_ledger(
   recorded_by uuid NOT NULL REFERENCES users(id),
   request_id uuid NOT NULL,
   account_id uuid REFERENCES collection_accounts(id) ON DELETE SET NULL,
   lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
   payment_id uuid REFERENCES lead_payments(id) ON DELETE SET NULL,
   amount numeric NOT NULL,
   payment_date date NOT NULL,
   method text NOT NULL,
   reference text NOT NULL DEFAULT '',
   note text NOT NULL DEFAULT '',
   deleted_at timestamptz,
   created_at timestamptz NOT NULL DEFAULT now(),
   PRIMARY KEY(recorded_by,request_id)
  );
  CREATE TABLE activity_logs(
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid REFERENCES users(id),action text NOT NULL,
   entity_type text,entity_id uuid,metadata jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now()
  );
 `);
 await db.exec(read('src/migrations/108_payment_write_integrity.sql'));
 await db.exec(read('src/migrations/110_atomic_deal_purge.sql'));
 await db.query('INSERT INTO users(id) VALUES($1)',[USER]);
 await db.query("INSERT INTO leads(id,status,business_name) VALUES($1,'won','Delete Me')",[DEAL]);
 await db.query('INSERT INTO quotations(id,lead_id) VALUES($1,$2)',[QUOTE,DEAL]);
 await db.query('INSERT INTO collection_accounts(id,lead_id) VALUES($1,$2)',[ACCOUNT,DEAL]);
 await db.query(`INSERT INTO lead_payments(id,lead_id,account_id,request_id,recorded_by,amount,method)
  VALUES($1,$2,$3,$4,$5,100,'cash')`,[PAYMENT,DEAL,ACCOUNT,REQUEST,USER]);
 await db.query(`INSERT INTO payment_request_ledger(recorded_by,request_id,account_id,lead_id,payment_id,amount,payment_date,method)
  VALUES($1,$2,$3,$4,$5,100,'2026-10-05','cash')`,[USER,REQUEST,ACCOUNT,DEAL,PAYMENT]);
 return db;
}

async function purge(db,{failAfterPayments=false}={}){
 await db.exec('BEGIN');
 try{
  const existing=(await db.query('SELECT id,business_name,status FROM leads WHERE id=$1 FOR UPDATE',[DEAL])).rows[0];
  assert.ok(existing);
  const accounts=(await db.query('SELECT id FROM collection_accounts WHERE lead_id=$1 FOR UPDATE',[DEAL])).rows.map(r=>r.id);
  const accountIds=accounts.length?accounts:null;
  await db.query("SELECT set_config('app.deal_purge','on',true)");
  await db.query(`DELETE FROM payment_request_ledger
   WHERE lead_id=$1 OR ($2::uuid[] IS NOT NULL AND account_id=ANY($2::uuid[])) OR payment_id IN (
    SELECT id FROM lead_payments WHERE lead_id=$1 OR ($2::uuid[] IS NOT NULL AND account_id=ANY($2::uuid[]))
   )`,[DEAL,accountIds]);
  await db.query(`DELETE FROM lead_payments WHERE lead_id=$1 OR ($2::uuid[] IS NOT NULL AND account_id=ANY($2::uuid[]))`,[DEAL,accountIds]);
  if(failAfterPayments) throw new Error('forced failure');
  await db.query('DELETE FROM collection_accounts WHERE lead_id=$1',[DEAL]);
  await db.query('DELETE FROM leads WHERE id=$1',[DEAL]);
  await db.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
   VALUES($1,'lead.permanently_deleted','lead',$2,$3::jsonb)`,[USER,DEAL,JSON.stringify({businessName:existing.business_name})]);
  await db.exec('COMMIT');
 }catch(e){await db.exec('ROLLBACK');throw e;}
}

test('real DB purge deletes Deal payment graph while quotation survives',async()=>{
 const db=await setup();
 await purge(db);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM leads WHERE id=$1',[DEAL])).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM collection_accounts WHERE id=$1',[ACCOUNT])).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM lead_payments WHERE id=$1',[PAYMENT])).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_request_ledger WHERE request_id=$1',[REQUEST])).rows[0].n,0);
 const q=(await db.query('SELECT id,lead_id FROM quotations WHERE id=$1',[QUOTE])).rows[0];
 assert.equal(q.id,QUOTE);
 assert.equal(q.lead_id,null);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM activity_logs WHERE action='lead.permanently_deleted' AND entity_id=$1",[DEAL])).rows[0].n,1);
 await db.close();
});

test('real DB purge rolls back all payment deletions on failure',async()=>{
 const db=await setup();
 await assert.rejects(purge(db,{failAfterPayments:true}),/forced failure/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM leads WHERE id=$1',[DEAL])).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM collection_accounts WHERE id=$1',[ACCOUNT])).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM lead_payments WHERE id=$1',[PAYMENT])).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_request_ledger WHERE request_id=$1',[REQUEST])).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM quotations WHERE id=$1',[QUOTE])).rows[0].n,1);
 await db.close();
});
