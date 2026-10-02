const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('My Performance uses the same strong canonical Won engine as Admin performance', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/salesmanPerformanceV2.routes.js'), 'utf8');
  assert.match(source, /require\('\.\.\/utils\/performanceV2Strong'\)/);
  assert.doesNotMatch(source, /require\('\.\.\/utils\/performanceV2'\)/);
  assert.match(source, /total_deals:totalDeals/);
  assert.match(source, /won_value:Number\(e\.results\?\.salesValue\|\|0\)/);
  assert.match(source, /win_rate_pct:winRate/);
});
