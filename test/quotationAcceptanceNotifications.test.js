const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const quote='11111111-1111-4111-8111-111111111111';
function setup({owner='salesman',pushFails=false,commitFails=false,status='sent',revoked=false,expired=false,superseded=false}={}){
 const handlers={},pushes=[],alerts=[],calls=[];let response=null,committed=false;
 const row={id:'link',quote_id:quote,revision:1,current_revision:superseded?2:1,owner_id:owner,number:24,status,revoked_at:revoked?'yes':null,expires_at:expired?'2000-01-01':'2099-01-01',snapshot:{prefix:'SW-Q',customer:{name:'Cafe'},totalMinor:1200000,currency:'INR'}};
 const users=[{id:'admin',role:'admin',active:true},{id:'salesman',role:'salesman',active:true},{id:'inactive',role:'admin',active:false},{id:'other',role:'salesman',active:true}];
 const query=async(sql,p=[])=>{calls.push(sql);
  if(sql==='COMMIT'){if(commitFails)throw Error('commit failed');committed=true;return{rows:[]};}
  if(sql==='ROLLBACK'){response=null;alerts.length=0;return{rows:[]};}
  if(sql.includes('FROM quotation_public_links'))return{rows:[row]};
  if(sql.includes('FROM quotation_public_responses'))return{rows:response?[response]:[]};
  if(sql.includes('INSERT INTO quotation_public_responses')){response={action:p[2],customer_name:p[3],created_at:'now'};return{rows:[response]};}
  if(sql.includes('INSERT INTO quotation_alerts')){
   if(sql.includes('SELECT id')){assert.match(sql,/is_active=true AND \(role='admin' OR id=\$3\)/);assert.match(sql,/ON CONFLICT DO NOTHING RETURNING user_id/);const ids=users.filter(u=>u.active&&(u.role==='admin'||u.id===p[2])).map(u=>u.id);alerts.push(...ids);return{rows:ids.map(user_id=>({user_id}))};}
   alerts.push(p[0]);
  }
  return{rows:[]};
 };
 const router={use(){},get(){},post(path,handler){handlers[path]=handler;}};
 const deps={express:{Router:()=>router},'../db':{pool:{connect:async()=>({query,release(){}})}},'../utils/quotations':{bad:(m,status=400)=>Object.assign(Error(m),{status}),str:(v)=>v||'',number:(q,s)=>s.prefix+'-'+String(q.number).padStart(5,'0'),money:(n,c)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:c}).format(n/100)},'../utils/publicQuotation':{parsePublicQuoteToken:()=> 'link'},'../utils/businessProfile':{},'../utils/pushNotifications':{notifyUsers:async(ids,key,payload)=>{assert.equal(committed,true);pushes.push({ids,key,payload});if(pushFails)throw Error('push down');}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/routes/publicQuotation.routes.js'),'utf8'),{require:n=>{if(!(n in deps))throw Error(n);return deps[n];},module:{exports:{}},console:{error(){}},Date,Map,encodeURIComponent});
 return {pushes,alerts,calls,async accept(action='accepted'){let result;await handlers['/:token/respond']({params:{token:'token'},body:{action,customerName:'Customer',message:'Please revise'},ip:'test',get:()=>''},{json:v=>result=v});return result;}};
}
test('acceptance stores admin and owner alerts then pushes once with quote destination',async()=>{const h=setup();assert.equal((await h.accept()).idempotent,false);assert.deepEqual(h.alerts,['admin','salesman']);assert.equal(h.pushes.length,1);assert.equal(h.pushes[0].payload.url,'/#quotation='+quote);assert.match(h.pushes[0].payload.body,/Cafe accepted SW-Q-00024/);assert.match(h.pushes[0].payload.body,/12,000/);assert.equal((await h.accept()).idempotent,true);assert.equal(h.pushes.length,1);assert.equal(h.alerts.length,2);});
test('admin-owned quotation receives one alert; inactive owner is excluded',async()=>{for(const owner of ['admin','inactive',null]){const h=setup({owner});await h.accept();assert.deepEqual(h.alerts,['admin']);}});
test('push failure leaves successful acceptance and bell alerts; retry does not duplicate',async()=>{const h=setup({pushFails:true});assert.equal((await h.accept()).action,'accepted');assert.equal(h.alerts.length,2);await h.accept();assert.equal(h.pushes.length,1);});
test('failed commit never sends push',async()=>{const h=setup({commitFails:true});await assert.rejects(h.accept(),/commit failed/);assert.equal(h.pushes.length,0);assert.equal(h.alerts.length,0);});
test('closed, expired, revoked and superseded quotes do not notify',async()=>{for(const options of [{status:'accepted'},{revoked:true},{expired:true},{superseded:true}]){const h=setup(options);await assert.rejects(h.accept());assert.equal(h.pushes.length,0);assert.equal(h.alerts.length,0);}});
test('changes-requested behavior remains owner-only without acceptance push',async()=>{const h=setup();await h.accept('changes_requested');assert.deepEqual(h.alerts,['salesman']);assert.equal(h.pushes.length,0);});
