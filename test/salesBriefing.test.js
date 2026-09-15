const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildBriefing, localDate } = require('../src/utils/salesBriefing');
const date = '2026-09-16';
const lead = (id, status, due) => ({ id, business_name: id, status, next_follow_up_date: due });

test('uses India calendar day across UTC midnight boundary', () => {
  assert.equal(localDate(new Date('2026-09-15T20:00:00Z'), 'Asia/Kolkata'), date);
  assert.equal(localDate(new Date('2026-09-15T20:00:00Z'), 'UTC'), '2026-09-15');
});
test('excludes closed leads and distinguishes demo stage from appointments', () => {
  const b = buildBriefing([lead('a', 'won', date), lead('b', 'lost', '2026-09-01'), lead('c', 'demo', null), lead('d', 'demo_scheduled', date)], date);
  assert.deepEqual(b.counts, { followUpsToday: 1, overdueFollowUps: 0, demoStageLeads: 2, activeLeads: 2 });
});
test('prioritizes overdue, today, then hot leads; respects future follow-ups', () => {
  const b = buildBriefing([lead('hot', 'hot', null), lead('later', 'hot', '2026-09-17'), lead('today', 'cold', date), lead('overdue', 'cold', '2026-09-14')], date);
  assert.deepEqual(b.priorityLeads.map(l => l.id), ['overdue', 'today', 'hot']);
  assert.equal(b.counts.overdueFollowUps, 1);
});
test('limits priority contacts to five with stable ordering', () => {
  const leads = Array.from({ length: 8 }, (_, i) => lead(String(i), 'hot', null));
  assert.deepEqual(buildBriefing(leads.reverse(), date).priorityLeads.map(l => l.id), ['0', '1', '2', '3', '4']);
});
test('empty pipeline returns useful zero-count briefing', () => {
  const b = buildBriefing([], date);
  assert.equal(b.counts.activeLeads, 0);
  assert.equal(b.priorityLeads.length, 0);
  assert.match(b.recommendation, /Add new prospects/);
  assert.doesNotMatch(b.summary, /Start with/);
});

// Exercise scheduler behavior without a live database or sending notifications.
const fs = require('node:fs');
const vm = require('node:vm');
function scheduler({ prior = false, locked = true, sent = 1, failed = 0 } = {}) {
  const calls = [];
  const client = { query: async sql => {
    calls.push(sql);
    if (sql.includes('pg_try')) return { rows: [{ locked }] };
    return { rows: [], rowCount: prior ? 1 : 0 };
  }, release: () => calls.push('release') };
  const db = { pool: { connect: async () => client }, query: async sql => ({ rows: sql.includes('FROM users') ? [{ id: 'user' }] : [] }) };
  let pushes = 0;
  const box = { module: { exports: {} }, process: { env: { VAPID_PUBLIC_KEY: 'test', VAPID_PRIVATE_KEY: 'test' } }, console,
    require: name => name === '../db' ? db : { notifyUsers: async () => { pushes++; return { sent, failed }; } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/utils/salesBriefing'), 'utf8'), box);
  return { run: box.module.exports.runSalesBriefings, calls, pushes: () => pushes };
}
test('scheduler skips a previously delivered briefing and concurrent lock holder', async () => {
  for (const options of [{ prior: true }, { locked: false }]) {
    const s = scheduler(options); const r = await s.run();
    assert.equal(r.skippedUsers, 1); assert.equal(s.pushes(), 0);
    assert.ok(s.calls.includes('release'));
  }
});
test('scheduler records delivery only after a device accepts the push', async () => {
  for (const sent of [0, 1]) {
    const s = scheduler({ sent, failed: sent ? 0 : 1 }); const r = await s.run();
    assert.equal(r.sentUsers, sent);
    assert.equal(s.calls.some(sql => sql.startsWith('INSERT')), !!sent);
    assert.ok(s.calls.some(sql => sql.includes('pg_advisory_unlock')));
  }
});


test('natural briefing uses real priorities, correct singular words and employee name', () => {
  const b = buildBriefing([lead('Maple', 'hot', '2026-09-15'), lead('Saffron', 'negotiation', date), lead('Demo', 'demo', '2026-09-18')], date, 'Anand Kumar');
  assert.equal(b.greeting, 'Hello, Anand!');
  assert.match(b.summary, /1 follow-up today and 1 overdue contact/);
  assert.match(b.summary, /Start with Maple/);
  assert.match(b.summary, /Next, contact Saffron/);
  assert.match(b.summary, /1 lead in the demo stage/);
  assert.doesNotMatch(b.summary, /demo today|Start with Demo/);
});
test('future appointments do not turn into an urgent-contact recommendation', () => {
  const b = buildBriefing([lead('Future', 'hot', '2026-09-20')], date);
  assert.match(b.summary, /nothing overdue/);
  assert.doesNotMatch(b.summary, /Start with/);
  assert.match(b.focus, /plan your next follow-ups/);
});
