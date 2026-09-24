const {test}=require('node:test');
const assert=require('node:assert/strict');
const {nextTaskDue}=require('../src/utils/taskRecurrence');
test('recurrence preserves IST time, skips missed dates, and anchors month ends',()=>{
 assert.equal(nextTaskDue('2026-09-01T04:30:00Z','daily',1,new Date('2026-09-24T05:00:00Z')),'2026-09-25T04:30:00.000Z');
 assert.equal(nextTaskDue('2026-09-01T04:30:00Z','weekly',1,new Date('2026-09-02T00:00:00Z')),'2026-09-08T04:30:00.000Z');
 assert.equal(nextTaskDue('2026-01-31T04:30:00Z','monthly',31,new Date('2026-01-31T05:00:00Z')),'2026-02-28T04:30:00.000Z');
 assert.equal(nextTaskDue('2026-02-28T04:30:00Z','monthly',31,new Date('2026-02-28T05:00:00Z')),'2026-03-31T04:30:00.000Z');
 assert.equal(nextTaskDue('2028-01-31T04:30:00Z','monthly',31,new Date('2028-01-31T05:00:00Z')),'2028-02-29T04:30:00.000Z');
 assert.equal(nextTaskDue('2026-09-01T19:00:00Z','daily',2,new Date('2026-09-01T20:00:00Z')),'2026-09-02T19:00:00.000Z');
 assert.equal(nextTaskDue('2026-01-31T04:30:00Z','monthly',31,new Date('2027-04-30T05:00:00Z')),'2027-05-31T04:30:00.000Z');
 assert.equal(nextTaskDue('bad','none',null),null);
});
test('workflow routes scope access, audit reschedules, validate filters, and generate one recurring successor',async()=>{
 const express=require('express');require('express-async-errors');
 const db=require('../src/db'),{signToken}=require('../src/utils/tokens');process.env.JWT_SECRET='task-workflow-tests';
 const admin='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333',id='44444444-4444-4444-8444-444444444444';
 let t={id,title:'Visit',assigned_to:owner,created_by:admin,status:'pending',due_at:'2026-01-31T04:30:00Z',priority:'high',recurrence:'monthly',recurrence_day:31,notes:'Bring quote',lead_id:null};
 let children=0,failEvent=false,snapshot;const calls=[];
 const query=async(sql,p=[])=>{calls.push([sql,p]);
  if(sql==='BEGIN')snapshot={...t};if(sql==='ROLLBACK')t=snapshot;
  if(sql.startsWith('SELECT id FROM users'))return{rows:[{id:p[0]}]};
  if(sql.startsWith('SELECT * FROM crm_tasks'))return{rows:(p[1]&&p[1]!==owner)||(sql.includes('created_by=$2')&&p[1]&&t.created_by!==p[1])?[]:[{...t}]};
  if(sql.startsWith('SELECT t.*'))return{rows:sql.includes('t.id=$1')&&p[1]&&p[1]!==owner?[]:[{...t}]};
  if(sql.startsWith('SELECT count'))return{rows:[{pending:t.status==='completed'?0:1}]};
  if(sql.startsWith('UPDATE crm_tasks SET status=$2'))t.status=p[1];
  if(sql.startsWith('UPDATE crm_tasks SET due_at'))t.due_at=p[1];
  if(sql.startsWith('INSERT INTO task_events')&&failEvent)throw Error('event unavailable');
  if(sql.startsWith("UPDATE crm_tasks SET status='completed'"))t.status='completed';
  if(sql.startsWith('INSERT INTO crm_tasks')){children++;return{rows:[{id:'55555555-5555-4555-8555-555555555555'}]};}
  return{rows:[]};
 };
 db.query=query;db.pool.connect=async()=>({query,release(){}});
 const app=express();app.use(express.json());app.use('/tasks',require('../src/routes/tasks.routes'));app.use((e,q,r,n)=>r.status(500).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const req=async(user,path,body,method='PATCH')=>fetch(`http://127.0.0.1:${server.address().port}/tasks${path}`,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+signToken({id:user,role:user===admin?'admin':'salesman'})},...(body?{body:JSON.stringify(body)}:{})});
 try{
  assert.equal((await req(other,`/${id}/status`,{status:'in_progress'})).status,404);
  assert.equal((await req(owner,`/${id}/status`,{status:'in_progress'})).status,200);assert.equal(t.status,'in_progress');
  assert.equal((await req(owner,`/${id}/status`,{status:'completed'})).status,400);
  assert.equal((await req(owner,`/${id}/reschedule`,{dueAt:'2026-10-01T05:00:00Z',reason:' '})).status,400);
  assert.equal((await req(owner,`/${id}/reschedule`,{dueAt:'2026-10-01T05:00:00Z',reason:'Owner unavailable'})).status,200);
  assert.ok(calls.some(([s,p])=>s.startsWith('INSERT INTO task_events')&&p[2]==='rescheduled'&&p[5]==='Owner unavailable'));
  failEvent=true;assert.equal((await req(owner,`/${id}/reschedule`,{dueAt:'2026-11-01T05:00:00Z',reason:'Retry'})).status,500);assert.equal(t.due_at,'2026-10-01T05:00:00Z');failEvent=false;
  assert.equal((await req(owner,`/${id}/options`,{priority:'low',recurrence:'none'})).status,404);
  assert.equal((await req(admin,`/${id}/options`,{priority:'urgent',recurrence:'none'})).status,400);
  assert.equal((await req(other,`/${id}`,null,'GET')).status,404);
  assert.equal((await req(owner,'/?priority=urgent',null,'GET')).status,400);
  assert.equal((await req(owner,'/?from=2026-02-30',null,'GET')).status,400);
  assert.equal((await req(owner,'/?from=2026-10-01&to=2026-09-01',null,'GET')).status,400);
  await req(owner,`/?assignedTo=${other}&priority=high&status=in_progress&search=Cafe&from=2026-09-01&to=2026-09-30`,null,'GET');
  const list=calls.findLast(([s])=>s.includes('LIMIT 51'));assert.equal(list[1][0],owner);assert.equal(list[1][4],other);assert.equal(list[1][5],'high');assert.equal(list[1][6],'in_progress');assert.match(list[0],/strpos/);
  await req(owner,`/leads?assignedTo=${other}`,null,'GET');assert.equal(calls.findLast(([s])=>s.startsWith('SELECT id,business_name'))[1][0],owner);
  assert.equal((await req(owner,`/${id}/complete`,{note:'Done'})).status,200);assert.equal(children,1);
  assert.equal((await req(owner,`/${id}/complete`,{note:'retry'})).status,200);assert.equal(children,1);
  assert.equal((await req(owner,`/${id}/status`,{status:'pending'})).status,409);
  assert.equal((await req(owner,`/${id}/reschedule`,{dueAt:'2026-12-01T05:00:00Z',reason:'retry'})).status,409);
  assert.ok(calls.some(([s])=>s.includes('ON CONFLICT(repeat_of)')));
 }finally{await new Promise(r=>server.close(r));}
});
