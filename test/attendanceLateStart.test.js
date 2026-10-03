const test = require('node:test');
const assert = require('node:assert/strict');
const { computeLateMinutes } = require('../src/utils/attendanceLateStart');

test('late Start is measured only beyond configured tolerance', () => {
  assert.equal(computeLateMinutes('2026-10-03T05:40:00.000Z', '10:45:00', 25), 0); // 11:10 IST
  assert.equal(computeLateMinutes('2026-10-03T05:50:00.000Z', '10:45:00', 25), 10); // 11:20 IST
});

test('missing expected Start never fabricates a late value', () => {
  assert.equal(computeLateMinutes('2026-10-03T05:50:00.000Z', null, 25), null);
});

test('missing tolerance never silently becomes zero', () => {
  assert.equal(computeLateMinutes('2026-10-03T05:50:00.000Z', '10:45:00', null), null);
});

test('invalid timing input is treated as unavailable instead of guessed', () => {
  assert.equal(computeLateMinutes('not-a-date', '10:45:00', 25), null);
  assert.equal(computeLateMinutes('2026-10-03T05:50:00.000Z', 'bad', 25), null);
});
