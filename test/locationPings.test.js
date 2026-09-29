const test = require('node:test');
const assert = require('node:assert/strict');
const {
  locationPingConfig,
  haversineMeters,
  locationPingDecision,
  shouldPersistLocationPing,
  cleanupLocationPings,
} = require('../src/utils/locationPings');

test('location ping config defaults to conservative retention and dedupe values', () => {
  const c = locationPingConfig({});
  assert.equal(c.minDistanceM, 20);
  assert.equal(c.maxGapMs, 120000);
  assert.equal(c.retentionDays, 90);
});

test('stationary GPS noise inside the heartbeat window is not persisted', () => {
  const previous = { latitude: 26.8467, longitude: 80.9462, captured_at: '2026-09-29T10:00:00.000Z' };
  assert.equal(shouldPersistLocationPing({
    previous, lat: 26.84671, lng: 80.94621, capturedAt: '2026-09-29T10:00:30.000Z',
    minDistanceM: 20, maxGapMs: 120000,
  }), false);
});

test('meaningful movement is persisted before heartbeat interval', () => {
  const previous = { latitude: 26.8467, longitude: 80.9462, captured_at: '2026-09-29T10:00:00.000Z' };
  assert.ok(haversineMeters(26.8467, 80.9462, 26.8472, 80.9462) > 20);
  assert.equal(shouldPersistLocationPing({
    previous, lat: 26.8472, lng: 80.9462, capturedAt: '2026-09-29T10:00:30.000Z',
    minDistanceM: 20, maxGapMs: 120000,
  }), true);
});

test('stationary route still persists a heartbeat after two minutes', () => {
  const previous = { latitude: 26.8467, longitude: 80.9462, captured_at: '2026-09-29T10:00:00.000Z' };
  assert.equal(shouldPersistLocationPing({
    previous, lat: 26.8467, lng: 80.9462, capturedAt: '2026-09-29T10:02:00.000Z',
    minDistanceM: 20, maxGapMs: 120000,
  }), true);
});

test('out-of-order retry does not append stale history', () => {
  const previous = { latitude: 26.8467, longitude: 80.9462, captured_at: '2026-09-29T10:01:00.000Z' };
  assert.equal(shouldPersistLocationPing({
    previous, lat: 26.8472, lng: 80.9462, capturedAt: '2026-09-29T10:00:30.000Z',
    minDistanceM: 20, maxGapMs: 120000,
  }), false);
});

test('out-of-order retry cannot overwrite live location state', () => {
  const previous = { latitude: 26.8467, longitude: 80.9462, captured_at: '2026-09-29T10:01:00.000Z' };
  const decision = locationPingDecision({
    previous, lat: 26.8472, lng: 80.9462, capturedAt: '2026-09-29T10:00:30.000Z',
    minDistanceM: 20, maxGapMs: 120000,
  });
  assert.deepEqual(decision, { persisted: false, refreshLive: false, reason: 'stale' });
});

test('retention cleanup is bounded and reports deletion totals', async () => {
  const counts = [5000, 123];
  const calls = [];
  const result = await cleanupLocationPings({
    retentionDays: 90,
    batchSize: 5000,
    maxBatches: 10,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: counts.shift() ?? 0 };
    },
  });
  assert.equal(result.deleted, 5123);
  assert.equal(result.retentionDays, 90);
  assert.equal(result.batches, 2);
  assert.equal(result.complete, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, [90, 5000]);
});
