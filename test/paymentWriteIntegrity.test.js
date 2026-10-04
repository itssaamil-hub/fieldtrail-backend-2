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

test('shared payment writer enforces backend-only invariants for every route',()=>{
 const src=read('src/utils/collections.js');
 assert.match(src,/if\(!UUID\.test\(b\.requestId\|\|''\)\)throw bad\('Payment request identifier required'\)/);
 assert.match(src,/await assertActive\(query,a\);await assertWon\(query,a\)/);
 assert.match(src,/async function correct[\s\S]*await assertActive\(query,a\);await assertWon\(query,a\)/);
 assert.match(src,/SELECT id,lead_id,archived_at,voided_at FROM collection_accounts WHERE id=\$1 FOR UPDATE/);
 assert.match(src,/if\(!Number\.isInteger\(b\.version\)\)throw bad\('Payment version required\. Refresh before editing\.'\)/);
 assert.match(src,/Payment request identifier was already used for different payment details/);
 assert.match(src,/Payment request identifier was already used for a deleted payment and cannot be reused/);
 assert.match(src,/UPDATE payment_request_ledger SET deleted_at=now\(\),payment_id=NULL/);
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
   CREATE TABLE users(id uuid PRIMARY KEY);
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
     recorded_by uuid REFERENCES users(id),
     paid_at timestamptz NOT NULL DEFAULT now(),
     amount numeric NOT NULL DEFAULT 0,
     note text,
     method text NOT NULL DEFAULT 'unspecified',
     reference text NOT NULL DEFAULT ''
   );
 `);
 await db.exec(read('src/migrations/108_payment_write_integrity.sql'));
 await db.query('INSERT INTO users(id) VALUES($1)',[USER]);
 await db.query("INSERT INTO leads(id,status) VALUES($1,'won')",[DEAL]);
 await db.query('INSERT INTO collection_accounts(id,lead_id) VALUES($1,$2)',[ACCOUNT,DEAL]);

 await assert.rejects(
   db.query('INSERT INTO lead_payments(id,lead_id,account_id,recorded_by,amount) VALUES($1,$2,$3,$4,10)',[PAYMENT,DEAL,ACCOUNT,USER]),
   /payment request identifier required/
 );

 await db.query('INSERT INTO lead_payments(id,lead_id,account_id,request_id,recorded_by,amount) VALUES($1,$2,$3,$4,$5,10)',[PAYMENT,DEAL,ACCOUNT,REQUEST,USER]);

 await db.query("UPDATE leads SET status='lost' WHERE id=$1",[DEAL]);
 await assert.rejects(
   db.query('INSERT INTO lead_payments(id,lead_id,account_id,request_id,recorded_by,amount) VALUES(gen_random_uuid(),$1,$2,gen_random_uuid(),$3,5)',[DEAL,ACCOUNT,USER]),
   /linked Deal must be Won/
 );

 await db.query("UPDATE leads SET status='won' WHERE id=$1",[DEAL]);
 await db.query('UPDATE collection_accounts SET archived_at=now() WHERE id=$1',[ACCOUNT]);
 await assert.rejects(db.query('UPDATE lead_payments SET amount=11 WHERE id=$1',[PAYMENT]),/archived payment account is read only/);
 await assert.rejects(db.query('DELETE FROM lead_payments WHERE id=$1',[PAYMENT]),/archived payment account is read only/);
 await db.close();
});

test('payment request ledger survives deletion and permanently reserves request identity',async()=>{
 const db=new PGlite();
 await db.exec(`
   CREATE TABLE users(id uuid PRIMARY KEY);
   CREATE TABLE leads(id uuid PRIMARY KEY,status text NOT NULL);
   CREATE TABLE collection_accounts(id uuid PRIMARY KEY,lead_id uuid UNIQUE REFERENCES leads(id));
   CREATE TABLE lead_payments(
     id uuid PRIMARY KEY,
     lead_id uuid REFERENCES leads(id),
     account_id uuid REFERENCES collection_accounts(id),
     request_id uuid,
     recorded_by uuid REFERENCES users(id),
     paid_at timestamptz NOT NULL DEFAULT now(),
     amount numeric NOT NULL,
     note text,
     method text NOT NULL DEFAULT 'unspecified',
     reference text NOT NULL DEFAULT ''
   );
 `);
 await db.query('INSERT INTO users(id) VALUES($1)',[USER]);
 await db.query("INSERT INTO leads(id,status) VALUES($1,'won')",[DEAL]);
 await db.query('INSERT INTO collection_accounts(id,lead_id) VALUES($1,$2)',[ACCOUNT,DEAL]);
 await db.query("INSERT INTO lead_payments(id,lead_id,account_id,request_id,recorded_by,paid_at,amount,method,reference,note) VALUES($1,$2,$3,$4,$5,'2026-10-05T00:00:00Z',10,'upi','ABC','first')",[PAYMENT,DEAL,ACCOUNT,REQUEST,USER]);
 await db.exec(read('src/migrations/109_payment_request_ledger.sql'));
 let r=await db.query('SELECT request_id,payment_id,amount,payment_date,method,reference,note FROM payment_request_ledger WHERE recorded_by=$1 AND request_id=$2',[USER,REQUEST]);
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].payment_id,PAYMENT);assert.equal(Number(r.rows[0].amount),10);assert.equal(r.rows[0].method,'upi');
 await db.query('UPDATE payment_request_ledger SET deleted_at=now(),payment_id=NULL WHERE recorded_by=$1 AND request_id=$2',[USER,REQUEST]);
 await db.query('DELETE FROM lead_payments WHERE id=$1',[PAYMENT]);
 r=await db.query('SELECT payment_id,deleted_at FROM payment_request_ledger WHERE recorded_by=$1 AND request_id=$2',[USER,REQUEST]);
 assert.equal(r.rows[0].payment_id,null);assert.ok(r.rows[0].deleted_at);
 await assert.rejects(db.query('INSERT INTO payment_request_ledger(recorded_by,request_id,account_id,lead_id,amount,payment_date,method,reference,note) VALUES($1,$2,$3,$4,11,$5,$6,$7,$8)',[USER,REQUEST,ACCOUNT,DEAL,'2026-10-05','upi','XYZ','second']),/duplicate key/);
 await db.close();
});
