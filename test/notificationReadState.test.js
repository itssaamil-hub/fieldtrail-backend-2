const {test}=require('node:test');
const assert=require('node:assert/strict');
const {getUnread,markRead}=require('../src/utils/notificationReadState');
const {localDate}=require('../src/utils/salesBriefing');
const admin={id:'11111111-1111-4111-8111-111111111111',role:'admin'};
const salesman={...admin,role:'salesman'};
test('admin unread count uses the event watermark and excludes no-op transitions',async()=>{
  const calls=[];const result=await getUnread(admin,async(sql,p)=>{calls.push([sql,p]);return {rows:[{count:3}]}});
  assert.deepEqual(result,{count:3,kind:'activity'});
  assert.match(calls[1][0],/IS DISTINCT FROM/);assert.match(calls[1][0],/activity_seen_id/);
  assert.equal(calls[1][1][0],admin.id);
});
test('salesman badge counts only today’s delivered, unseen briefing',async()=>{
  const calls=[];const result=await getUnread(salesman,async(sql,p)=>{calls.push([sql,p]);return {rows:[{count:1}]}});
  assert.deepEqual(result,{count:1,kind:'briefing'});
  assert.equal(calls[1][1][1],localDate());assert.match(calls[1][0],/briefing_seen_day IS DISTINCT FROM/);
});
test('salesmen cannot mark admin activity seen',async()=>{
  await assert.rejects(markRead(salesman,{kind:'activity',throughId:admin.id},async()=>assert.fail()),err=>err.status===403);
});
test('activity receipt advances only to a real event and never backwards',async()=>{
  const calls=[];await markRead(admin,{kind:'activity',throughId:admin.id},async(sql,p)=>{calls.push([sql,p]);return {rows:[]}});
  assert.match(calls[1][0],/FROM activity_logs/);assert.match(calls[1][0],/\(a.created_at, a.id\) > \(r.activity_seen_at, r.activity_seen_id\)/);
  assert.equal(calls[1][1][0],admin.id);
});
test('briefing receipt requires today and an existing delivery belonging to the viewer',async()=>{
  await assert.rejects(markRead(salesman,{kind:'briefing',day:'2000-01-01'},async()=>assert.fail()),err=>err.status===400);
  const calls=[];await markRead(salesman,{kind:'briefing',day:localDate()},async(sql,p)=>{calls.push([sql,p]);return {rows:[]}});
  assert.match(calls[1][0],/d.user_id = r.user_id/);assert.match(calls[1][0],/sales_briefing_deliveries/);
});
