const test = require('node:test');
const assert = require('node:assert/strict');
const { getPerformanceReport } = require('../src/utils/performanceV2');

test('performance Won revenue uses current editable deal value while Won attribution stays milestone-based', async () => {
  let sql = '';
  const report = await getPerformanceReport(async (text) => {
    sql = text;
    return { rows: [] };
  }, { from: '2026-10-01', to: '2026-10-01' });

  assert.match(sql, /FROM lead_stage_milestones m\s+JOIN leads l ON l\.id=m\.lead_id\s+CROSS JOIN bounds b/);
  assert.match(sql, /sum\(COALESCE\(l\.deal_value,0\)\) FILTER \(WHERE m\.stage='won'\)/);
  assert.doesNotMatch(sql, /sum\(m\.deal_value_snapshot\) FILTER \(WHERE m\.stage='won'\)/);
  assert.match(report.definitions.won, /first reaching Won/);
  assert.match(report.definitions.salesValue, /Current editable Deal Value/);
});
