const {test}=require('node:test'),assert=require('node:assert/strict');
test('offline create retry returns only the owning employee lead',async()=>{
 process.env.JWT_SECRET='offline-owner-test';const db=require('../src/db'),original=db.query;
 const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
 db.query=async(sql,p)=>{
  if(sql.includes('FROM users WHERE'))return{rows:[{id:p[0]}]};
  if(sql.includes('FROM leads WHERE client_uuid'))return{rows:[{id,client_uuid:id,salesman_id:owner,business_name:'Private Cafe'}]};
  throw Error('Unexpected SQL');
 };
 const express=require('express');require('express-async-errors');const {signToken}=require('../src/utils/tokens');const app=express();app.use(express.json());app.use('/salesman',require('../src/routes/salesman.routes'));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const call=user=>fetch(`http://127.0.0.1:${server.address().port}/salesman/leads`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+signToken({id:user,role:'salesman'})},body:JSON.stringify({clientUuid:id})});
 try{let res=await call(other);assert.equal(res.status,409);assert.equal(JSON.stringify(await res.json()).includes('Private Cafe'),false);res=await call(owner);assert.equal(res.status,200);const data=await res.json();assert.equal(data.deduped,true);assert.equal(data.lead.salesman_id,owner);}finally{db.query=original;await new Promise(r=>server.close(r));}
});
