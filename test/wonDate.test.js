const test = require('node:test');
const assert = require('node:assert/strict');
const { isoDayInIst, validCalendarDay, validateWonDate } = require('../src/utils/wonDate');

test('IST day is used around the UTC date boundary', () => {
  assert.equal(isoDayInIst(new Date('2026-09-30T20:00:00.000Z')), '2026-10-01');
});

test('Won Date accepts real calendar dates only', () => {
  assert.equal(validCalendarDay('2026-10-01'), true);
  assert.equal(validCalendarDay('2026-02-29'), false);
  assert.equal(validCalendarDay('01-10-2026'), false);
});

test('Won Date may be today or in the past but never in the future', () => {
  const now = new Date('2026-10-01T12:00:00.000Z');
  assert.equal(validateWonDate('2026-10-01', now), '2026-10-01');
  assert.equal(validateWonDate('2026-09-30', now), '2026-09-30');
  assert.throws(() => validateWonDate('2026-10-02', now), /cannot be in the future/i);
  assert.throws(() => validateWonDate('2026-02-29', now), /valid Won Date/i);
});
