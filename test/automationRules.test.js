const test = require('node:test');
const assert = require('node:assert/strict');
const { inactiveRuleFrom, inactiveDaysFrom, decorateLeadsWithInactivity, runInactiveLeadNotifications, INACTIVE_PUSH_RULE_KEY } = require('../src/utils/automationRules');

test('inactive rule defaults safely and validates inactivity days', () => {
  const defaults = ["cold","conversation","hot","demo","negotiation","nurture"];
  assert.deepEqual(inactiveRuleFrom({ lead_settings: {} }), { enabled:false, inactivityDays:5, stages:defaults });
  assert.deepEqual(inactiveRuleFrom({ lead_settings:{ automationRules:{ inactiveLeadFollowUp:{ enabled:true, inactivityDays:12, stages:["hot","won"] } } } }), { enabled:true, inactivityDays:12, stages:["hot","won"] });
  assert.deepEqual(inactiveRuleFrom({ lead_settings:{ automationRules:{ inactiveLeadFollowUp:{ enabled:true, inactivityDays:0, stages:["bogus"] } } } }), { enabled:true, inactivityDays:5, stages:defaults });
});

test('inactive day calculation is whole elapsed days', () => {
  const now = new Date('2026-10-12T00:00:00.000Z');
  assert.equal(inactiveDaysFrom('2026-10-07T00:00:00.000Z', now), 5);
  assert.equal(inactiveDaysFrom('2026-10-07T12:00:00.000Z', now), 4);
  assert.equal(inactiveDaysFrom(null, now), null);
});

test('disabled inactivity rule returns no badge state and performs no activity query', async () => {
  let queried = false;
  const rows = [{ id:'11111111-1111-4111-8111-111111111111', status:'hot', updated_at:'2026-10-01T00:00:00.000Z' }];
  const database = { query: async () => { queried = true; throw new Error('should not query'); } };
  const result = await decorateLeadsWithInactivity(rows, {
    database,
    settings:{ lead_settings:{ automationRules:{ inactiveLeadFollowUp:{ enabled:false, inactivityDays:5, stages:["hot"] } } } },
  });
  assert.equal(result[0].inactive_days, null);
  assert.equal(result[0].inactive_since, null);
  assert.equal(queried, false);
});

test('selected inactive stage receives factual badge state without creating tasks', async () => {
  const leadId='11111111-1111-4111-8111-111111111111';
  const calls=[];
  const database={
    async query(sql, params){
      calls.push({sql,params});
      return { rows:[{ lead_id:leadId, last_activity_at:'2026-10-06T00:00:00.000Z' }] };
    }
  };
  const result=await decorateLeadsWithInactivity([
    { id:leadId, status:'hot', created_at:'2026-10-01T00:00:00.000Z', updated_at:'2026-10-01T00:00:00.000Z' }
  ],{
    database,
    now:new Date('2026-10-12T00:00:00.000Z'),
    settings:{ lead_settings:{ automationRules:{ inactiveLeadFollowUp:{ enabled:true, inactivityDays:5, stages:["hot"] } } } },
  });
  assert.equal(result[0].inactive_days,6);
  assert.equal(result[0].inactive_since,'2026-10-06T00:00:00.000Z');
  assert.equal(calls.length,1);
  assert.ok(calls[0].sql.includes("FROM activity_logs"));
  assert.equal(calls.some(c=>c.sql.includes("crm_tasks")),false);
  assert.equal(calls.some(c=>c.sql.includes("task_notifications")),false);
});

test('unselected stage and recently active lead receive no inactivity badge', async () => {
  const hotId='11111111-1111-4111-8111-111111111111';
  const wonId='22222222-2222-4222-8222-222222222222';
  const database={
    async query(){
      return { rows:[{ lead_id:hotId, last_activity_at:'2026-10-10T00:00:00.000Z' }] };
    }
  };
  const result=await decorateLeadsWithInactivity([
    { id:hotId, status:'hot', created_at:'2026-10-01T00:00:00.000Z', updated_at:'2026-10-01T00:00:00.000Z' },
    { id:wonId, status:'won', created_at:'2026-09-01T00:00:00.000Z', updated_at:'2026-09-01T00:00:00.000Z' },
  ],{
    database,
    now:new Date('2026-10-12T00:00:00.000Z'),
    settings:{ lead_settings:{ automationRules:{ inactiveLeadFollowUp:{ enabled:true, inactivityDays:5, stages:["hot"] } } } },
  });
  assert.equal(result[0].inactive_days,null);
  assert.equal(result[1].inactive_days,null);
});


