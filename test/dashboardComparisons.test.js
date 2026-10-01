const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDisplaySettings,
  previousSnapshot,
  dayStart,
  weekStart,
  monthStart,
  wonPeriodWindow,
  comparison,
  currentWonKpiMetrics,
  currentMonthWonMetrics,
  wonComparisonPeriodCount,
  getDashboardComparisonData,
} = require('../src/utils/dashboardComparisons');

test('display settings default safely and normalize period', () => {
  assert.deepEqual(normalizeDisplaySettings({}), {
    showAdminComparisons: true,
    showEmployeeComparisons: true,
    comparisonPeriod: 'weekly',
  });
  assert.deepEqual(normalizeDisplaySettings({ showAdminComparisons: false, showEmployeeComparisons: false, comparisonPeriod: 'monthly' }), {
    showAdminComparisons: false,
    showEmployeeComparisons: false,
    comparisonPeriod: 'monthly',
  });
  assert.equal(normalizeDisplaySettings({ comparisonPeriod: 'yearly' }).comparisonPeriod, 'weekly');
});

test('weekly comparison snapshot is exactly seven days earlier', () => {
  const now = new Date('2026-10-01T06:30:15.000Z');
  assert.equal(previousSnapshot('weekly', now).toISOString(), '2026-09-24T06:30:15.000Z');
});

test('monthly snapshot clamps safely at shorter month end in IST', () => {
  const now = new Date('2026-03-31T12:00:00.000Z');
  assert.equal(previousSnapshot('monthly', now).toISOString(), '2026-02-28T12:00:00.000Z');
});

