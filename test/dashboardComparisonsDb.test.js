const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { getDashboardComparisonData } = require('../src/utils/dashboardComparisons');

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(101), B = id(102);
const NOW = new Date('2026-10-06T06:30:00Z');

test('dashboard comparisons use real SQL, consistent Won eligibility and employee scope', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE crm_settings(display_settings jsonb, updated_at timestamptz);
    CREATE TABLE leads(id uuid PRIMARY KEY, salesman_id uuid, status text, created_at timestamptz,
      deal_value numeric, renewal_date date, renewal_month text);
    CREATE TABLE lead_status_history(lead_id uuid, old_status text, changed_at timestamptz);
    CREATE TABLE lead_stage_milestones(lead_id uuid, salesman_id uuid, stage text, occurred_at timestamptz);
    INSERT INTO crm_settings VALUES ('{"comparisonPeriod":"weekly"}', now());
  `);
  await db.query('INSERT INTO users VALUES($1),($2)', [A, B]);
  const fixtures = [
    [1, A, 'won', '2026-10-05T00:00:00+05:30', 100],
    [2, A, 'won', '2026-10-01T00:00:00+05:30', 200],
    [3, A, 'won', '2026-09-28T00:00:00+05:30', 300],
    [4, A, 'won', '2026-09-03T12:00:00+05:30', 400],
    [5, A, 'negotiation', '2026-10-05T12:00:00+05:30', 500],
    [6, B, 'won', '2026-10-05T12:00:00+05:30', 600],
    [7, B, 'won', '2026-09-28T12:00:00+05:30', 700],
    [8, A, 'won', NOW.toISOString(), 900],
  ];
  for (const [n, owner, status, wonAt, value] of fixtures) {
    await db.query('INSERT INTO leads(id,salesman_id,status,created_at,deal_value) VALUES($1,$2,$3,$4,$5)', [id(n), owner, status, '2026-09-01T00:00:00+05:30', value]);
    await db.query("INSERT INTO lead_stage_milestones VALUES($1,$2,'won',$3)", [id(n), owner, wonAt]);
  }
  const read = options => getDashboardComparisonData({ role: 'admin', userId: A, now: NOW, query: db.query.bind(db), ...options });

  await t.test('weekly and monthly windows, both roles, filtered Admin and main KPI periods', async () => {
    for (const period of ['weekly', 'monthly']) {
      const admin = await read({ period });
      assert.equal(admin.metrics.won, 7);
      assert.equal(admin.metrics.wonValue, 3200);
      assert.equal(admin.metrics.negotiationValue, 500);
      assert.deepEqual(admin.comparisons.won, period === 'weekly'
        ? { current: 3, previous: 2, pct: 50 }
        : { current: 4, previous: 1, pct: 300 });
      const employee = await read({ role: 'salesman', userId: A, salesmanId: B, period });
      assert.equal(employee.metrics.won, 3, 'employee main KPI remains this month even in weekly mode');
      assert.equal(employee.metrics.wonValue, 1200);
      assert.equal(employee.metrics.negotiationValue, 500);
      assert.deepEqual(employee.comparisons.won, period === 'weekly'
        ? { current: 2, previous: 1, pct: 100 }
        : { current: 3, previous: 1, pct: 200 });
      const filtered = await read({ salesmanId: A, period });
      assert.deepEqual(filtered.comparisons.won, employee.comparisons.won);
      assert.equal(filtered.metrics.negotiationValue, 500);
    }
  });

  await t.test('moving out of Won removes the deal on both dashboards without deleting history', async () => {
    await db.query("UPDATE leads SET status='negotiation' WHERE id=$1", [id(1)]);
    assert.equal((await read({period:'weekly'})).metrics.negotiationValue, 600, 'moving into Negotiation includes value');
    for (const period of ['weekly', 'monthly']) {
      const admin = await read({ period });
      const employee = await read({ role: 'salesman', period });
      assert.equal(admin.metrics.won, 6);
      assert.equal(employee.metrics.won, 2);
      assert.equal(admin.comparisons.won.current, period === 'weekly' ? 2 : 3);
      assert.equal(employee.comparisons.won.current, period === 'weekly' ? 1 : 2);
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM lead_stage_milestones')).rows[0].n, 8);
    await db.query("UPDATE leads SET status='won' WHERE id=$1", [id(1)]);
    assert.equal((await read({period:'weekly'})).metrics.negotiationValue, 500, 'moving out removes value');
    assert.equal((await read({ period: 'weekly' })).comparisons.won.current, 3);
  });

  await t.test('previous-period eligibility and zero baselines are consistent on both dashboards', async () => {
    await db.query("UPDATE leads SET status='negotiation' WHERE id=$1", [id(4)]);
    for (const role of ['admin', 'salesman']) {
      const result = await read({ role, period: 'monthly' });
      assert.equal(result.comparisons.won.previous, 0);
      assert.ok(result.comparisons.won.current > 0);
      assert.equal(result.comparisons.won.pct, null);
      assert.deepEqual(role === 'admin' ? result.comparisons.leadsToday : result.comparisons.today, { current: 0, previous: 0, pct: 0 });
    }
    await db.query("UPDATE leads SET status='won' WHERE id=$1", [id(4)]);
  });

  await t.test('Negotiation amounts reflect live edits, null values and employee scope', async () => {
    const otherNegotiation=id(9), unpricedNegotiation=id(10);
    await db.query("INSERT INTO leads(id,salesman_id,status,created_at,deal_value) VALUES($1,$2,'negotiation',$3,$4)",[otherNegotiation,B,'2026-09-01T00:00:00+05:30',750]);
    await db.query("INSERT INTO leads(id,salesman_id,status,created_at,deal_value) VALUES($1,$2,'negotiation',$3,NULL)",[unpricedNegotiation,A,'2026-09-01T00:00:00+05:30']);
    const all=await read({period:'monthly'});
    assert.equal(all.metrics.negotiation,3);
    assert.equal(all.metrics.negotiationValue,1250,'null deal amounts count as zero');
    const employee=await read({role:'salesman',userId:A,period:'monthly'});
    assert.equal(employee.metrics.negotiation,2);
    assert.equal(employee.metrics.negotiationValue,500);
    const filtered=await read({salesmanId:B,period:'weekly'});
    assert.equal(filtered.metrics.negotiationValue,750,'admin employee selector scopes amounts');
    await db.query('UPDATE leads SET deal_value=1250 WHERE id=$1',[id(5)]);
    assert.equal((await read({salesmanId:A,period:'weekly'})).metrics.negotiationValue,1250,'editing deal value updates KPI');
    await db.query("UPDATE leads SET status='won' WHERE id=$1",[id(5)]);
    assert.equal((await read({salesmanId:A,period:'weekly'})).metrics.negotiationValue,0,'leaving Negotiation removes amount');
    await db.query("UPDATE leads SET status='negotiation',deal_value=500 WHERE id=$1",[id(5)]);
    await db.query('DELETE FROM leads WHERE id IN ($1,$2)',[otherNegotiation,unpricedNegotiation]);
  });

  await t.test('canonical Won date edits affect period comparisons without changing all-time count', async () => {
    await db.query('UPDATE lead_stage_milestones SET occurred_at=$2 WHERE lead_id=$1', [id(2), '2026-09-30T12:00:00+05:30']);
    const admin = await read({ period: 'monthly' });
    const employee = await read({ role: 'salesman', period: 'monthly' });
    assert.equal(admin.metrics.won, 7);
    assert.equal(admin.comparisons.won.current, 3);
    assert.equal(employee.metrics.won, 2);
    assert.equal(employee.comparisons.won.current, 2);
  });
});
