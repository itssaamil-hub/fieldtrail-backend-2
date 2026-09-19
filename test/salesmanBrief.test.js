const {test}=require('node:test'),assert=require('node:assert/strict');
const {getSalesmanBrief,validDay}=require('../src/utils/salesmanBrief');
const U='11111111-1111-4111-8111-111111111111';
const at=(h,m=0)=>new Date(Date.UTC(2026,8,19,h,m));
function fake(rows){return async(sql,args)=>{
 if(sql.includes("FROM users u WHERE"))return{rows:rows.user===null?[]:[{id:args[0],full_name:'Ravi'}]};
 if(sql.includes('FROM attendance'))return{rows:rows.sessions||[]};
 if(sql.includes('FROM activity_logs'))return{rows:rows.logs||[]};
 if(sql.includes('FROM visits'))return{rows:rows.visits||[]};
 if(sql.includes('FROM quotation_events'))return{rows:rows.quotes||[]};
 if(sql.includes('FROM lead_payments'))return{rows:rows.payments||[]};
 if(sql.includes('FROM day_closing_reports'))return{rows:rows.closing||[]};
 throw Error('unexpected query '+sql.slice(0,40));};}
test('validDay rejects malformed and impossible dates',()=>{assert.ok(validDay('2026-09-19'));for(const v of ['2026-9-19','2026-02-30','abc',''])assert.equal(validDay(v),false);});
test('unknown employee is a 404',async()=>{await assert.rejects(()=>getSalesmanBrief(fake({user:null}),U,'2026-09-19'),e=>e.status===404);});
test('brief merges sessions, leads, visits, quotes and payments in time order with counts',async()=>{
 const b=await getSalesmanBrief(fake({
  sessions:[{session_number:1,start_day_at:at(4),end_day_at:at(12),total_distance_m:12345}],
  logs:[{action:'lead.created',at:at(5),business:'Acme'},{action:'lead.status_changed',at:at(8),business:'Acme',from_status:'hot',to_status:'won'},{action:'task.completed',at:at(9),task_title:'Call Bob'}],
  visits:[{business_name:'Zed Stores',arrived_at:at(6),left_at:at(7)}],
  quotes:[{action:'sent',at:at(10),business:'Acme',number:42}],
  payments:[{amount:'5000',at:at(11),business:'Acme'}],
  closing:[{session_number:1,status:'submitted',outcomes:'Good day',blockers:'',priorities:'Follow up',skip_reason:''}],
 }),U,'2026-09-19');
 assert.deepEqual(b.summary,{leadsAdded:1,statusChanges:1,won:1,visits:1,quotes:1,tasksDone:1,payments:1,distanceKm:12.3});
 assert.deepEqual(b.events.map(e=>e.type),['day','lead','visit','lead','task','quote','payment','day']);
 assert.equal(b.events[0].text,'Started the day');assert.match(b.events[3].text,/Moved Acme from Hot to Won/);
 assert.match(b.events[5].text,/Quotation #42 for Acme marked sent/);assert.equal(b.closing[0].status,'submitted');
});
test('an employee who did nothing gets an empty brief, not an error',async()=>{
 const b=await getSalesmanBrief(fake({}),U,'2026-09-19');assert.equal(b.events.length,0);assert.equal(b.summary.leadsAdded,0);
});
test('multiple sessions are labelled',async()=>{
 const b=await getSalesmanBrief(fake({sessions:[{session_number:1,start_day_at:at(4),end_day_at:at(6)},{session_number:2,start_day_at:at(8),end_day_at:null}]}),U,'2026-09-19');
 assert.deepEqual(b.events.map(e=>e.text),['Started the day (session 1)','Ended the day (session 1)','Started the day (session 2)']);
});
