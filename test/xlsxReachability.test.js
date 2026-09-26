const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('SheetJS remains export-only and never parses untrusted workbooks', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/admin.routes.js'), 'utf8');
  assert.match(src, /XLSX\.write\(/, 'XLSX export must still be present');
  assert.doesNotMatch(src, /XLSX\.(?:read|readFile)\s*\(/, 'Do not use vulnerable SheetJS read paths');
  assert.doesNotMatch(src, /sheet_to_json\s*\(/, 'Do not parse uploaded spreadsheets with SheetJS');
});
