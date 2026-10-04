const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');

test('collection API executes PostgreSQL balance, status, date, ownership and pagination queries',async()=>{
 process.env.JWT_SECRET='isolated-payment-sql-test';
 const pg=new PGlite();const db=require('../src/db');const original=db.query;
 const admin='11111111-1111-4111-8111-111111111111',employee='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
 const id=n=>`44444444-4444-4444-8444-${String(n).padStart(12,'0')}`;
 await pg.exec(`CREATE TABLE users(id uuid PRIMARY KEY,role text,full_name text,is_active boolean,auth_version integer);
 CREATE TABLE leads(id uuid PRIMARY KEY,salesman_id uuid,business_name text,contact_name text,phone text,status text,deal_value numeric,created_at timestamptz);
 CREATE TABLE collection_accounts(id uuid PRIMARY KEY,lead_id uuid,quote_id uuid,owner_id uuid,customer jsonb,snapshot jsonb,quote_number text,quote_revision integer,total numeric,currency text,due_date date,version integer,created_at timestamptz);
 CREATE TABLE lead_payments(id uuid PRIMARY KEY,account_id uuid,lead_id uuid,amount numeric,paid_at timestamptz);
 INSERT INTO users VALUES('${admin}','admin','Admin',true,0),('${employee}','salesman','Employee',true,0),('${other}','salesman','Other',true,0);`);
 for(const [n,name,paid,due,owner,currency] of [[1,'Unpaid',0,'future',employee,'INR'],[2,'Partial',25,'future',employee,'INR'],[3,'Partial overdue',40,'past',employee,'INR'],[4,'Unpaid overdue',0,'past',employee,'INR'],[5,'Paid',100,'past',employee,'INR'],[6,'Other employee',0,'future',other,'INR'],[7,'Other currency',0,'past',employee,'AED']]){
  await pg.query(`INSERT INTO collection_accounts VALUES($1,NULL,NULL,$2,$3::jsonb,'{}',NULL,NULL,100,$4,(now() AT TIME ZONE 'Asia/Kolkata')::date + $5::int,1,now())`,[id(n),owner,JSON.stringify({name,phone:'1234567890'}),currency,due==='past'?-1:1]);
  if(paid)await pg.query('INSERT INTO lead_payments VALUES($1,$2,NULL,$3,$4)',[id(n+100),id(n),paid,'2020-01-01T00:00:00Z']);
 }
 // Won leads without an explicitly created collection account must not appear in Payments.
 await pg.query("INSERT INTO leads VALUES($1,$2,'Won without account','Contact','123','won',10,now()),($3,$2,'Cold','Contact','123','cold',100,now())",[id(8),employee,id(9)]);
 // A payment referencing both account and lead must be counted once.
 await pg.query("UPDATE collection_accounts SET lead_id=$2 WHERE id=$1",[id(2),id(9)]);
 await pg.query('UPDATE lead_payments SET lead_id=$2 WHERE account_id=$1',[id(2),id(9)]);
 db.query=(sql,args)=>pg.query(sql,args);
 const express=require('express');require('express-async-errors');const {signToken}=require('../src/utils/tokens');
 const app=express();app.use('/collections',require('../src/routes/collections.routes'));app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const call=async(query='',user=admin)=>{const role=user===admin?'admin':'salesman';const r=await fetch(`http://127.0.0.1:${server.address().port}/collections?${query}`,{headers:{Authorization:'Bearer '+signToken({id:user,role})}});return {status:r.status,...await r.json()};};
 const names=r=>r.accounts.map(a=>a.customer.name).sort();
 try{
  const all=await call();assert.equal(all.status,200);assert.equal(all.accounts.length,6);assert.deepEqual(all.summary,{collected:165,pending:435,overdue:160});
  assert.deepEqual(names(await call('status=pending')),['Other employee','Unpaid','Unpaid overdue']);
  assert.deepEqual(names(await call('status=partial')),['Partial','Partial overdue']);
  assert.deepEqual(names(await call('status=overdue')),['Partial overdue','Unpaid overdue']);
  assert.deepEqual(names(await call('status=paid')),['Paid']);
  assert.equal((await call('status=partial')).accounts.find(a=>a.customer.name==='Partial').paid,25);
  const ranged=await call('from=2026-01-01&to=2026-01-01');assert.deepEqual(ranged.summary,{collected:0,pending:435,overdue:160});assert.deepEqual(names(ranged),names(all));
  // Inclusive date boundaries are measured in IST, not UTC.
  for(const [n,at] of [[201,'2025-12-31T18:29:59Z'],[202,'2025-12-31T18:30:00Z'],[203,'2026-01-01T18:29:59Z'],[204,'2026-01-01T18:30:00Z']])await pg.query('INSERT INTO lead_payments VALUES($1,$2,NULL,1,$3)',[id(n),id(5),at]);
  assert.equal((await call('from=2026-01-01&to=2026-01-01')).summary.collected,2);
  for(const q of ['from=2026-01-01','to=2026-01-01','from=2026-02-30&to=2026-03-01','from=2026-03-01&to=2026-01-01','status=invalid','offset=-1','currency=USD'])assert.equal((await call(q)).status,400,q);
  const own=await call(`status=paid&owner=${other}`,employee);assert.deepEqual(names(own),['Partial','Partial overdue','Unpaid','Unpaid overdue']);assert.deepEqual(own.employees,[]);
  assert.deepEqual(names(await call('search=overdue')),['Partial overdue','Unpaid overdue']);
  for(let n=300;n<355;n++)await pg.query("INSERT INTO collection_accounts VALUES($1,NULL,NULL,$2,'{\"name\":\"Page\"}','{}',NULL,NULL,1,'INR',NULL,1,now())",[id(n),employee]);
  const first=await call('status=pending'),second=await call('status=pending&offset=50');assert.equal(first.accounts.length,50);assert.equal(first.hasMore,true);assert.equal(second.accounts.length,8);assert.equal(second.hasMore,false);assert.equal(new Set([...first.accounts,...second.accounts].map(a=>a.key)).size,58);
 }finally{db.query=original;await new Promise(r=>server.close(r));await pg.close();}
});
