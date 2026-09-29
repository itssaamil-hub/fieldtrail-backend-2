const db = require('../db');

const EARTH_RADIUS_M = 6371000;
const DEFAULT_MIN_DISTANCE_M = 20;
const DEFAULT_MAX_GAP_MS = 2 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_CLEANUP_BATCH_SIZE = 5000;
const DEFAULT_CLEANUP_MAX_BATCHES = 20;

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampInteger(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function locationPingConfig(env = process.env) {
  return {
    minDistanceM: positiveNumber(env.LOCATION_PING_MIN_DISTANCE_M, DEFAULT_MIN_DISTANCE_M),
    maxGapMs: positiveNumber(env.LOCATION_PING_MAX_GAP_SECONDS, DEFAULT_MAX_GAP_MS / 1000) * 1000,
    retentionDays: clampInteger(env.LOCATION_PING_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, 30, 3650),
    cleanupBatchSize: clampInteger(env.LOCATION_PING_CLEANUP_BATCH_SIZE, DEFAULT_CLEANUP_BATCH_SIZE, 100, 20000),
    cleanupMaxBatches: clampInteger(env.LOCATION_PING_CLEANUP_MAX_BATCHES, DEFAULT_CLEANUP_MAX_BATCHES, 1, 100),
  };
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => deg * Math.PI / 180;
  const p1 = toRad(Number(lat1));
  const p2 = toRad(Number(lat2));
  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLng = toRad(Number(lng2) - Number(lng1));
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function shouldPersistLocationPing({ previous, lat, lng, capturedAt, minDistanceM, maxGapMs }) {
  if (!previous || previous.latitude == null || previous.longitude == null || !previous.captured_at) return true;

  const currentMs = Date.parse(capturedAt);
  const previousMs = new Date(previous.captured_at).getTime();
  if (!Number.isFinite(currentMs) || !Number.isFinite(previousMs)) return true;

  // A delayed/retried ping older than the latest persisted fix should not add
  // an out-of-order history row. The live profile is still refreshed by the route.
  if (currentMs <= previousMs) return false;
  if (currentMs - previousMs >= maxGapMs) return true;

  return haversineMeters(previous.latitude, previous.longitude, lat, lng) >= minDistanceM;
}

async function cleanupLocationPings({
  query = db.query,
  retentionDays,
  batchSize,
  maxBatches,
} = {}) {
  const config = locationPingConfig();
  const keepDays = clampInteger(retentionDays, config.retentionDays, 30, 3650);
  const limit = clampInteger(batchSize, config.cleanupBatchSize, 100, 20000);
  const maxLoops = clampInteger(maxBatches, config.cleanupMaxBatches, 1, 100);
  let deleted = 0;
  let batches = 0;

  for (; batches < maxLoops; batches += 1) {
    const result = await query(
      `WITH doomed AS (
         SELECT id
         FROM location_pings
         WHERE captured_at < now() - ($1::int * interval '1 day')
         ORDER BY captured_at ASC
         LIMIT $2
       )
       DELETE FROM location_pings p
       USING doomed d
       WHERE p.id = d.id`,
      [keepDays, limit]
    );
    const count = Number(result.rowCount || 0);
    deleted += count;
    if (count < limit) {
      return { deleted, retentionDays: keepDays, batches: batches + 1, complete: true };
    }
  }

  return { deleted, retentionDays: keepDays, batches, complete: false };
}

module.exports = {
  DEFAULT_MIN_DISTANCE_M,
  DEFAULT_MAX_GAP_MS,
  DEFAULT_RETENTION_DAYS,
  locationPingConfig,
  haversineMeters,
  shouldPersistLocationPing,
  cleanupLocationPings,
};
