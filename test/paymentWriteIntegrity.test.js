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

test('shared payment writer enforces backend-only invariants for every route',()=>{
 const src=read('src/utils/collections.js');
 assert.match(src,/if\(!UUID\.test\(b\.requestId\|\|''\)\)throw bad\('Payment request identifier required'\)/);
 assert.match(src,/await assertActive\(query,a\);await assertWon\(query,a\)/);
 assert.match(src,/async function correct[\s\S]*await assertActive\(query,a\);await assertWon\(query,a\)/);
 assert.match(src,/SELECT id,lead_id,archived_at,voided_at FROM collection_accounts WHERE id=\$1 FOR UPDATE/);
 assert.match(src,/row\.archived_at/);
 assert.match(src,/row\.status!==\'won\'/);
});

test('lead alias resolves the materialized account lifecycle instead of bypassing it',()=>{
 const src=read('src/routes/collectionLifecycle.routes.js');
 assert.match(src,/byLead=raw\.startsWith\('lead:'\)/);
 assert.match(src,/byLead\?'a\.lead_id=\$1':'a\.id=\$1'/);
 assert.doesNotMatch(src,/if\(String\(key\)\.startsWith\('lead:'\)\)return null/);
});

test('legacy admin lead payment route inherits the same shared writer',()=>{
 const src=read('src/routes/admin.routes.js');
 assert.match(src,/collections'\)\.record\(req\.user,'lead:'\+req\.params\.id,req\.body\)/);
 assert.match(src,/collections'\)\.correct\(req\.user,'lead:'\+req\.params\.id/);
});

test('database trigger rejects missing idempotency, non-Won deals and archived payment mutations',async()=>{
 const db=new PGlite();
 await db.exec(`
   CREATE TABLE leads(id uuid PRIMARY KEY,status text NOT NULL);
   CREATE TABLE collection_accounts(
     id uuid PRIMARY KEY,
     lead_id uuid UNIQUE REFERENCES leads(id),
     archived_at timestamptz,
     voided_at timestamptz
   );
   CREATE TABLE lead_payments(
     id uuid PRIMARY KEY,
     lead_id uuid REFERENCES leads(id),
     account_id uuid REFERENCES collection_accounts(id),
     request_id uuid,
     amount numeric NOT NULL DEFAULT 0
   );
 `);
 await db.exec(read('src/migrations/108_payment_write_integrity.sql'));
 await db.query("INSERT INTO leads(id,status) VALUES($1,'won')",[DEAL]);
 await db.query('INSERT INTO collection_accounts(id,lead_id) VALUES($1,$2)',[ACCOUNT,DEAL]);

 await assert.rejects(
   db.query('INSERT INTO lead_payments(id,lead_id,account_id,amount) VALUES($1,$2,$3,10)',[PAYMENT,DEAL,ACCOUNT]),
   /payment request identifier required/
 );

 await db.query('INSERT INTO lead_payments(id,lead_id,account_id,request_id,amount) VALUES($1,$2,$3,$4,10)',[PAYMENT,DEAL,ACCOUNT,REQUEST]);

 await db.query("UPDATE leads SET status='lost' WHERE id=$1",[DEAL]);
 await assert.rejects(
   db.query('INSERT INTO lead_payments(id,lead_id,account_id,request_id,amount) VALUES(gen_random_uuid(),$1,$2,gen_random_uuid(),5)',[DEAL,ACCOUNT]),
   /linked Deal must be Won/
 );

 await db.query("UPDATE leads SET status='won' WHERE id=$1",[DEAL]);
 await db.query('UPDATE collection_accounts SET archived_at=now() WHERE id=$1',[ACCOUNT]);
 await assert.rejects(db.query('UPDATE lead_payments SET amount=11 WHERE id=$1',[PAYMENT]),/archived payment account is read only/);
 await assert.rejects(db.query('DELETE FROM lead_payments WHERE id=$1',[PAYMENT]),/archived payment account is read only/);

 await db.close();
});
