const test = require('node:test');
const assert = require('node:assert/strict');
const { inactiveRuleFrom, runInactiveLeadFollowUpAutomation } = require('../src/utils/automationRules');

test('inactive rule defaults safely and validates inactivity days', () => {
  const defaults = ["cold","conversation","hot","demo","negotiation","nurture"];
  assert.deepEqual(inactiveRuleFrom({ lead_settings: {} }), { enabled:false, inactivityDays:5, stages:defaults });
  assert.deepEqual(inactiveRuleFrom({ lead_settings:{ automationRules:{ inactiveLeadFollowUp:{ enabled:true, inactivityDays:12, stages:["hot","won"] } } } }), { enabled:true, inactivityDays:12, stages:["hot","won"] });
  assert.deepEqual(inactiveRuleFrom({ lead_settings:{ automationRules:{ inactiveLeadFollowUp:{ enabled:true, inactivityDays:0, stages:["bogus"] } } } }), { enabled:true, inactivityDays:5, stages:defaults });
});

test('disabled inactive-lead automation performs no database work', async () => {
  let queried = false;
  const database = { query: async () => { queried = true; throw new Error('should not query'); } };
  const result = await runInactiveLeadFollowUpAutomation({
    database,
    settings:{ lead_settings:{ automationRules:{ inactiveLeadFollowUp:{ enabled:false, inactivityDays:5, stages:["cold"] } } } },
  });
  assert.deepEqual(result, { enabled:false, created:0, eligible:0 });
  assert.equal(queried, false);
});

test('inactive-lead automation creates one linked task and notification for a claimed episode', async () => {
  const lead = { id:'11111111-1111-4111-8111-111111111111', business_name:'Cafe 91', salesman_id:'22222222-2222-4222-8222-222222222222', last_activity_at:'2026-10-01T00:00:00.000Z' };
  const calls = [];
  const client = {
    async query(sql, params=[]) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO automation_rule_runs')) return { rows:[{rule_key:'inactive-lead-follow-up'}] };
      if (sql.includes("AS due_at")) return { rows:[{ due_at:'2026-10-11T18:29:00.000Z' }] };
      if (sql.includes('INSERT INTO crm_tasks')) return { rows:[{ id:'33333333-3333-4333-8333-333333333333' }] };
      return { rows:[] };
    },
    release() {},
  };
  const database = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows:[lead] };
    },
    pool:{ async connect(){ return client; } },
  };
  const result = await runInactiveLeadFollowUpAutomation({
    database,
    settings:{ lead_settings:{ automationRules:{ inactiveLeadFollowUp:{ enabled:true, inactivityDays:5, stages:["cold","hot"] } } } },
  });
  assert.equal(result.created, 1);
  assert.equal(result.eligible, 1);
  assert.ok(calls.some(c => c.sql.includes('l.status::text = ANY($2::text[])') && JSON.stringify(c.params[1]) === JSON.stringify(["cold","hot"])));
  assert.ok(calls.some(c => c.sql.includes('INSERT INTO crm_tasks') && c.params[0] === 'Follow up with Cafe 91'));
  assert.ok(calls.some(c => c.sql.includes('INSERT INTO task_notifications')));
  assert.ok(calls.some(c => c.sql.includes('automation.inactive_follow_up')));
});

test('already-claimed inactivity episode does not create another task', async () => {
  const lead = { id:'11111111-1111-4111-8111-111111111111', business_name:'Cafe 91', salesman_id:'22222222-2222-4222-8222-222222222222', last_activity_at:'2026-10-01T00:00:00.000Z' };
  let taskInsert = false;
  const client = {
    async query(sql) {
      if (sql.includes('INSERT INTO automation_rule_runs')) return { rows:[] };
      if (sql.includes('INSERT INTO crm_tasks')) taskInsert = true;
      return { rows:[] };
    },
    release() {},
  };
  const database = {
    async query(){ return { rows:[lead] }; },
    pool:{ async connect(){ return client; } },
  };
  const result = await runInactiveLeadFollowUpAutomation({
    database,
    settings:{ lead_settings:{ automationRules:{ inactiveLeadFollowUp:{ enabled:true, inactivityDays:5, stages:["cold","hot"] } } } },
  });
  assert.equal(result.created, 0);
  assert.equal(taskInsert, false);
});
