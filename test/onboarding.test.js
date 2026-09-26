const {test}=require('node:test');
const assert=require('node:assert/strict');
const db=require('../src/db');
const {signToken}=require('../src/utils/tokens');
const {validateSharing,validateTemplate,buildSummary,snapshotSteps,DEFAULT_SHARING}=require('../src/utils/onboarding');
const express=require('express');require('express-async-errors');
process.env.JWT_SECRET='onboarding-test-only';
const ids={admin:'11111111-1111-4111-8111-111111111111',sam:'22222222-2222-4222-8222-222222222222',other:'33333333-3333-4333-8333-333333333333',lead:'44444444-4444-4444-8444-444444444444'};
test('template validation and sharing gate reject missing/duplicate steps and redact internal data',()=>{
 assert.throws(()=>validateTemplate({version:1,steps:[]}));
 assert.throws(()=>validateSharing({...DEFAULT_SHARING,title:''}));
 assert.throws(()=>validateSharing({...DEFAULT_SHARING,intro:'Hello {secret}'}));
 assert.throws(()=>validateTemplate({version:1,steps:[{id:'s',title:'A'},{id:'s',title:'B'}]}));
 assert.throws(()=>validateTemplate({version:1,steps:[{id:'s',title:'  '}]}));
 assert.throws(()=>buildSummary({steps:[]}));
 assert.throws(()=>buildSummary({steps:[{done:false}]}));
 const summary=buildSummary({business_name:'Cafe',version:1,steps:[{title:'Training complete',done:true,completedAt:'2026-09-16T10:00:00.000Z',note:'Internal only',completedBy:ids.sam}]});
 assert.equal(JSON.stringify(summary).includes('Internal only'),false);assert.equal(JSON.stringify(summary).includes(ids.sam),false);
 assert.ok(summary.text.includes('Training complete'));
});
test('onboarding HTTP authorization, snapshots, revisions, progress, summary and PDF',async()=>{
 let template={sharing:DEFAULT_SHARING,version:1,steps:[{id:'setup',title:'Account setup'},{id:'training',title:'Staff training'}]},saved=null,won=true;const calls=[];
 const lead={id:ids.lead,business_name:'Dubai Darbar',contact_name:'Ahmed',phone:'9876543210',salesman_id:ids.sam,status:'won'};
 const query=async(sql,p=[])=>{calls.push([sql,p]);
 if(sql.startsWith('SELECT id FROM users'))return{rows:[{id:p[0]}]};
 if(sql.startsWith('SELECT id,business_name'))return{rows:p[1]&&p[1]!==ids.sam?[]:[{...lead,status:won?'won':'cold'}]};
 if(sql.startsWith('SELECT lead_id FROM customer_onboarding'))return{rows:saved?[{lead_id:ids.lead}]:[]};
 if(sql.startsWith('SELECT version,steps'))return{rows:[structuredClone(template)]};
 if(sql.startsWith('UPDATE onboarding_template')){if(p[1]!==template.version)return{rows:[]};template={version:template.version+1,steps:JSON.parse(p[0]),sharing:p[2]?JSON.parse(p[2]):template.sharing};return{rows:[structuredClone(template)]}}
 if(sql.startsWith('INSERT INTO customer_onboarding')){saved={lead_id:p[0],template_version:p[1],steps:JSON.parse(p[2]),version:1,share_token:null,share_enabled:false};return{rows:[]}}
 if(sql.startsWith('SELECT * FROM customer_onboarding'))return{rows:saved?[structuredClone(saved)]:[]};
 if(sql.startsWith('UPDATE customer_onboarding SET share_token=')){saved={...saved,share_token:p[1],share_enabled:true};return{rows:[]}}
 if(sql.startsWith('UPDATE customer_onboarding SET share_enabled=')){saved={...saved,share_enabled:true};return{rows:[]}}
 if(sql.startsWith('UPDATE customer_onboarding')){saved={...saved,steps:JSON.parse(p[1]),version:saved.version+1};return{rows:[structuredClone(saved)]}}
 if(sql.startsWith('SELECT c.*,tpl.sharing,'))return{rows:!saved||p[1]&&p[1]!==ids.sam?[]:[{...structuredClone(saved),sharing:template.sharing,...lead}]};
 if(sql.startsWith('SELECT l.id,l.business_name'))return{rows:[]};
 return{rows:[]};};
 db.query=query;db.pool.connect=async()=>({query,release(){}});
 const app=express();app.use(express.json());app.use('/onboarding',require('../src/routes/onboarding.routes'));app.use((e,q,r,n)=>r.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const req=async(user,path,method='GET',body)=>fetch(`http://127.0.0.1:${server.address().port}/onboarding${path}`,{method,headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+signToken({id:ids[user],role:user==='admin'?'admin':'salesman'})}:{})},...(body?{body:JSON.stringify(body)}:{})});
 try{
 assert.equal((await req(null,'/customers')).status,401);
 assert.equal((await req('sam','/template')).status,403);
 assert.equal((await req('sam','/template','PUT',{version:1,steps:template.steps})).status,403);
 assert.equal((await req('other','/'+ids.lead+'/start','POST')).status,404);
 won=false;assert.equal((await req('sam','/'+ids.lead+'/start','POST')).status,409);won=true;
 assert.equal((await req('sam','/'+ids.lead+'/start','POST')).status,200);assert.equal(saved.steps.length,2);
 assert.equal((await req('admin','/template','PUT',{version:1,steps:[{id:'new',title:'New template step'}],sharing:{title:'{restaurant} is live!',intro:'Hello {owner}, your setup is complete.',closing:'Thanks for choosing Swirl. Contact your account manager.'}})).status,200);
 assert.equal((await req('admin','/template','PUT',{version:1,steps:template.steps})).status,409);
 await req('sam','/'+ids.lead+'/start','POST');assert.equal(saved.steps.length,2);assert.equal(saved.template_version,1);
 assert.equal((await req('other','/'+ids.lead)).status,404);
 assert.equal((await req('admin','/'+ids.lead+'/summary')).status,409);
 assert.equal((await req('sam','/'+ids.lead+'/summary')).status,403);
 assert.equal((await req('sam','/'+ids.lead+'/pdf')).status,403);
 const update={version:1,done:true,note:'Private setup note'};
 assert.equal((await req('other','/'+ids.lead+'/steps/setup','PATCH',update)).status,404);
 assert.equal((await req('sam','/'+ids.lead+'/steps/setup','PATCH',update)).status,200);
 assert.equal(saved.steps[0].completedBy,ids.sam);
 assert.equal((await req('sam','/'+ids.lead+'/steps/setup','PATCH',update)).status,409);
 assert.equal((await req('admin','/'+ids.lead+'/pdf')).status,409);
 assert.equal((await req('admin','/'+ids.lead+'/steps/training','PATCH',{version:2,done:true,note:''})).status,200);
 const summaryRes=await req('admin','/'+ids.lead+'/summary');assert.equal(summaryRes.status,200);const summary=await summaryRes.json();assert.ok(summary.summary.text.includes('Dubai Darbar is live!'));assert.ok(summary.summary.text.includes('Hello Ahmed'));assert.equal(summary.summary.closing,'Thanks for choosing Swirl. Contact your account manager.');assert.ok(!summary.summary.text.includes('confirm a suitable')); assert.ok(!JSON.stringify(summary).includes('Private setup note'));
 const pdf=await req('admin','/'+ids.lead+'/pdf');assert.equal(pdf.status,200);assert.match(pdf.headers.get('content-type'),/application\/pdf/);const bytes=Buffer.from(await pdf.arrayBuffer());assert.equal(bytes.subarray(0,4).toString(),'%PDF');if(process.env.ONBOARDING_PDF_OUTPUT)require('fs').writeFileSync(process.env.ONBOARDING_PDF_OUTPUT,bytes);
 await req('sam','/customers?search=cafe');const list=calls.findLast(([s])=>s.startsWith('SELECT l.id,l.business_name'));assert.equal(list[1][0],ids.sam);assert.match(list[0],/LIMIT 31/);
 await req('sam','/'+ids.lead+'/steps/setup','PATCH',{version:3,done:false,note:''});assert.equal(saved.steps[0].completedAt,null);assert.equal((await req('admin','/'+ids.lead+'/summary')).status,409);
 }finally{await new Promise(r=>server.close(r));}
});
