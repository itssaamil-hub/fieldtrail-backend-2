const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildXlsx } = require('../src/utils/simpleXlsx');

test('XLSX exports use the dependency-free writer and vulnerable packages stay removed', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.dependencies.xlsx, undefined);
  assert.equal(pkg.dependencies.uuid, undefined);
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/admin.routes.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]xlsx['"]\)/);
  assert.match(src, /buildXlsx\(/);
  const workbook = buildXlsx(['Business Name', 'Value'], [{ 'Business Name': 'Cafe & Co', Value: 125 }], 'Leads');
  assert.equal(workbook.subarray(0, 2).toString(), 'PK');
  assert.ok(workbook.length > 500);
});
