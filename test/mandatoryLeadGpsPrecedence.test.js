const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/routes/employeeLocationPolicy.routes.js'), 'utf8');

test('mandatory lead GPS overrides trusted no-GPS bypass', () => {
  assert.match(source, /const mandatoryLeadGps = policy\.gpsLocation === true && policy\.locationMandatoryForNewLead === true/);
  assert.match(source, /trustedLeadCapture && !mandatoryLeadGps/);
  assert.match(source, /if \(mandatoryLeadGps\)/);
  assert.match(source, /Location is required for this lead but was not captured/);
});
