const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('crypto'),fs=require('fs');
const {PGlite}=require('@electric-sql/pglite');
process.env.JWT_SECRET='isolated-broadcast-tests';
const B=require('../src/utils/broadcastData');
const config={title:'Live report',type:'won',columns:['business','value'],period:'all',employee:null,status:'all',currency:'INR',expiryDays:7};
test('broadcast validates fields, dates, currency and signed capabilities',()=>{
 for(const patch of [{columns:['phone']},{type:'__proto__'},{period:'custom',from:'2026-02-30',to:'2026-03-01'},{status:'invalid'},{employee:'bad'},{expiryDays:-1}])assert.throws(()=>B.validate({...config,...patch}));
 const id=crypto.randomUUID(),token=B.tokenFor(id);assert.equal(B.tokenId(token),id);assert.equal(B.tokenId(token.slice(0,-1)+(token.endsWith('0')?'1':'0')),null);assert.equal(B.tokenId('é'.repeat(101)),null);
 assert.deepEqual(B.bounds({...config,period:'month'},new Date('2026-10-31T18:30:00Z')),['2026-11-01','2026-11-30']);
});
test('live report routes enforce admin, PIN, scope, pagination, expiry, revocation and private RLS',async()=>{
 const pg=new PGlite(),db=require('../src/db'),oldQuery=db.query,oldConnect=db.pool.connect;
 const admin=crypto.randomUUID(),sales=crypto.randomUUID(),other=crypto.randomUUID(),lead=crypto.randomUUID(),cold=crypto.randomUUID(),account=crypto.randomUUID();
 await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
 CREATE TABLE users(id uuid PRIMARY KEY,role text,full_name text,is_active boolean,auth_version integer);
 CREATE TYPE lead_status AS ENUM ('cold','conversation','hot','demo','negotiation','won','lost','nurture');
 CREATE TABLE leads(id uuid PRIMARY KEY,salesman_id uuid,business_name text,contact_name text,phone text,status lead_status,deal_value numeric,created_at timestamptz,next_follow_up_date date);
 CREATE TABLE lead_stage_milestones(lead_id uuid,stage text,occurred_at timestamptz);
 CREATE TABLE collection_accounts(id uuid PRIMARY KEY,lead_id uuid,quote_id uuid,owner_id uuid,customer jsonb,snapshot jsonb,quote_number text,quote_revision integer,total numeric,currency text,due_date date,version integer,created_at timestamptz,voided_at timestamptz,archived_at timestamptz);
 CREATE TABLE lead_payments(id uuid PRIMARY KEY,account_id uuid,lead_id uuid,amount numeric,paid_at timestamptz);`);
 await pg.exec(fs.readFileSync(require('path').join(__dirname,'../src/migrations/120_broadcast_data.sql'),'utf8'));
 await pg.query("INSERT INTO users VALUES($1,'admin','Admin',true,0),($2,'salesman','Owner',true,0),($3,'salesman','Other',true,0)",[admin,sales,other]);
 await pg.query("INSERT INTO leads VALUES($1,$2,'Real customer','Private contact','SECRET','won',100,now(),NULL),($3,$4,'Cold customer','Private','SECRET','cold',200,now(),NULL)",[lead,sales,cold,other]);
 await pg.query("INSERT INTO lead_stage_milestones VALUES($1,'won',now())",[lead]);
 db.query=(sql,args)=>pg.query(sql,args);db.pool.connect=async()=>({query:db.query,release(){}});
 const express=require('express');require('express-async-errors');const routes=require('../src/routes/broadcastData.routes'),{signToken}=require('../src/utils/tokens');
 const app=express();app.use(express.json());app.use('/admin',routes.admin);app.use('/public',routes.publicRouter);app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const call=async(path,body,user=admin)=>{const headers={'Content-Type':'application/json'};if(user)headers.Authorization='Bearer '+signToken({id:user,role:user===admin?'admin':'salesman'});const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try{
 assert.equal((await call('/admin',undefined,sales)).status,403);assert.equal((await call('/admin',undefined,null)).status,401);
 const requestId=crypto.randomUUID(),create={...config,requestId,pin:'123456'};
 let r=await call('/admin',create);assert.equal(r.status,201,JSON.stringify(r.body));const token=r.body.link.token;
 assert.equal((await call('/admin',create)).status,200);assert.equal((await call('/admin',{...create,title:'changed'})).status,409);
 assert.equal((await call('/public/read',{token},null)).status,401);assert.equal((await call('/public/read',{token,pin:'000000'},null)).status,401);
 r=await call('/public/read',{token,pin:'123456'},null);assert.equal(r.status,200);assert.deepEqual(r.body.rows,[{business:'Real customer',value:'100'}]);assert.ok(!JSON.stringify(r.body).includes('SECRET'));
 await pg.query('UPDATE leads SET deal_value=150 WHERE id=$1',[lead]);assert.equal((await call('/public/read',{token,pin:'123456'},null)).body.rows[0].value,'150');
 await pg.query("UPDATE leads SET status='cold' WHERE id=$1",[lead]);assert.equal((await call('/public/read',{token,pin:'123456'},null)).body.rows.length,0);
 await pg.query("UPDATE leads SET status='won' WHERE id=$1",[lead]);
 const pay={...config,type:'payments',columns:['business','paid','remaining'],employee:sales};
 await pg.query("INSERT INTO collection_accounts VALUES($1,$2,NULL,$3,'{\"name\":\"Real customer\",\"phone\":\"SECRET\"}','{}',NULL,NULL,150,'INR',current_date-1,1,now(),NULL,NULL)",[account,lead,sales]);
 await pg.query('INSERT INTO lead_payments VALUES($1,$2,$3,50,now())',[crypto.randomUUID(),account,lead]);
 r=await call('/admin/preview',{...pay,status:'partial'});assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.rows,[{business:'Real customer',paid:'50',remaining:'100'}]);
 assert.equal((await call('/admin/preview',{...pay,status:'pending'})).body.rows.length,0);
 assert.equal((await call('/admin/preview',{...pay,status:'overdue'})).body.rows.length,1);
 await pg.query('UPDATE collection_accounts SET archived_at=now() WHERE id=$1',[account]);assert.equal((await call('/admin/preview',pay)).body.rows.length,0);
 await pg.query('UPDATE collection_accounts SET archived_at=NULL,voided_at=now() WHERE id=$1',[account]);assert.equal((await call('/admin/preview',pay)).body.rows.length,0);
 for(let i=0;i<52;i++)await pg.query("INSERT INTO leads VALUES($1,$2,$3,'','SECRET','cold',1,now(),NULL)",[crypto.randomUUID(),sales,'Page '+i]);
 const page=await fetch(`http://127.0.0.1:${server.address().port}/public/view?mode=combined`);
 assert.equal(page.status,200);
 const pageHtml=await page.text();
 assert.ok(pageHtml.includes('data-tab="deals"')&&pageHtml.includes('data-tab="payments"'));
 assert.ok(pageHtml.includes('class="cards"'));
 const vm=require('node:vm'),script=pageHtml.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(script);new vm.Script(script[1]);
 const combined={...config,type:'combined',dealColumns:['business','status','value'],paymentColumns:['business','paid','remaining'],employee:sales};
 assert.deepEqual(B.validate(combined).dealColumns,combined.dealColumns);
 assert.throws(()=>B.validate({...combined,dealColumns:['phone']}),/columns/);
 let combinedPreview=await call('/admin/preview',{...combined,tab:'deals',status:'all',search:'Real'});
 assert.equal(combinedPreview.status,200,JSON.stringify(combinedPreview.body));
 assert.deepEqual(combinedPreview.body.rows,[{business:'Real customer',status:'won',value:'150'}]);
 combinedPreview=await call('/admin/preview',{...combined,tab:'deals',status:'cold',search:'Real'});
 assert.equal(combinedPreview.body.rows.length,0);
 combinedPreview=await call('/admin/preview',{...combined,tab:'payments',status:'all',search:'Real'});
 assert.equal(combinedPreview.body.rows.length,0); // The account is voided.
 const combinedCreate=await call('/admin',{...combined,requestId:crypto.randomUUID(),pin:'654321'});
 assert.equal(combinedCreate.status,201,JSON.stringify(combinedCreate.body));
 const combinedToken=combinedCreate.body.link.token;
 const combinedRead=await call('/public/read',{token:combinedToken,pin:'654321',tab:'deals',status:'all'},null);
 assert.equal(combinedRead.status,200,JSON.stringify(combinedRead.body));
 assert.ok(combinedRead.body.rows.length>0);
 assert.ok(!JSON.stringify(combinedRead.body).includes('SECRET'));
 assert.equal((await call('/public/read',{token:combinedToken,pin:'654321',tab:'invalid'},null)).status,400);
 assert.equal((await call('/public/read',{token:combinedToken,pin:'654321',tab:'deals',status:'__invalid'},null)).status,400);
 const leadConfig={...config,type:'leads',columns:['business'],employee:sales};
 const page1=(await call('/admin/preview',leadConfig)).body,page2=(await call('/admin/preview',{...leadConfig,offset:50})).body;assert.equal(page1.rows.length,50);assert.equal(page1.hasMore,true);assert.equal(page2.rows.length,3);
 assert.equal((await call('/admin/preview',{...leadConfig,employee:other})).body.rows.length,1);
 for(let i=0;i<10;i++)await call('/public/read',{token,pin:'000000'},null);
 assert.equal((await call('/public/read',{token,pin:'123456'},null)).status,429);
 await pg.query('UPDATE broadcast_links SET locked_until=now()-interval \'1 second\' WHERE id=$1',[requestId]);assert.equal((await call('/public/read',{token,pin:'123456'},null)).status,200);
 await pg.query('UPDATE broadcast_links SET expires_at=now()-interval \'1 second\' WHERE id=$1',[requestId]);assert.equal((await call('/public/read',{token,pin:'123456'},null)).status,404);
 await pg.query('UPDATE broadcast_links SET expires_at=NULL WHERE id=$1',[requestId]);
 await pg.query('UPDATE users SET is_active=false WHERE id=$1',[admin]);assert.equal((await call('/public/read',{token,pin:'123456'},null)).status,404);await pg.query('UPDATE users SET is_active=true WHERE id=$1',[admin]);
 assert.equal((await call('/admin/'+requestId+'/revoke',{})).status,200);assert.equal((await call('/public/read',{token,pin:'123456'},null)).status,404);assert.equal((await call('/admin/'+requestId+'/revoke',{})).status,200);
 const policy=(await pg.query("SELECT relrowsecurity FROM pg_class WHERE relname='broadcast_links'")).rows[0];assert.equal(policy.relrowsecurity,true);assert.equal((await pg.query("SELECT has_table_privilege('anon','broadcast_links','SELECT') AS allowed")).rows[0].allowed,false);assert.equal((await pg.query("SELECT has_table_privilege('authenticated','broadcast_links','SELECT') AS allowed")).rows[0].allowed,false);
 }finally{db.query=oldQuery;db.pool.connect=oldConnect;await new Promise(r=>server.close(r));await pg.close();}
});

