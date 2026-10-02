const test = require('node:test');
const assert = require('node:assert/strict');
const { getPerformanceReport } = require('../src/utils/performanceV2Strong');

const SALESMAN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('strong performance Won count and Sales Value use the canonical Won milestone and current Won state', async () => {
  const statements = [];
  const report = await getPerformanceReport(async (text) => {
    statements.push(text);

    if (text.includes('WITH bounds AS')) {
      return {
        rows: [{
          id: SALESMAN_ID,
          full_name: 'Test Salesman',
          effective_to: '2026-10-31',
          cohort_demo: 1,
        }],
      };
    }

    if (text.includes('WITH creation_owner AS')) {
      return { rows: [{ salesman_id: SALESMAN_ID, demo_then_won: 1 }] };
    }

    if (text.includes("FROM lead_stage_milestones m") && text.includes("l.status='won'")) {
      return { rows: [{ salesman_id: SALESMAN_ID, won: 1, sales_value: '25000' }] };
    }

    throw new Error('Unexpected performance query');
  }, { from: '2026-10-01', to: '2026-10-31', salesmanId: SALESMAN_ID });

  const canonicalSql = statements.find(text => text.includes("FROM lead_stage_milestones m") && text.includes("l.status='won'"));
  assert.ok(canonicalSql, 'canonical Won query should be executed');
  assert.match(canonicalSql, /m\.stage='won'/);
  assert.match(canonicalSql, /l\.status='won'/);
  assert.match(canonicalSql, /m\.occurred_at AT TIME ZONE 'Asia\/Kolkata'/);
  assert.match(canonicalSql, /sum\(coalesce\(l\.deal_value,0\)\)/i);
  assert.match(canonicalSql, /m\.salesman_id=\$3/);
  assert.doesNotMatch(canonicalSql, /activity_logs/);

  assert.equal(report.employees[0].results.won, 1);
  assert.equal(report.employees[0].results.salesValue, 25000);
  assert.equal(report.totals.results.won, 1);
  assert.equal(report.totals.results.salesValue, 25000);
  assert.match(report.definitions.won, /canonical Won Date/);
});
