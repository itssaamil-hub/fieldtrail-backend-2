const test = require('node:test');
const assert = require('node:assert/strict');
const {parseFilters,feedQuery} = require('../src/utils/activityCentreFeed');
test('activity dates use IST and reject impossible, reversed and unbounded ranges',()=>{
 assert.equal(parseFilters({},new Date('2026-09-30T19:00:00Z')).from,'2026-10-01');
 for(const q of [{from:'2026-02-30'},{from:'2026-10-03',through:'2026-10-01'},{from:'2024-01-01',through:'2026-10-01'},{offset:-1},{limit:1000},{employee:'bad'},{search:['bad']},{category:'secret'}]) assert.throws(()=>parseFilters(q),e=>e.status===400);
});
test('activity search and filters are parameterized, never inserted into SQL',()=>{
 const f=parseFilters({search:"'; DROP TABLE leads; --",from:'2026-10-01',through:'2026-10-01'});
 const q=feedQuery(f);assert.ok(!q.text.includes(f.search));assert.equal(q.values[5],f.search);
});
test('feed and lead lookup require a real active admin session',async(t)=>{
 process.env.JWT_SECRET='activity-test-only';
 const db=require('../src/db');const original=db.query;
 let calls=0;
 db.query=async(sql,params)=>{
  if(sql.startsWith('SELECT id FROM users'))return {rows:[{id:params[0]}]};
  calls++;
  if(sql.startsWith('SELECT l.*'))return {rows:[]};
  return {rows:[{activities:[],summary:{total:41,leadsAdded:2,statusChanges:3,quotesSent:4,tasksCompleted:1},payments:[{currency:'AED',amount:20}]}]};
 };
 const express=require('express');require('express-async-errors');
 const app=express();app.use('/activity',require('../src/routes/activityCentre.routes'));
 app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{db.query=original;await new Promise(r=>server.close(r));});
 const {signToken}=require('../src/utils/tokens');
 const req=(role,path='/feed')=>fetch(`http://127.0.0.1:${server.address().port}/activity${path}`,{headers:role?{Authorization:'Bearer '+signToken({id:'11111111-1111-4111-8111-111111111111',role})}:{}});
 assert.equal((await req(null)).status,401);assert.equal((await req('salesman')).status,403);assert.equal(calls,0);
 const r=await req('admin');assert.equal(r.status,200);const body=await r.json();assert.equal(body.summary.total,41);assert.equal(body.hasMore,true);assert.equal(body.summary.payments[0].currency,'AED');
 assert.equal((await req('admin','/feed?from=garbage')).status,400);
 assert.equal((await req('salesman','/lead/11111111-1111-4111-8111-111111111111')).status,403);
 assert.equal((await req('admin','/lead/11111111-1111-4111-8111-111111111111')).status,404);
});
