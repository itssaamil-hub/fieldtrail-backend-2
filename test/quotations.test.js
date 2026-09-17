const {test}=require('node:test'),assert=require('node:assert/strict');
const {validateConfig,buildSnapshot,canShare,runQuotationReminders}=require('../src/utils/quotations');
const ids={admin:'11111111-1111-4111-8111-111111111111',sam:'22222222-2222-4222-8222-222222222222',other:'33333333-3333-4333-8333-333333333333',quote:'44444444-4444-4444-8444-444444444444',pack:'55555555-5555-4555-8555-555555555555',addon:'66666666-6666-4666-8666-666666666666',lead:'77777777-7777-4777-8777-777777777777'};
const config={company:'Swirl',prefix:'SW-Q',currency:'INR',logo:'',packages:[{id:ids.pack,name:'Essential',price:10000,period:'yearly',features:'POS billing, QR menu, inventory, reports and staff training'}],addons:[{id:ids.addon,name:'Installation',price:1500,period:'one_time'}],discountLimit:10,validDays:15,advancePercent:100,taxPercent:0,terms:'Payment before activation. Renewal at agreed annual rate.',footer:'Thank you for choosing Swirl.',whatsapp:'Hello {restaurant}, quote {quote}: {total}, valid until {expiry}.'};
const body={settingsVersion:1,customer:{name:'Dubai Darbar',contact:'Ahmed',phone:'919876543210'},packageId:ids.pack,addonIds:[ids.addon],discount:15,reason:'Annual payment',followUp:'2026-09-19'};
test('server prices, integer money, settings validation and sharing gates',()=>{const c=validateConfig(config),s=buildSnapshot(c,{...body,totalMinor:1,price:1},body.customer);assert.equal(s.totalMinor,1000000);assert.equal(s.discountMinor,150000);assert.throws(()=>validateConfig({...config,discountLimit:101}));assert.throws(()=>validateConfig({...config,logo:'data:image/png;base64,aaa='}));assert.throws(()=>validateConfig({...config,packages:[config.packages[0],config.packages[0]]}));assert.throws(()=>buildSnapshot(c,{...body,discount:101},body.customer));assert.throws(()=>buildSnapshot(c,{...body,reason:''},body.customer));assert.throws(()=>buildSnapshot(c,{...body,addonIds:['bad']},body.customer));assert.throws(()=>canShare({status:'pending_approval',expires_on:'2099-01-01'}));assert.throws(()=>canShare({status:'ready',expires_on:'2000-01-01'}));assert.doesNotThrow(()=>canShare({status:'ready',expires_on:'2099-01-01'}));const taxed=buildSnapshot({...c,taxPercent:18},{...body,discount:10},body.customer);assert.equal(taxed.totalMinor,1239000);});
test('quotation HTTP authorization, approval, immutable revisions, response and PDF',async()=>{
 process.env.JWT_SECRET='quotation-test-only';const db=require('../src/db'),{signToken}=require('../src/utils/tokens');let settings={version:1,config:structuredClone(config)},q=null,revs=[],events=[],tx;const calls=[];
 const query=async(sql,p=[])=>{calls.push(sql);
 if(sql==='BEGIN'){tx=structuredClone({q,revs,events});return{rows:[]}}if(sql==='ROLLBACK'){({q,revs,events}=tx);return{rows:[]}}if(sql==='COMMIT')return{rows:[]};
 if(sql.startsWith('SELECT id FROM users'))return{rows:[{id:p[0]}]};
 if(sql.startsWith('SELECT version,config'))return{rows:[structuredClone(settings)]};
 if(sql.startsWith('UPDATE quotation_settings')){if(settings.version!==p[1])return{rows:[]};settings={config:JSON.parse(p[0]),version:settings.version+1};return{rows:[structuredClone(settings)]}}
 if(sql.startsWith('INSERT INTO quotations(')){q={id:ids.quote,number:'24',owner_id:p[0],lead_id:p[1],current_revision:1};revs=[];return{rows:[{...q}]}}
 if(sql.startsWith('SELECT * FROM quotations'))return{rows:q&&q.id===p[0]&&(!p[1]||p[1]===q.owner_id)?[{...q}]:[]};
 if(sql.startsWith('SELECT business_name'))return{rows:p[0]===ids.lead&&(!p[1]||p[1]===ids.sam)?[{business_name:'Assigned cafe',contact_name:'Owner',phone:'919876543210'}]:[]};
 if(sql.startsWith('INSERT INTO quotation_revisions')){revs.push({quote_id:p[0],revision:p[1],version:1,snapshot:JSON.parse(p[2]),status:p[3],follow_up:p[4],expires_on:p[5],created_by:p[6]});return{rows:[]}}
 if(sql.startsWith('SELECT *,expires_on'))return{rows:revs.filter(r=>r.quote_id===p[0]&&r.revision===p[1]).map(r=>structuredClone(r))};
 if(sql.startsWith('UPDATE quotations SET current_revision')){q.current_revision=p[1];return{rows:[]}}
 if(sql.startsWith('UPDATE quotation_revisions SET')){const r=revs.find(r=>r.revision===p[1]);r.status=p[2];r.follow_up=p[3];r.version++;return{rows:[]}}
 if(sql.startsWith('SELECT 1 FROM quotation_revisions'))return{rows:revs.some(r=>r.sent_at||['sent','accepted','rejected'].includes(r.status))?[{exists:1}]:[]};
 if(sql.startsWith('DELETE FROM quotations')){q=null;revs=[];events=[];return{rows:[]}}
 if(sql.startsWith('SELECT revision,status'))return{rows:structuredClone(revs)};
 if(sql.startsWith('SELECT e.*'))return{rows:structuredClone(events)};
 if(sql.startsWith('INSERT INTO quotation_events')){events.push({quote_id:p[0],revision:p[1],action:p[3],note:p[4]});return{rows:[]}}
 return{rows:[]};};
 db.query=query;db.pool.connect=async()=>({query,release(){}});const express=require('express');require('express-async-errors');const app=express();app.use(express.json());app.use('/quotations',require('../src/routes/quotations.routes'));app.use((e,req,res,next)=>res.status(500).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const request=async(user,path='',method='GET',b)=>fetch(`http://127.0.0.1:${server.address().port}/quotations${path}`,{method,headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+signToken({id:ids[user],role:user==='admin'?'admin':'salesman'})}:{})},...(b?{body:JSON.stringify(b)}:{})});
 const act=(user,action,version=1,revision=1)=>request(user,'/'+ids.quote+'/action','POST',{action,version,revision,note:''});
 try{
 assert.equal((await request(null,'/settings')).status,401);assert.equal((await request('sam','/settings','PUT',{version:1,config})).status,403);
 assert.equal((await request('sam','','POST',{...body,leadId:ids.other})).status,404);assert.equal(q,null);
 assert.equal((await request('sam','','POST',body)).status,201);assert.equal(revs[0].status,'pending_approval');assert.equal(revs[0].snapshot.totalMinor,1000000);
 assert.equal((await request('other','/'+ids.quote)).status,404);assert.equal((await request('other','/'+ids.quote+'/pdf')).status,404);
 assert.equal((await request('sam','/'+ids.quote+'/pdf')).status,409);assert.equal((await request('sam','/'+ids.quote+'/summary')).status,409);assert.equal((await act('sam','approve')).status,403);assert.equal((await act('sam','sent')).status,409);
 assert.equal((await act('admin','approve')).status,200);assert.equal((await act('admin','approve')).status,409);
 const summary=await(await request('sam','/'+ids.quote+'/summary')).json();assert.match(summary.text,/10,000/);assert.ok(!summary.text.includes('Annual payment'));
 const pdf=await request('sam','/'+ids.quote+'/pdf');assert.equal(pdf.status,200);const bytes=Buffer.from(await pdf.arrayBuffer());assert.equal(bytes.subarray(0,4).toString(),'%PDF');if(process.env.QUOTATION_PDF_OUTPUT)require('fs').writeFileSync(process.env.QUOTATION_PDF_OUTPUT,bytes);
 assert.equal((await act('sam','accepted',2)).status,409);assert.equal((await act('sam','sent',2)).status,200);assert.equal((await act('sam','accepted',3)).status,200);
 const updated={...config,packages:[{...config.packages[0],price:12000}]};assert.equal((await request('admin','/settings','PUT',{version:1,config:updated})).status,200);assert.equal(revs[0].snapshot.package.price,10000);
 assert.equal((await request('sam','/'+ids.quote+'/revise','POST',{...body,currentRevision:1})).status,409);assert.equal(q.current_revision,1);
 assert.equal((await request('sam','/'+ids.quote+'/revise','POST',{...body,settingsVersion:2,currentRevision:1,discount:5})).status,201);assert.equal(revs[1].snapshot.package.price,12000);assert.equal(revs[0].snapshot.package.price,10000);assert.equal(q.current_revision,2);
 assert.equal((await act('sam','sent',4,1)).status,409);assert.equal((await request('sam','/'+ids.quote+'/pdf?revision=1')).status,200);
 assert.equal((await request('sam','?from=2026-09-30&to=2026-09-01')).status,400);
 assert.equal((await request('sam','?from=2026-02-30')).status,400);
 assert.equal((await request('sam','?from=2026-09-01&to=2026-09-30')).status,200);
 assert.ok(calls.some(s=>s.includes("q.created_at >= ($5::date::timestamp AT TIME ZONE 'Asia/Kolkata')")&&s.includes("($6::date+1)")));
 assert.equal((await request('other','/'+ids.quote,'DELETE',{revision:2,version:1})).status,404);
 assert.equal((await request('sam','/'+ids.quote,'DELETE',{revision:2,version:1})).status,403);
 assert.equal((await request('admin','/'+ids.quote,'DELETE',{revision:1,version:1})).status,409);
 assert.equal((await request('admin','/'+ids.quote,'DELETE',{revision:2,version:1})).status,200);assert.equal(q,null);
 assert.equal((await request('sam','','POST',{...body,settingsVersion:2,discount:0})).status,201);
 assert.equal((await request('sam','/'+ids.quote,'DELETE',{revision:1,version:1})).status,200);assert.equal(q,null);
 assert.ok(calls.some(s=>s.includes('FOR UPDATE')));assert.ok(!calls.some(s=>s.startsWith('UPDATE leads')));
 await runQuotationReminders(query);assert.ok(calls.some(s=>s.includes('ON CONFLICT(user_id,quote_id,revision,kind,day) DO NOTHING')));
 }finally{await new Promise(r=>server.close(r));}
});
