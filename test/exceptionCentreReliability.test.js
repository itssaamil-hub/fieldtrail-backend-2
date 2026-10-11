const test=require('node:test');
const assert=require('node:assert/strict');
const {buildDetections,monthOnlyMatches}=require('../src/utils/exceptionDetection');

const rules={followup_enabled:true,cold_enabled:true,cold_stale_days:3,cold_critical_days:5,conversation_enabled:true,conversation_stale_days:3,conversation_critical_days:5,hot_enabled:true,hot_stale_days:3,hot_critical_days:5,negotiation_enabled:true,negotiation_stale_days:2,negotiation_critical_days:5,renewal_enabled:true,renewal_warning_days:7,tasks_enabled:true,payments_enabled:true,data_quality_enabled:false};

test('calendar-day overdue logic does not flag due-today and counts yesterday once',()=>{
 const detections=buildDetections({rules,today:'2026-10-02',leads:[
  {id:'a',business_name:'Due today',status:'conversation',phone:'1',next_follow_up_date:'2026-10-02',followup_days_overdue:0,age_days:0},
  {id:'b',business_name:'Yesterday',status:'conversation',phone:'1',next_follow_up_date:'2026-10-01',followup_days_overdue:1,age_days:0},
 ],tasks:[{id:'t1',title:'Today task',status:'pending',days_overdue:0},{id:'t2',title:'Yesterday task',status:'pending',days_overdue:1}],collections:[
  {key:'p1',customer_name:'Today payer',pending:100,days_overdue:0},{key:'p2',customer_name:'Late payer',pending:100,days_overdue:1},
 ]});
 assert.equal(detections.some(x=>x.entityId==='a'),false);
 assert.match(detections.find(x=>x.entityId==='b').reason,/1 day overdue/);
 assert.equal(detections.some(x=>x.entityId==='t1'),false);
 assert.match(detections.find(x=>x.entityId==='t2').reason,/1 day overdue/);
 assert.equal(detections.some(x=>x.entityId==='p1'),false);
 assert.match(detections.find(x=>x.entityId==='p2').reason,/1 day overdue/);
});

test('month-only renewal is flagged only for active prospects in the current month',()=>{
 assert.equal(monthOnlyMatches('October 2026','2026-10-02'),true);
 assert.equal(monthOnlyMatches('2026-10','2026-10-02'),true);
 assert.equal(monthOnlyMatches('October 2025','2026-10-02'),false);
 const detections=buildDetections({rules,today:'2026-10-02',tasks:[],collections:[],leads:[
  {id:'a',business_name:'Active',status:'hot',phone:'1',renewal_month:'October 2026',age_days:0},
  {id:'b',business_name:'Won',status:'won',phone:'1',renewal_month:'October 2026',age_days:0},
 ]});
 const renewal=detections.filter(x=>x.type==='renewal');
 assert.equal(renewal.length,1);
 assert.equal(renewal[0].entityId,'a');
 assert.equal(renewal[0].title,'Renewal expected this month');
 assert.equal(renewal[0].metadata.monthOnly,true);
});

test('completed tasks and fully paid accounts are not emitted',()=>{
 const detections=buildDetections({rules,today:'2026-10-02',leads:[],tasks:[{id:'done',title:'Done',status:'completed',days_overdue:5}],collections:[{key:'paid',customer_name:'Paid',pending:0,days_overdue:10}]});
 assert.equal(detections.length,0);
});


test('Cold and Conversation use the same warning and critical stale pattern as Hot',()=>{
 const detections=buildDetections({rules,today:'2026-10-12',tasks:[],collections:[],leads:[
  {id:'cold-warn',business_name:'Cold Warn',status:'cold',phone:'1',age_days:3},
  {id:'cold-critical',business_name:'Cold Critical',status:'cold',phone:'1',age_days:5},
  {id:'conversation-warn',business_name:'Conversation Warn',status:'conversation',phone:'1',age_days:4},
  {id:'conversation-critical',business_name:'Conversation Critical',status:'conversation',phone:'1',age_days:6},
  {id:'hot',business_name:'Hot Existing',status:'hot',phone:'1',age_days:3},
  {id:'neg',business_name:'Negotiation Existing',status:'negotiation',phone:'1',age_days:2},
 ]});
 const byId=id=>detections.find(x=>x.entityId===id && ['cold','conversation','hot','negotiation'].includes(x.type));
 assert.equal(byId('cold-warn').type,'cold');
 assert.equal(byId('cold-warn').severity,'high');
 assert.equal(byId('cold-critical').severity,'critical');
 assert.equal(byId('conversation-warn').type,'conversation');
 assert.equal(byId('conversation-warn').severity,'high');
 assert.equal(byId('conversation-critical').severity,'critical');
 assert.equal(byId('hot').type,'hot');
 assert.equal(byId('neg').type,'negotiation');
});