test('production CORS permits only Render-hosted public Broadcast access, not CRM routes', async()=>{
 const previousEnv={node:process.env.NODE_ENV,cors:process.env.CORS_ORIGINS};
 const previousApp=require.cache[require.resolve('../src/app')];
 const appPath=require.resolve('../src/app');
 try{
  process.env.NODE_ENV='production';process.env.CORS_ORIGINS='https://fieldtrail-backend-3.vercel.app';
  delete require.cache[appPath];
  const liveApp=require('../src/app'),server=liveApp.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  try{
   const base='http://127.0.0.1:'+server.address().port;
   const check=async(path,origin)=>fetch(base+path,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST'}});
   const ownOrigin='https://engage-backend-65xk.onrender.com';
   let r=await check('/public/broadcast/read',ownOrigin);
   assert.equal(r.status,204);
   assert.equal(r.headers.get('access-control-allow-origin'),ownOrigin);
   r=await check('/broadcast-data/preview',ownOrigin);
   assert.equal(r.status,403);
   r=await check('/public/broadcast/read','https://evil.example');
   assert.equal(r.status,403);
   r=await check('/broadcast-data/preview','https://fieldtrail-backend-3.vercel.app');
   assert.equal(r.status,204);
  }finally{await new Promise(resolve=>server.close(resolve));}
 }finally{
  if(previousEnv.node===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousEnv.node;
  if(previousEnv.cors===undefined)delete process.env.CORS_ORIGINS;else process.env.CORS_ORIGINS=previousEnv.cors;
  delete require.cache[appPath];if(previousApp)require.cache[appPath]=previousApp;
 }
});
