const {test}=require('node:test'),assert=require('node:assert/strict');
process.env.JWT_SECRET='day-flow-test-only';
const keys=require('web-push').generateVAPIDKeys();process.env.VAPID_PUBLIC_KEY=keys.publicKey;process.env.VAPID_PRIVATE_KEY=keys.privateKey;
const db=require('../src/db');
const push=require('../src/utils/pushNotifications');
const dayClosing=require('../src/utils/dayClosing');

// Minimal in-memory fake of the tables Start/End Day touch.
function fakeDb({perEmployeeMulti=false,globalMulti=false,sessions=[]}={}){
 const state={sessions:sessions.map(s=>({...s})),status:'offline',log:[],notifications:[],committed:0,rolledBack:0};
 const query=async(sql,args=[])=>{
  state.log.push(sql);
  if(sql==='BEGIN')return{rows:[]};
  if(sql==='COMMIT'){state.committed++;return{rows:[]};}
  if(sql==='ROLLBACK'){state.rolledBack++;return{rows:[]};}
  if(sql.startsWith('SELECT id FROM users'))return{rows:[{id:args[0]}]};
  if(sql.startsWith('SELECT *,day::text')){const a=state.sessions.filter(s=>!s.end_day_at).slice(-1);return{rows:a};}
  if(sql.startsWith('SELECT * FROM employee_day'))return{rows:[{require_closing:false,allow_skip:false,require_skip_reason:true,allow_multiple_starts:perEmployeeMulti,version:1}]};
  if(sql.includes('FROM crm_settings'))return{rows:[{lead_settings:{},location_settings:{allowMultipleDayStarts:globalMulti}}]};
  if(sql.startsWith('SELECT COALESCE(MAX(session_number)')){return{rows:[{max_session:Math.max(0,...state.sessions.map(s=>s.session_number)),ended_count:state.sessions.filter(s=>s.end_day_at).length}]};}
  if(sql.startsWith('INSERT INTO attendance')){state.sessions.push({id:'a'+(state.sessions.length+1),day:'2026-09-19',session_number:args[2],start_day_at:new Date(),end_day_at:null});return{rows:[]};}
  if(sql.startsWith('UPDATE salesman_profiles')){state.status=sql.includes("'online'")?'online':'offline';return{rows:[]};}
  if(sql.startsWith('INSERT INTO notifications')){state.notifications.push(args);return{rows:[]};}
  if(sql.startsWith('SELECT id FROM attendance'))return{rows:state.sessions.filter(s=>s.end_day_at).map(s=>({id:s.id}))};
  if(sql.startsWith('SELECT version FROM day_closing'))return{rows:[]};
  if(sql.startsWith('SELECT\n (SELECT count'))return{rows:[{leads:0,tasks:0,quotes:0,won:0}]};
  if(sql.startsWith('UPDATE attendance')){const s=state.sessions.find(x=>x.id===args[0]);s.end_day_at=new Date();return{rows:[]};}
  return{rows:[]};
 };
 return {state,query};
}
function install(f){db.query=f.query;db.pool.connect=async()=>({query:f.query,release(){}});}
const U='11111111-1111-4111-8111-111111111111';
const ended={id:'a1',day:'2026-09-19',session_number:1,start_day_at:new Date(),end_day_at:new Date()};

test('Start Day marks the employee online and logs a notification row',async()=>{
 const f=fakeDb();install(f);
 await dayClosing.startDay(U,{});
 assert.equal(f.state.status,'online');assert.equal(f.state.sessions.length,1);assert.equal(f.state.notifications.length,1);
});
test('a second Start Day after End Day is blocked when multiple cycles are OFF',async()=>{
 const f=fakeDb({sessions:[ended]});install(f);
 await assert.rejects(()=>dayClosing.startDay(U,{}),/already ended/);
 assert.equal(f.state.sessions.length,1);
});
test('per-employee "multiple Start/End cycles" switch is honoured',async()=>{
 const f=fakeDb({perEmployeeMulti:true,sessions:[ended]});install(f);
 await dayClosing.startDay(U,{});
 assert.equal(f.state.sessions.length,2);assert.equal(f.state.sessions[1].session_number,2);assert.equal(f.state.status,'online');
});
test('the company-wide Location Setting still works too',async()=>{
 const f=fakeDb({globalMulti:true,sessions:[ended]});install(f);
 await dayClosing.startDay(U,{});
 assert.equal(f.state.sessions.length,2);
});
test('Start Day on an already-active session re-asserts online status instead of silently doing nothing',async()=>{
 const f=fakeDb({sessions:[{id:'a1',day:'2026-09-19',session_number:1,start_day_at:new Date(),end_day_at:null}]});install(f);
 await dayClosing.startDay(U,{});
 assert.equal(f.state.status,'online');assert.equal(f.state.sessions.length,1);
});
test('End Day marks the employee offline',async()=>{
 const f=fakeDb({sessions:[{id:'a1',day:'2026-09-19',session_number:1,start_day_at:new Date(),end_day_at:null}]});install(f);
 await dayClosing.endDay(U,{mode:'none'});
 assert.equal(f.state.status,'offline');assert.ok(f.state.sessions[0].end_day_at);
});
test('admins are pushed on Start Day and End Day, using the day_activity preference',async()=>{
 const sent=[];
 const realQuery=db.query;
 const f=fakeDb();
 db.query=async(sql,args)=>{
  if(sql.includes("role = 'admin'"))return{rows:[{id:'22222222-2222-4222-8222-222222222222'}]};
  if(sql.startsWith('SELECT full_name FROM users'))return{rows:[{full_name:'Ravi'}]};
  if(sql.includes('FROM notification_preferences')){sent.push(sql);return{rows:[]};}
  if(sql.includes('FROM push_subscriptions'))return{rows:[]};
  return f.query(sql,args);
 };
 const r=await push.notifyDayEvent({userId:U,kind:'start',sessionNumber:2});
 assert.ok(sent.some(q=>q.includes('day_activity')),'must consult the day_activity preference');
 assert.deepEqual(r,{sent:0,failed:0}); // no device subscribed in this fake DB
 db.query=realQuery;
});
test('a push failure can never make Start Day fail',async()=>{
 const f=fakeDb();install(f);
 const orig=db.query;
 const r=await push.notifyDayEvent({userId:U,kind:'end'}); // getAdminIds hits the fake -> [] -> no throw
 assert.ok(r);db.query=orig;
});
