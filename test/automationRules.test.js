const test = require('node:test');
const assert = require('node:assert/strict');
const { inactiveRuleFrom, inactiveDaysFrom, decorateLeadsWithInactivity } = require('../src/utils/automationRules');

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
