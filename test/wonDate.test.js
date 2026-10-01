const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidDay, validateWonDate } = require('../src/utils/wonDate');

test('Won Date accepts real calendar days only', () => {
  assert.equal(isValidDay('2026-10-01'), true);
  assert.equal(isValidDay('2026-02-29'), false);
  assert.equal(isValidDay('01-10-2026'), false);
  assert.equal(isValidDay(''), false);
});

test('Won Date accepts creation day through today for a Won deal', () => {
  assert.equal(validateWonDate({ wonDate:'2026-09-20', status:'won', createdDay:'2026-09-20', today:'2026-10-01' }), '2026-09-20');
  assert.equal(validateWonDate({ wonDate:'2026-10-01', status:'won', createdDay:'2026-09-20', today:'2026-10-01' }), '2026-10-01');
});

test('Won Date rejects non-Won deals', () => {
  assert.throws(
    () => validateWonDate({ wonDate:'2026-10-01', status:'negotiation', createdDay:'2026-09-20', today:'2026-10-01' }),
    err => err.status === 409 && /only be edited while the deal is Won/.test(err.message)
  );
});

test('Won Date rejects dates before creation and future dates', () => {
  assert.throws(
    () => validateWonDate({ wonDate:'2026-09-19', status:'won', createdDay:'2026-09-20', today:'2026-10-01' }),
    /cannot be before/
  );
  assert.throws(
    () => validateWonDate({ wonDate:'2026-10-02', status:'won', createdDay:'2026-09-20', today:'2026-10-01' }),
    /cannot be in the future/
  );
});
