const {test}=require('node:test'),assert=require('node:assert/strict');
const C=require('../src/utils/collections');
const ids={sam:'11111111-1111-4111-8111-111111111111',admin:'22222222-2222-4222-8222-222222222222',other:'33333333-3333-4333-8333-333333333333',lead:'44444444-4444-4444-8444-444444444444',account:'55555555-5555-4555-8555-555555555555',quote:'66666666-6666-4666-8666-666666666666',payment:'77777777-7777-4777-8777-777777777777',request:'88888888-8888-4888-8888-888888888888'};
test('money validation rejects fractions, negative and nonfinite amounts',()=>{assert.equal(C.cents(100.12),10012);for(const n of [NaN,Infinity,-1,1.111,'garbage',1e15])assert.throws(()=>C.cents(n));});
test('payment API ownership, exact totals, retry protection, receipts, correction and quote conversion',async()=>{
 process.env.JWT_SECRET='collection-test-only';const db=require('../src/db'),{signToken}=require('../src/utils/tokens');
 let a=null,payments=[{id:ids.payment,lead_id:ids.lead,account_id:null,amount:20,note:'Internal note',recorded_by:ids.admin,paid_at:'2026-09-01T00:00:00Z',payment_date:'2026-09-01',method:'unspecified',reference:'',version:1,receipt_number:1}],tx,fail=false,revStatus='accepted',leadValue=100,leadStatus='won',quoteLead=ids.lead,seen=[];
 const virtual=()=>({key:'lead:'+ids.lead,id:null,lead_id:ids.lead,assigned_to:ids.sam,owner_id:ids.sam,owner_name:'Anand',customer:{name:'Cafe',phone:'919876543210'},snapshot:{},total:leadValue,currency:'INR',version:0});
 const snap=()=>({company:'Swirl',prefix:'SW-Q',currency:'INR',totalMinor:10000,customer:{name:'Cafe',phone:'919876543210'},package:{name:'POS',quantity:2,price:50},addons:[]});
 const query=async(sql,p=[])=>{seen.push({sql,p});
  if(sql==='BEGIN'){tx=structuredClone({a,payments});return{rows:[]}}if(sql==='ROLLBACK'){({a,payments}=tx);return{rows:[]}}if(sql==='COMMIT')return{rows:[]};
  if(sql.startsWith('SELECT id FROM users'))return{rows:[{id:p[0]}]};
  if(sql.startsWith('SELECT lead_id FROM collection_accounts'))return{rows:a&&p[0]===a.id?[{lead_id:a.lead_id}]:[]};
  if(sql.startsWith('SELECT id FROM leads'))return{rows:[{id:ids.lead}]};
  if(sql.startsWith('SELECT id FROM collection_accounts WHERE id='))return{rows:a?[{id:a.id}]:[]};
  if(sql.startsWith('SELECT c.*')){const v=a||virtual();return{rows:(p[0]===v.lead_id||p[0]===v.id)&&(!p[1]||p[1]===v.assigned_to)?[structuredClone(v)]:[]};}
  if(sql.startsWith('SELECT config FROM quotation_settings'))return{rows:[{config:{company:'Swirl'}}]};
  if(sql.startsWith('INSERT INTO collection_accounts(lead_id,owner_id')){a={...virtual(),id:ids.account,key:ids.account,version:1,snapshot:JSON.parse(p[3])};return{rows:[structuredClone(a)]};}
  if(sql.startsWith('SELECT * FROM lead_payments WHERE recorded_by'))return{rows:payments.filter(v=>v.recorded_by===p[0]&&v.request_id===p[1])};
  if(sql.startsWith('SELECT COALESCE(sum(amount),0) AS paid'))return{rows:[{paid:payments.filter(v=>sql.includes('id<>')?v.id!==p[2]:true).reduce((n,v)=>n+Number(v.amount),0)}]};
  if(sql.startsWith('INSERT INTO lead_payments')){const r={id:ids.request,lead_id:p[0],account_id:p[1],amount:p[2],note:p[3],recorded_by:p[4],payment_date:p[5],method:p[6],reference:p[7],request_id:p[8],version:1,receipt_number:2};payments.push(r);return{rows:[structuredClone(r)]};}
  if(sql.startsWith('INSERT INTO activity_logs')){if(fail)throw Error('Database write failed');return{rows:[]};}
  if(sql.startsWith('SELECT * FROM lead_payments WHERE id='))return{rows:payments.filter(v=>v.id===p[0])};
  if(sql.startsWith('UPDATE lead_payments SET')){const r=payments.find(v=>v.id===p[0]);r.amount=p[1];r.note=p[2];r.version++;return{rows:[structuredClone(r)]};}
  if(sql.startsWith('DELETE FROM lead_payments')){payments=payments.filter(v=>v.id!==p[0]);return{rows:[]};}
  if(sql.startsWith('SELECT p.*'))return{rows:payments.filter(v=>!sql.includes('p.id=$1')||v.id===p[0]).map(v=>({...v,recorded_by_name:'Anand'}))};
  if(sql.startsWith('SELECT * FROM quotations'))return{rows:p[0]===ids.quote&&(!p[1]||p[1]===ids.sam)?[{id:ids.quote,number:12,current_revision:1,owner_id:ids.sam,lead_id:quoteLead}]:[]};
  if(sql.startsWith('SELECT id FROM collection_accounts WHERE quote_id'))return{rows:a?.quote_id===p[0]?[{id:a.id}]:[]};
  if(sql.startsWith('SELECT * FROM quotation_revisions'))return{rows:[{revision:1,version:3,status:revStatus,snapshot:snap()}]};
  if(sql.startsWith('SELECT * FROM leads'))return{rows:[{id:ids.lead,salesman_id:ids.sam,status:leadStatus,deal_value:leadValue}]};
  if(sql.startsWith('SELECT * FROM collection_accounts WHERE lead_id'))return{rows:a?[structuredClone(a)]:[]};
  if(sql.startsWith('UPDATE collection_accounts SET quote_id')){Object.assign(a,{quote_id:p[1],quote_number:p[2],quote_revision:p[3],snapshot:JSON.parse(p[4]),customer:JSON.parse(p[5]),total:p[6],due_date:p[7],version:a.version+1});return{rows:[{id:a.id}]};}
  if(sql.startsWith('INSERT INTO collection_accounts(lead_id,quote_id')){a={...virtual(),id:ids.account,key:ids.account,lead_id:p[0],quote_id:p[1],customer:JSON.parse(p[3]),snapshot:JSON.parse(p[4]),total:p[7],currency:p[8],due_date:p[9],version:1};return{rows:[{id:a.id}]};}
  if(sql.startsWith('UPDATE collection_accounts SET due_date')){a.due_date=p[1];a.version++;return{rows:[]};}
  if(sql.startsWith('WITH accounts AS'))return{rows:[{accounts:[],summary:{collected:0,pending:0,overdue:0},employees:[]}]};
  throw Error('Unexpected SQL: '+sql.slice(0,90));
 };
 db.query=query;db.pool.connect=async()=>({query,release(){}});
 const express=require('express');require('express-async-errors');const app=express();app.use(express.json());app.use('/collections',require('../src/routes/collections.routes'));app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const req=(user,url='',method='GET',body)=>fetch(`http://127.0.0.1:${server.address().port}/collections${url}`,{method,headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+signToken({id:ids[user],role:user==='admin'?'admin':'salesman'})}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const key='/lead:'+ids.lead;
 try{
  assert.equal((await req(null)).status,401);assert.equal((await req('other',key)).status,404);assert.equal((await req('sam',key)).status,200);
  const pay={amount:30,paymentDate:'2026-09-02',method:'upi',reference:'UPI123',requestId:ids.request};
  assert.equal((await req('other',key+'/payments','POST',pay)).status,404);
  assert.equal((await req('sam',key+'/payments','POST',{...pay,amount:80.01})).status,409);assert.equal(a,null);
  fail=true;assert.equal((await req('sam',key+'/payments','POST',pay)).status,500);assert.equal(payments.length,1);assert.equal(a,null);fail=false;
  assert.equal((await req('sam',key+'/payments','POST',pay)).status,201);assert.equal(payments.length,2);assert.equal(payments[1].amount,30);
  assert.equal((await req('sam',key+'/payments','POST',pay)).status,201);assert.equal(payments.length,2);
  const account=await(await req('sam','/'+ids.account)).json();assert.equal(account.account.pending,50);assert.equal(account.payments.length,2);
  assert.equal((await req('sam',key+'/payments/'+ids.request,'PATCH',{amount:10,version:1})).status,403);
  assert.equal((await req('admin',key+'/payments/'+ids.request,'PATCH',{amount:10,version:99})).status,409);
  assert.equal((await req('admin',key+'/payments/'+ids.request,'PATCH',{amount:10,version:1})).status,200);assert.equal(payments[1].version,2);
  const r=await(await req('sam',key+'/payments/'+ids.request+'/receipt')).json();assert.equal(r.receipt.amount,10);assert.equal(r.receipt.method,'upi');assert.ok(!JSON.stringify(r).includes('Internal note'));
  assert.equal((await req('other',key+'/payments/'+ids.request+'/receipt')).status,404);
  const pdf=await req('sam',key+'/payments/'+ids.request+'/receipt?format=pdf');assert.equal(pdf.status,200);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,4).toString(),'%PDF');
  const cv={revision:1,version:3,dueDate:'2026-09-30'};
  revStatus='sent';assert.equal((await req('sam','/from-quotation/'+ids.quote,'POST',cv)).status,409);revStatus='accepted';
  assert.equal((await req('other','/from-quotation/'+ids.quote,'POST',cv)).status,404);
  assert.equal((await req('sam','/from-quotation/'+ids.quote,'POST',{...cv,version:1})).status,409);
  leadStatus='hot';assert.equal((await req('sam','/from-quotation/'+ids.quote,'POST',cv)).status,409);leadStatus='won';
  leadValue=99;assert.equal((await req('sam','/from-quotation/'+ids.quote,'POST',cv)).status,409);leadValue=100;
  assert.equal((await req('sam','/from-quotation/'+ids.quote,'POST',cv)).status,200);assert.equal(a.snapshot.package.quantity,2);assert.equal(payments.length,2);
  assert.equal((await(await req('sam','/from-quotation/'+ids.quote,'POST',cv)).json()).existing,true);
  assert.equal((await req('sam',key+'/due-date','PUT',{version:0,dueDate:'2026-10-01'})).status,409);
  assert.equal((await req('sam',key+'/due-date','PUT',{version:a.version,dueDate:'2026-10-01'})).status,200);
  assert.equal((await req('sam','?owner='+ids.other+'&from=2026-09-01&to=2026-09-30')).status,200);assert.equal(seen.findLast(v=>v.sql.startsWith('WITH accounts')).p[1],ids.sam);
  assert.equal((await req('admin','?currency=USD')).status,400);assert.equal((await req('admin','?from=2026-09-30&to=2026-09-01')).status,400);
  assert.equal((await req('admin',key+'/payments/'+ids.request,'DELETE',{version:2})).status,200);assert.equal(payments.length,1);
  a=null;payments=[];quoteLead=null;assert.equal((await req('sam','/from-quotation/'+ids.quote,'POST',cv)).status,200);assert.equal(a.lead_id,null);assert.equal(payments.length,0);
  assert.ok(seen.some(v=>v.sql.includes('FROM leads WHERE id=$1 FOR UPDATE')));
 }finally{await new Promise(r=>server.close(r));}
});
