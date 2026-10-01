const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDisplaySettings,
  previousSnapshot,
  dayStart,
  monthStart,
  comparison,
} = require('../src/utils/dashboardComparisons');

test('display settings default safely and normalize period', () => {
  assert.deepEqual(normalizeDisplaySettings({}), {
    showAdminComparisons: true,
    showEmployeeComparisons: true,
    comparisonPeriod: 'weekly',
  });
  assert.deepEqual(normalizeDisplaySettings({ showAdminComparisons: false, showEmployeeComparisons: false, comparisonPeriod: 'monthly' }), {
    showAdminComparisons: false,
    showEmployeeComparisons: false,
    comparisonPeriod: 'monthly',
  });
  assert.equal(normalizeDisplaySettings({ comparisonPeriod: 'yearly' }).comparisonPeriod, 'weekly');
});

test('weekly comparison snapshot is exactly seven days earlier', () => {
  const now = new Date('2026-10-01T06:30:15.000Z');
  assert.equal(previousSnapshot('weekly', now).toISOString(), '2026-09-24T06:30:15.000Z');
});

test('monthly snapshot clamps safely at shorter month end in IST', () => {
  const now = new Date('2026-03-31T12:00:00.000Z');
  assert.equal(previousSnapshot('monthly', now).toISOString(), '2026-02-28T12:00:00.000Z');
});

test('day and month boundaries are based on Asia/Kolkata', () => {
  const now = new Date('2026-10-01T00:30:00.000Z'); // 06:00 IST
  assert.equal(dayStart(now).toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(monthStart(now).toISOString(), '2026-09-30T18:30:00.000Z');
});

test('comparison always provides a display percentage', () => {
  assert.deepEqual(comparison(0, 0), { current: 0, previous: 0, pct: 0 });
  assert.deepEqual(comparison(3, 0), { current: 3, previous: 0, pct: 100 });
  assert.deepEqual(comparison(12, 10), { current: 12, previous: 10, pct: 20 });
  assert.deepEqual(comparison(8, 10), { current: 8, previous: 10, pct: -20 });
});