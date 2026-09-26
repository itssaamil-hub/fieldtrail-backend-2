const {test}=require('node:test'),assert=require('node:assert/strict');
const {validateClosing,DEFAULTS}=require('../src/utils/dayClosing');
test('closing policy combinations cannot bypass required reports or skip reasons',()=>{
 for(const required of [false,true])for(const allow of [false,true])for(const reason of [false,true]){
  const p={require_closing:required,allow_skip:allow,require_skip_reason:reason};
  if(required)assert.throws(()=>validateClosing(p,{}),/Submit/);else assert.equal(validateClosing(p,{}).status,'not_required');
  assert.equal(validateClosing(p,{mode:'submit',outcomes:'Visited two outlets',priorities:'Demo tomorrow'}).status,'submitted');
  assert.throws(()=>validateClosing(p,{mode:'submit',outcomes:' ',priorities:'x'}));
  if(!allow||reason)assert.throws(()=>validateClosing(p,{mode:'skip'}));else assert.equal(validateClosing(p,{mode:'skip'}).status,'skipped');
  if(allow)assert.equal(validateClosing(p,{mode:'skip',skipReason:'Customer meeting ran late'}).status,'skipped');
 }
 assert.throws(()=>validateClosing(DEFAULTS,{mode:'unknown'}));
 assert.throws(()=>validateClosing(DEFAULTS,{mode:'submit',outcomes:'x'.repeat(2001),priorities:'x'}));
});
test('required closing + skip OFF + reason ON behaves correctly and multiple starts remains independent',()=>{
 const p={require_closing:true,allow_skip:false,require_skip_reason:true,allow_multiple_starts:true};
 assert.throws(()=>validateClosing(p,{mode:'none'}),/Submit your Day Closing/);
 assert.throws(()=>validateClosing(p,{mode:'skip',skipReason:'Even with a reason'}),/not allowed you to skip/);
 assert.equal(validateClosing(p,{mode:'submit',outcomes:'Completed follow-ups',priorities:'Continue tomorrow'}).status,'submitted');
 assert.equal(p.allow_multiple_starts,true);
});
test('day closing HTTP ownership, stale writes, direct End Day enforcement and atomic rollback',async()=>{
 process.env.JWT_SECRET='day-closing-test-only';const db=require('../src/db'),{signToken}=require('../src/utils/tokens');
 const sam='11111111-1111-4111-8111-111111111111',admin='22222222-2222-4222-8222-222222222222',attendanceId='33333333-3333-4333-8333-333333333333';
 let p={...DEFAULTS,require_closing:true},report=null,ended=false,failed=false,tx,reportScope,releases=0;
 const calls=[];const query=async(sql,args=[])=>{calls.push(sql);
  if(sql==='BEGIN'){tx=structuredClone({p,report,ended});return{rows:[]};}
  if(sql==='ROLLBACK'){({p,report,ended}=tx);return{rows:[]};}
  if(sql==='COMMIT')return{rows:[]};
  if(sql.startsWith('SELECT id FROM users'))return{rows:[{id:args[0]}]};
  if(sql.startsWith('SELECT * FROM employee_day'))return{rows:[{...p}]};
  if(sql.startsWith('INSERT INTO employee_day')){p={require_closing:args[1],allow_skip:args[2],require_skip_reason:args[3],allow_multiple_starts:args[4],version:p.version+1};return{rows:[{...p}]};}
  if(sql.startsWith('SELECT COALESCE(MAX(session_number)'))return{rows:[{max_session:1,ended_count:1}]};
  if(sql.startsWith('SELECT *,day::text'))return{rows:ended?[]:[{id:attendanceId,day:'2026-09-17',start_day_at:'2026-09-17T08:00Z'}]};
  if(sql.startsWith('SELECT id FROM attendance'))return{rows:ended?[{id:attendanceId}]:[]};
  if(sql.startsWith('SELECT * FROM day_closing')||sql.startsWith('SELECT version FROM day_closing'))return{rows:report?[structuredClone(report)]:[]};
  if(sql.startsWith('SELECT\n (SELECT count'))return{rows:[{leads:2,tasks:1,quotes:1,won:0}]};
  if(sql.startsWith('INSERT INTO day_closing_reports')){
   if(sql.includes("'draft'"))report={status:'draft',version:(report?.version||0)+1,outcomes:args[3],blockers:args[4],priorities:args[5]};
   else report={status:args[3],outcomes:args[4],skip_reason:args[7],version:(report?.version||0)+1};
   return{rows:[structuredClone(report)]};
  }
  if(sql.startsWith('UPDATE attendance')){ended=true;return{rows:[]};}
  if(sql.startsWith('INSERT INTO notifications')){if(failed)throw Error('Simulated write failure');return{rows:[]};}
  if(sql.startsWith('SELECT u.id AS user_id')){reportScope=args[1];return{rows:[]};}
  return{rows:[]};
 };
 db.query=query;db.pool.connect=async()=>({query,release(){releases++}});
 const express=require('express');require('express-async-errors');const app=express();app.use(express.json());app.use('/day-closing',require('../src/routes/dayClosing.routes'));app.use('/salesman',require('../src/routes/salesman.routes'));app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const req=(role,url,method='GET',body)=>fetch(`http://127.0.0.1:${server.address().port}${url}`,{method,headers:{'Content-Type':'application/json',...(role?{Authorization:'Bearer '+signToken({id:role==='admin'?admin:sam,role})}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const gps={lat:26.8467,lng:80.9462};
 try{
  assert.equal((await req(null,'/day-closing/current')).status,401);
  assert.equal((await req('salesman','/day-closing/permissions/'+sam)).status,403);
  assert.equal((await req('admin','/day-closing/current')).status,403);
  assert.equal((await req('salesman','/salesman/day/end','POST',gps)).status,409);assert.equal(ended,false);assert.equal(report,null);
  assert.equal((await req('salesman','/salesman/day/end','POST',{...gps,mode:'skip',skipReason:'x'})).status,403);
  assert.equal((await req('admin','/day-closing/permissions/'+sam,'PUT',{...p,allow_skip:true})).status,200);
  assert.equal((await req('admin','/day-closing/permissions/'+sam,'PUT',{...p,version:0})).status,409);
  assert.equal((await req('salesman','/salesman/day/end','POST',{...gps,mode:'skip'})).status,400);
  assert.equal((await req('salesman','/day-closing/reports?employee='+admin)).status,200);assert.equal(reportScope,sam);
  assert.equal((await req('admin','/day-closing/reports?employee='+sam)).status,200);assert.equal(reportScope,sam);
  const draft={attendanceId,version:0,outcomes:'Two visits',blockers:'',priorities:'Call owner'};
  assert.equal((await req('salesman','/day-closing/draft','PUT',draft)).status,200);assert.equal(ended,false);assert.equal(report.version,1);
  assert.equal((await req('salesman','/day-closing/draft','PUT',draft)).status,409);
  assert.equal((await req('salesman','/salesman/day/end','POST',{...gps,...draft,mode:'submit'})).status,409);
  failed=true;assert.equal((await req('salesman','/salesman/day/end','POST',{...gps,...draft,version:1,mode:'submit'})).status,500);assert.equal(ended,false);assert.equal(report.status,'draft');assert.equal(report.version,1);
  failed=false;assert.equal((await req('salesman','/salesman/day/end','POST',{...gps,...draft,version:1,mode:'submit'})).status,200);assert.equal(ended,true);assert.equal(report.status,'submitted');
  const finalized=structuredClone(report);assert.equal((await req('salesman','/salesman/day/end','POST',gps)).status,200);assert.deepEqual(report,finalized);
  assert.equal((await req('salesman','/day-closing/draft','PUT',{...draft,version:2})).status,409);
  assert.equal((await req('salesman','/salesman/day/start','POST',gps)).status,409);
  ended=false;report=null;assert.equal((await req('salesman','/salesman/day/end','POST',{...gps,mode:'skip',skipReason:'Training overran'})).status,200);assert.equal(report.status,'skipped');assert.equal(report.skip_reason,'Training overran');
  assert.ok(releases>5);assert.ok(calls.some(sql=>sql.includes("is_active=true FOR UPDATE")));
 }finally{await new Promise(r=>server.close(r));}
});