test('day, week and month boundaries are based on Asia/Kolkata', () => {
  const now = new Date('2026-10-01T00:30:00.000Z'); // Thursday 06:00 IST
  assert.equal(dayStart(now).toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(weekStart(now).toISOString(), '2026-09-27T18:30:00.000Z'); // Monday 00:00 IST
  assert.equal(monthStart(now).toISOString(), '2026-09-30T18:30:00.000Z');
});

test('weekly Won window compares the same elapsed point in consecutive calendar weeks', () => {
  const now = new Date('2026-10-01T06:30:15.000Z');
  const w = wonPeriodWindow('weekly', now);
  assert.equal(w.currentStart.toISOString(), '2026-09-27T18:30:00.000Z');
  assert.equal(w.currentEnd.toISOString(), '2026-10-01T06:30:15.000Z');
  assert.equal(w.previousStart.toISOString(), '2026-09-20T18:30:00.000Z');
  assert.equal(w.previousEnd.toISOString(), '2026-09-24T06:30:15.000Z');
});

test('monthly Won window compares month-to-date against the same point last month', () => {
  const now = new Date('2026-10-01T06:30:15.000Z');
  const w = wonPeriodWindow('monthly', now);
  assert.equal(w.currentStart.toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(w.previousStart.toISOString(), '2026-08-31T18:30:00.000Z');
  assert.equal(w.previousEnd.toISOString(), '2026-09-01T06:30:15.000Z');
});

test('comparison always provides a display percentage', () => {
  assert.deepEqual(comparison(0, 0), { current: 0, previous: 0, pct: 0 });
  assert.deepEqual(comparison(3, 0), { current: 3, previous: 0, pct: 100 });
  assert.deepEqual(comparison(12, 10), { current: 12, previous: 10, pct: 20 });
  assert.deepEqual(comparison(8, 10), { current: 8, previous: 10, pct: -20 });
});

test('current Won KPI reads only current lead state and current editable deal value', async () => {
  let sql = '';
  const result = await currentWonKpiMetrics({
    salesmanId: null,
    query: async (text) => {
      sql = text;
      return { rows: [{ current_won_count: 7, current_won_value: '118000' }] };
    },
  });

  assert.deepEqual(result, { currentWonCount: 7, currentWonValue: 118000 });
  assert.match(sql, /FROM leads l/);
  assert.match(sql, /l\.status = 'won'/);
  assert.match(sql, /l\.deal_value/);
  assert.doesNotMatch(sql, /lead_stage_milestones/);
  assert.doesNotMatch(sql, /occurred_at/);
});

test('Salesman current-month Won KPI uses Won milestone month, not deal creation month or all-time state', async () => {
  let sql = '';
  let params = null;
  const now = new Date('2026-10-02T12:00:00.000Z');
  const result = await currentMonthWonMetrics({
    salesmanId: '00000000-0000-0000-0000-000000000001',
    now,
    query: async (text, values) => {
      sql = text;
      params = values;
      return { rows: [{ month_won_count: 3, month_won_value: '45000' }] };
    },
  });

  assert.deepEqual(result, { monthWonCount: 3, monthWonValue: 45000 });
  assert.match(sql, /FROM lead_stage_milestones m/);
  assert.match(sql, /JOIN leads l ON l\.id = m\.lead_id/);
  assert.match(sql, /m\.stage = 'won'/);
  assert.match(sql, /m\.occurred_at >= \$2/);
  assert.match(sql, /m\.occurred_at <= \$3/);
  assert.doesNotMatch(sql, /l\.created_at/);
  assert.equal(params[1].toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(params[2].toISOString(), now.toISOString());
});

test('Won comparison reads only first-Won milestone events and never deal value', async () => {
  let sql = '';
  const count = await wonComparisonPeriodCount({
    salesmanId: null,
    start: new Date('2026-09-27T18:30:00.000Z'),
    end: new Date('2026-10-01T06:30:15.000Z'),
    query: async (text) => {
      sql = text;
      return { rows: [{ period_won_count: 1 }] };
    },
  });

  assert.equal(count, 1);
  assert.match(sql, /FROM lead_stage_milestones m/);
  assert.match(sql, /m\.stage = 'won'/);
  assert.match(sql, /m\.occurred_at/);
  assert.doesNotMatch(sql, /deal_value/);
});

test('dashboard keeps current Won KPI independent from weekly Won comparison', async () => {
  let pipelineCalls = 0;
  let periodWonCalls = 0;
  const query = async (text) => {
    if (/SELECT display_settings FROM crm_settings/.test(text)) {
      return { rows: [{ display_settings: { comparisonPeriod: 'weekly' } }] };
    }
    if (/WITH snapshot AS/.test(text)) {
      pipelineCalls += 1;
      return pipelineCalls === 1
        ? { rows: [{ total: 20, hot: 3, conversation: 4, negotiation: 2, leads_today: 1, hot_today: 0 }] }
        : { rows: [{ total: 18, hot: 2, conversation: 3, negotiation: 1, leads_today: 0, hot_today: 0 }] };
    }
    if (/current_won_count/.test(text)) {
      return { rows: [{ current_won_count: 7, current_won_value: '118000' }] };
    }
    if (/period_won_count/.test(text)) {
      periodWonCalls += 1;
      return { rows: [{ period_won_count: periodWonCalls === 1 ? 1 : 0 }] };
    }
    throw new Error(`Unexpected query in test: ${text}`);
  };

  const result = await getDashboardComparisonData({
    role: 'admin',
    userId: '00000000-0000-0000-0000-000000000001',
    period: 'weekly',
    now: new Date('2026-10-01T06:30:15.000Z'),
    query,
  });

  assert.equal(result.metrics.won, 7, 'main Won must be current Won deals, not this-week wins');
  assert.equal(result.metrics.wonValue, 118000, 'main Won value must be current editable deal values');
  assert.deepEqual(result.comparisons.won, { current: 1, previous: 0, pct: 100 });
});

test('Salesman dashboard main Won is current month even when comparison period is weekly', async () => {
  let pipelineCalls = 0;
  let periodWonCalls = 0;
  const query = async (text) => {
    if (/SELECT display_settings FROM crm_settings/.test(text)) {
      return { rows: [{ display_settings: { comparisonPeriod: 'weekly' } }] };
    }
    if (/WITH snapshot AS/.test(text)) {
      pipelineCalls += 1;
      return pipelineCalls === 1
        ? { rows: [{ total: 12, hot: 2, conversation: 3, negotiation: 1, leads_today: 2, hot_today: 0 }] }
        : { rows: [{ total: 10, hot: 1, conversation: 2, negotiation: 1, leads_today: 1, hot_today: 0 }] };
    }
    if (/current_won_count/.test(text)) {
      return { rows: [{ current_won_count: 9, current_won_value: '175000' }] };
    }
    if (/period_won_count/.test(text)) {
      periodWonCalls += 1;
      return { rows: [{ period_won_count: periodWonCalls === 1 ? 2 : 1 }] };
    }
    if (/month_won_count/.test(text)) {
      return { rows: [{ month_won_count: 4, month_won_value: '72000' }] };
    }
    if (/renewal_date/.test(text)) {
      return { rows: [{ count: 2 }] };
    }
    throw new Error(`Unexpected query in test: ${text}`);
  };

  const result = await getDashboardComparisonData({
    role: 'salesman',
    userId: '00000000-0000-0000-0000-000000000001',
    period: 'weekly',
    now: new Date('2026-10-02T12:00:00.000Z'),
    query,
  });

  assert.equal(result.metrics.won, 4, 'Salesman main Won must be current-month achievements, not all-time current Won state');
  assert.equal(result.metrics.wonValue, 72000, 'Salesman main Won value must be current-month achieved revenue');
  assert.deepEqual(result.comparisons.won, { current: 2, previous: 1, pct: 100 });
  assert.equal(result.period, 'weekly', 'comparison period may stay weekly without changing main monthly Won KPI');
});