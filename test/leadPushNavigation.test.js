const {test}=require('node:test'),assert=require('node:assert/strict');
const db=require('../src/db'),webpush=require('web-push');
test('status and renewal/follow-up pushes carry the exact lead Brief destination',async()=>{
 const keys=webpush.generateVAPIDKeys();process.env.VAPID_PUBLIC_KEY=keys.publicKey;process.env.VAPID_PRIVATE_KEY=keys.privateKey;
 const originalQuery=db.query,originalSend=webpush.sendNotification;
 const user='11111111-1111-4111-8111-111111111111',lead='22222222-2222-4222-8222-222222222222',sent=[];
 db.query=async sql=>{
  if(sql.includes("role = 'admin'"))return{rows:[{id:user}]};
  if(sql.includes('FROM notification_preferences'))return{rows:[]};
  if(sql.includes('FROM push_subscriptions'))return{rows:[{id:'sub',user_id:user,endpoint:'https://example.invalid',p256dh:'key',auth:'auth'}]};
  if(sql.includes('FROM leads WHERE'))return{rows:[{id:lead,business_name:'Cafe',salesman_id:user}]};
  throw Error('Unexpected SQL: '+sql);
 };
 webpush.sendNotification=async(sub,body)=>{sent.push(JSON.parse(body));};
 try{
  const push=require('../src/utils/pushNotifications');
  await push.notifyStatusChange({id:lead,salesman_id:user,status:'hot',business_name:'Cafe'});
  await push.notifyStatusChange({id:lead,salesman_id:user,status:'demo',business_name:'Cafe'});
  await push.runDailyReminders();assert.equal(sent.length,6);
  for(const payload of sent)assert.equal(payload.url,'/#lead='+lead);
 }finally{db.query=originalQuery;webpush.sendNotification=originalSend;}
});
