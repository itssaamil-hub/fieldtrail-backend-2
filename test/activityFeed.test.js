const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { decodeCursor, formatActivity, getActivityFeed } = require('../src/utils/activityFeed');
const id = '11111111-1111-4111-8111-111111111111';
const time = '2026-09-16T05:10:03.123456Z';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
test('cursor preserves microseconds and rejects malformed and impossible dates', () => {
  assert.deepEqual(decodeCursor(encode({ id, time })), { id, time });
  for (const value of ['', ['x'], 'bad!', encode({ id, time:'2026-02-31T05:10:03.123456Z' }), encode({ id:'invalid',time })]) {
    assert.throws(() => decodeCursor(value), error => error.status === 400);
  }
});
test('activity explains actual actor and transition; no raw metadata returned', () => {
  const entry = formatActivity({ id, action:'lead.status_changed', actor_name:'Anand',business_name:'Maple Café',from_status:'conversation',to_status:'hot',event_time:time,metadata:{password:'not-for-output'} });
  assert.equal(entry.description,'Anand moved Maple Café from Conversation to Hot.');
  assert.equal(entry.toStatus,'hot');
  assert.equal(JSON.stringify(entry).includes('not-for-output'),false);
});
test('removed actors/leads have honest fallbacks', () => {
  const entry = formatActivity({ id, action:'lead.edited',event_time:time });
  assert.equal(entry.description,'Former user updated a removed lead.');
});
test('feed is bounded and keyset pagination uses exact last timestamp and id', async () => {
  let params;
  const rows = Array.from({length:31},(_,n)=>({id:`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`,event_time:time,action:'lead.created',actor_name:'Anand',business_name:'Café'}));
  const first=await getActivityFeed(undefined,async(sql,p)=>{params=p;assert.match(sql,/LIMIT 31/);assert.match(sql,/IS DISTINCT FROM/);assert.doesNotMatch(sql,/SELECT a\.\*/);return {rows}});
  assert.equal(first.activities.length,30);
  assert.deepEqual(decodeCursor(first.nextCursor),{id:rows[29].id,time});
  await getActivityFeed(first.nextCursor,async(sql,p)=>{assert.equal(p[1],time);assert.equal(p[2],rows[29].id);return {rows:[]}});
  assert.equal(params[1],null);
});
test('empty feed has no continuation cursor', async () => {
  assert.deepEqual(await getActivityFeed(undefined,async()=>({rows:[]})),{activities:[],nextCursor:null});
});
test('activity endpoint requires authentication, denies salesmen, allows admins', async () => {
  const routes = [], middleware = [];
  const actualAuth = require('../src/middleware/auth');
  const router = { post(){},patch(){},delete(){},get(path,...handlers){routes.push({path,handlers})},use(fn){middleware.push(fn)} };
  const context = {module:{exports:{}},require:name=>{
    if(name==='express')return {Router:()=>router};
    if(name==='../middleware/auth')return actualAuth;
    if(name==='../utils/activityFeed')return {getActivityFeed:async()=>({activities:[],nextCursor:null})};
    return {};
  }};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/routes/notifications.routes'),'utf8'),context);
  const route=routes.find(r=>r.path==='/activity');
  let status=200, body;
  const res={status(value){status=value;return this},json(value){body=value;return this}};
  middleware[0]({headers:{},query:{}},res,()=>assert.fail('Unauthenticated access allowed'));
  assert.equal(status,401);
  route.handlers[0]({user:{role:'salesman'}},res,()=>assert.fail('Salesman access allowed'));
  assert.equal(status,403);
  status=200;
  let allowed=false;route.handlers[0]({user:{role:'admin'}},res,()=>allowed=true);
  assert.equal(allowed,true);await route.handlers[1]({query:{}},res);assert.equal(body.activities.length,0);
});