test('inactive push is sent once per inactivity episode and opens the lead Brief', async () => {
  const leadId='11111111-1111-4111-8111-111111111111';
  let anchor='2026-10-06T00:00:00.000Z';
  const claims=new Set();
  const sent=[];
  const database={
    async query(sql,params){
      if(sql.includes('FROM leads')) return {rows:[{id:leadId,business_name:'Cafe 91',salesman_id:'22222222-2222-4222-8222-222222222222',status:'hot',created_at:'2026-10-01T00:00:00.000Z',updated_at:'2026-10-01T00:00:00.000Z'}]};
      if(sql.includes('FROM activity_logs')) return {rows:[{lead_id:leadId,last_activity_at:anchor}]};
      if(sql.startsWith('INSERT INTO automation_rule_runs')){
        const key=params.join('|');
        if(claims.has(key)) return {rows:[]};
        claims.add(key); return {rows:[{rule_key:INACTIVE_PUSH_RULE_KEY}]};
      }
      if(sql.startsWith('DELETE FROM automation_rule_runs')) { claims.delete(params.join('|')); return {rows:[]}; }
      throw new Error('Unexpected SQL: '+sql);
    }
  };
  const settings={lead_settings:{automationRules:{inactiveLeadFollowUp:{enabled:true,inactivityDays:5,stages:['hot']}}}};
  const notify=async(userIds,prefKey,payload)=>{
    sent.push({userIds,prefKey,payload});
    return {requestedUsers:1,eligibleUsers:1,subscribedUsers:1,subscribedDevices:1,preferenceDisabledUsers:0,sent:1,failed:0};
  };
  const first=await runInactiveLeadNotifications({database,settings,notify,now:new Date('2026-10-12T00:00:00.000Z')});
  const repeat=await runInactiveLeadNotifications({database,settings,notify,now:new Date('2026-10-13T00:00:00.000Z')});
  assert.equal(first.notified,1);
  assert.equal(repeat.notified,0);
  assert.equal(sent.length,1);
  assert.equal(sent[0].prefKey,'inactive_lead');
  assert.equal(sent[0].payload.title,'Cafe 91 needs attention');
  assert.equal(sent[0].payload.body,'No activity for 6 days.');
  assert.equal(sent[0].payload.url,'/#lead='+leadId);

  anchor='2026-10-13T03:00:00.000Z';
  const nextEpisode=await runInactiveLeadNotifications({database,settings,notify,now:new Date('2026-10-19T03:00:00.000Z')});
  assert.equal(nextEpisode.notified,1);
  assert.equal(sent.length,2);
});

test('inactive push claim is released when nothing is delivered so a later day can retry', async () => {
  const leadId='33333333-3333-4333-8333-333333333333';
  const anchor='2026-10-01T00:00:00.000Z';
  let claimed=false,attempts=0;
  const database={
    async query(sql,params){
      if(sql.includes('FROM leads')) return {rows:[{id:leadId,business_name:'No Device',salesman_id:'44444444-4444-4444-8444-444444444444',status:'conversation',created_at:anchor,updated_at:anchor}]};
      if(sql.includes('FROM activity_logs')) return {rows:[{lead_id:leadId,last_activity_at:anchor}]};
      if(sql.startsWith('INSERT INTO automation_rule_runs')){
        if(claimed) return {rows:[]}; claimed=true; return {rows:[{rule_key:INACTIVE_PUSH_RULE_KEY}]};
      }
      if(sql.startsWith('DELETE FROM automation_rule_runs')) { claimed=false; return {rows:[]}; }
      throw new Error('Unexpected SQL: '+sql);
    }
  };
  const settings={lead_settings:{automationRules:{inactiveLeadFollowUp:{enabled:true,inactivityDays:5,stages:['conversation']}}}};
  const notify=async()=>{attempts++;return {requestedUsers:1,eligibleUsers:1,subscribedUsers:0,subscribedDevices:0,preferenceDisabledUsers:0,sent:0,failed:0};};
  const a=await runInactiveLeadNotifications({database,settings,notify,now:new Date('2026-10-12T00:00:00.000Z')});
  const b=await runInactiveLeadNotifications({database,settings,notify,now:new Date('2026-10-13T00:00:00.000Z')});
  assert.equal(a.deferred,1);
  assert.equal(b.deferred,1);
  assert.equal(attempts,2);
});
