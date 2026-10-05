const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

async function setup(){
 const db=new PGlite();
 await db.exec(`
  CREATE TABLE users(id uuid PRIMARY KEY);
  CREATE TABLE quotations(id uuid PRIMARY KEY);
  CREATE TABLE leads(
   id uuid PRIMARY KEY,salesman_id uuid REFERENCES users(id),business_name text NOT NULL,
   contact_name text,phone text,status text NOT NULL,deal_value numeric
  );
  CREATE TABLE collection_accounts(
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   lead_id uuid UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
   quote_id uuid UNIQUE REFERENCES quotations(id) ON DELETE SET NULL,
   owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
   customer jsonb NOT NULL,snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
   quote_number text,quote_revision integer,total numeric NOT NULL,currency text NOT NULL,
   due_date date,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
   archived_at timestamptz,archive_reason text,voided_at timestamptz
  );
 `);
 await db.exec(read('src/migrations/111_canonical_deal_payment_accounts.sql'));
 return db;
}

test('Won transition creates one real account, archives it, then reactivates same account',async()=>{
 const db=await setup();
 const user='11111111-1111-4111-8111-111111111111';
 const lead='22222222-2222-4222-8222-222222222222';
 await db.query('INSERT INTO users(id) VALUES($1)',[user]);
 await db.query("INSERT INTO leads(id,salesman_id,business_name,contact_name,phone,status,deal_value) VALUES($1,$2,'Cafe One','Owner','9999999999','negotiation',20000)",[lead,user]);
 assert.equal((await db.query('SELECT count(*)::int n FROM collection_accounts WHERE lead_id=$1',[lead])).rows[0].n,0);
 await db.query("UPDATE leads SET status='won' WHERE id=$1",[lead]);
 const first=(await db.query('SELECT * FROM collection_accounts WHERE lead_id=$1',[lead])).rows[0];
 assert.ok(first?.id);
 assert.equal(Number(first.total),20000);
 assert.equal(first.customer.name,'Cafe One');
 assert.equal(first.archived_at,null);
 await db.query("UPDATE leads SET status='lost' WHERE id=$1",[lead]);
 const archived=(await db.query('SELECT * FROM collection_accounts WHERE lead_id=$1',[lead])).rows[0];
 assert.ok(archived.archived_at);
 await db.query("UPDATE leads SET status='won' WHERE id=$1",[lead]);
 const active=(await db.query('SELECT * FROM collection_accounts WHERE lead_id=$1',[lead])).rows[0];
 assert.equal(active.id,first.id);
 assert.equal(active.archived_at,null);
 assert.equal((await db.query('SELECT count(*)::int n FROM collection_accounts WHERE lead_id=$1',[lead])).rows[0].n,1);
 await db.close();
});

test('migration backfills existing Won Deal and removes live quotation FK link',async()=>{
 const db=new PGlite();
 await db.exec(`
  CREATE TABLE users(id uuid PRIMARY KEY);
  CREATE TABLE quotations(id uuid PRIMARY KEY);
  CREATE TABLE leads(id uuid PRIMARY KEY,salesman_id uuid,business_name text NOT NULL,contact_name text,phone text,status text NOT NULL,deal_value numeric);
  CREATE TABLE collection_accounts(
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lead_id uuid UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
   quote_id uuid UNIQUE REFERENCES quotations(id) ON DELETE SET NULL,owner_id uuid,customer jsonb NOT NULL,snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
   quote_number text,quote_revision integer,total numeric NOT NULL,currency text NOT NULL,due_date date,version integer NOT NULL DEFAULT 1,
   created_at timestamptz NOT NULL DEFAULT now(),archived_at timestamptz,archive_reason text,voided_at timestamptz
  );
 `);
 const won='33333333-3333-4333-8333-333333333333';
 const linked='44444444-4444-4444-8444-444444444444';
 const quote='55555555-5555-4555-8555-555555555555';
 await db.query("INSERT INTO leads(id,business_name,status,deal_value) VALUES($1,'Backfill Cafe','won',9000),($2,'Linked Cafe','lost',7000)",[won,linked]);
 await db.query('INSERT INTO quotations(id) VALUES($1)',[quote]);
 await db.query("INSERT INTO collection_accounts(lead_id,quote_id,customer,total,currency) VALUES($1,$2,'{}',7000,'INR')",[linked,quote]);
 await db.exec(read('src/migrations/111_canonical_deal_payment_accounts.sql'));
 assert.equal((await db.query('SELECT count(*)::int n FROM collection_accounts WHERE lead_id=$1',[won])).rows[0].n,1);
 assert.equal((await db.query('SELECT quote_id FROM collection_accounts WHERE lead_id=$1',[linked])).rows[0].quote_id,null);
 await db.close();
});

test('quotation-to-payment conversion route is retired before legacy router',()=>{
 const lifecycle=read('src/routes/collectionLifecycle.routes.js');
 assert.match(lifecycle,/Quotation-to-payment conversion has been retired/);
 assert.match(lifecycle,/router\.post\('\/from-quotation\/:id'/);
});
