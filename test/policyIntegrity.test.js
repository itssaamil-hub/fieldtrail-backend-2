const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'policy-integrity-test-only';

const dayClosing = require('../src/utils/dayClosing');
const employeeLocation = require('../src/utils/employeeLocation');

const U = '11111111-1111-4111-8111-111111111111';

test('attendance permissions fail if policy is still missing after self-heal', async () => {
  const queries = [];
  const query = async (sql) => {
    queries.push(sql);
    if (sql.startsWith('INSERT INTO employee_day_closing_permissions')) return { rows: [] };
    if (sql.startsWith('SELECT * FROM employee_day_closing_permissions')) return { rows: [] };
    return { rows: [] };
  };

  await assert.rejects(
    () => dayClosing.permissions(query, U),
    (err) => err && err.status === 500 && /Attendance policy is missing/.test(err.message)
  );
  assert.equal(queries.length, 2);
});

test('employee location settings fail if policy is still missing after self-heal', async () => {
  const queries = [];
  const query = async (sql) => {
    queries.push(sql);
    if (sql.startsWith('INSERT INTO employee_location_settings')) return { rows: [] };
    if (sql.includes('SELECT gps_location')) return { rows: [] };
    return { rows: [] };
  };

  await assert.rejects(
    () => employeeLocation.getEmployeeLocationSettings(U, query),
    (err) => err && err.status === 500 && /Location policy is missing/.test(err.message)
  );
  assert.equal(queries.length, 2);
});
