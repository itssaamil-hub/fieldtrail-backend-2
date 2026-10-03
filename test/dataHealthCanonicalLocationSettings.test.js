const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'dataHealth.routes.js'), 'utf8');

const locationKeys = [
  'employee_missing_location_policy',
  'tracking_enabled_gps_disabled',
  'mandatory_lead_location_gps_disabled',
  'active_tracking_no_pings',
  'active_tracking_stale',
];

function sqlFor(key, occurrence = 1) {
  const marker = `${key}:\``;
  let from = -1;
  for (let i = 0; i < occurrence; i += 1) {
    from = source.indexOf(marker, from + 1);
    assert.notEqual(from, -1, `missing ${key} SQL occurrence ${occurrence}`);
  }
  const start = from + marker.length;
  const end = source.indexOf('`', start);
  assert.notEqual(end, -1, `unterminated ${key} SQL`);
  return source.slice(start, end);
}

test('Data Health location checks use canonical employee_location_settings', () => {
  for (const key of locationKeys) {
    const checkSql = sqlFor(key, 1);
    assert.match(checkSql, /employee_location_settings/);
    assert.doesNotMatch(checkSql, /employee_day_closing_permissions/);

    const detailSql = sqlFor(key, 2);
    assert.match(detailSql, /employee_location_settings/);
    assert.doesNotMatch(detailSql, /employee_day_closing_permissions/);
  }
});

test('continuous tracking diagnostics keep their existing timing guards', () => {
  const noPings = sqlFor('active_tracking_no_pings', 1);
  assert.match(noPings, /90 seconds/);
  assert.match(noPings, /continuous_gps_tracking=true/);
  assert.match(noPings, /gps_location=true/);

  const stale = sqlFor('active_tracking_stale', 1);
  assert.match(stale, /15 minutes/);
  assert.match(stale, /continuous_gps_tracking=true/);
  assert.match(stale, /gps_location=true/);
});
