from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'missing expected block: {label}')
    return text.replace(old, new, 1)

# --- shared utility ---------------------------------------------------------
Path('src/utils/locationPings.js').write_text(r'''const db = require('../db');

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
''')

# --- salesman ping route ----------------------------------------------------
salesman_path = Path('src/routes/salesman.routes.js')
salesman = salesman_path.read_text()
salesman = replace_once(
    salesman,
    'const { findLeadDuplicates } = require("../utils/duplicateProtection");\n',
    'const { findLeadDuplicates } = require("../utils/duplicateProtection");\nconst { locationPingConfig, shouldPersistLocationPing } = require("../utils/locationPings");\n',
    'salesman location utility import',
)
old_ping = r'''router.post("/location/ping", async (req, res) => {
  const salesmanId = req.user.id;
  const { lat, lng, accuracyM, speedMps, batteryPct, isMockSuspected, capturedAt } = req.body;

  if (lat == null || lng == null || !capturedAt) {
    return res.status(400).json({ error: "lat, lng and capturedAt are required" });
  }

  // Only accept tracking while this salesman has an active Start Day session.
  // This is enforced server-side so a stale/background client cannot create
  // location history before Start Day or after End Day.
  const { rows: activeRows } = await db.query(
    `SELECT id FROM attendance
     WHERE salesman_id = $1
       AND start_day_at IS NOT NULL
       AND end_day_at IS NULL
     ORDER BY start_day_at DESC
     LIMIT 1`,
    [salesmanId]
  );
  if (!activeRows.length) {
    return res.status(409).json({ error: "Start Day is not active. Location tracking is unavailable." });
  }

  await db.query(
    `INSERT INTO location_pings
       (salesman_id, latitude, longitude, accuracy_m, speed_mps, battery_pct, is_mock_suspected, captured_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [salesmanId, lat, lng, accuracyM, speedMps, batteryPct, !!isMockSuspected, capturedAt]
  );

  await db.query(
    `UPDATE salesman_profiles
     SET last_lat = $2, last_lng = $3, last_battery_pct = $4, last_speed_mps = $5, last_seen_at = now()
     WHERE user_id = $1`,
    [salesmanId, lat, lng, batteryPct, speedMps]
  );

  const broadcast = req.app.get("broadcastToAdmins");
  if (typeof broadcast === "function") {
    broadcast({ type: "location_update", salesman: {
      id: salesmanId, lat, lng, batteryPct, speedMps, status: "online", lastSeenAt: new Date().toISOString()
    }});
  }

  if (isMockSuspected) {
    await notify({ type: "mock_gps_suspected", salesmanId, payload: { lat, lng } });
  }
  if (accuracyM != null && accuracyM > 100) {
    await notify({ type: "poor_accuracy", salesmanId, payload: { accuracyM } });
  }

  res.json({ ok: true });
});'''
new_ping = r'''router.post("/location/ping", async (req, res) => {
  const salesmanId = req.user.id;
  const { lat, lng, accuracyM, speedMps, batteryPct, isMockSuspected, capturedAt } = req.body;

  if (lat == null || lng == null || !capturedAt) {
    return res.status(400).json({ error: "lat, lng and capturedAt are required" });
  }
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90 ||
      !Number.isFinite(lngNum) || lngNum < -180 || lngNum > 180 ||
      !Number.isFinite(Date.parse(capturedAt))) {
    return res.status(400).json({ error: "Invalid location coordinates or capturedAt" });
  }

  // One indexed read verifies Start Day and fetches the latest persisted fix.
  // This avoids adding an extra DB round-trip just to deduplicate stationary
  // GPS noise while preserving the existing server-side attendance gate.
  const { rows: activeRows } = await db.query(
    `SELECT a.id,
            lp.latitude, lp.longitude, lp.captured_at
     FROM attendance a
     LEFT JOIN LATERAL (
       SELECT latitude, longitude, captured_at
       FROM location_pings
       WHERE salesman_id = $1
       ORDER BY captured_at DESC
       LIMIT 1
     ) lp ON true
     WHERE a.salesman_id = $1
       AND a.start_day_at IS NOT NULL
       AND a.end_day_at IS NULL
     ORDER BY a.start_day_at DESC
     LIMIT 1`,
    [salesmanId]
  );
  if (!activeRows.length) {
    return res.status(409).json({ error: "Start Day is not active. Location tracking is unavailable." });
  }

  const pingConfig = locationPingConfig();
  const persisted = shouldPersistLocationPing({
    previous: activeRows[0], lat: latNum, lng: lngNum, capturedAt,
    minDistanceM: pingConfig.minDistanceM, maxGapMs: pingConfig.maxGapMs,
  });

  if (persisted) {
    await db.query(
      `INSERT INTO location_pings
         (salesman_id, latitude, longitude, accuracy_m, speed_mps, battery_pct, is_mock_suspected, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [salesmanId, latNum, lngNum, accuracyM, speedMps, batteryPct, !!isMockSuspected, capturedAt]
    );
  }

  // Live presence is refreshed on every accepted ping even if the historical
  // row was deduplicated. Admin live-map behavior therefore stays unchanged.
  await db.query(
    `UPDATE salesman_profiles
     SET last_lat = $2, last_lng = $3, last_battery_pct = $4, last_speed_mps = $5, last_seen_at = now()
     WHERE user_id = $1`,
    [salesmanId, latNum, lngNum, batteryPct, speedMps]
  );

  const broadcast = req.app.get("broadcastToAdmins");
  if (typeof broadcast === "function") {
    broadcast({ type: "location_update", salesman: {
      id: salesmanId, lat: latNum, lng: lngNum, batteryPct, speedMps, status: "online", lastSeenAt: new Date().toISOString()
    }});
  }

  if (isMockSuspected) {
    await notify({ type: "mock_gps_suspected", salesmanId, payload: { lat: latNum, lng: lngNum } });
  }
  if (accuracyM != null && accuracyM > 100) {
    await notify({ type: "poor_accuracy", salesmanId, payload: { accuracyM } });
  }

  res.json({ ok: true, persisted });
});'''
salesman = replace_once(salesman, old_ping, new_ping, 'salesman location ping route')
salesman_path.write_text(salesman)

# --- admin day-route query --------------------------------------------------
admin_path = Path('src/routes/admin.routes.js')
admin = admin_path.read_text()
old_history = r'''router.get("/salesmen/:id/history", async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const { rows } = await db.query(
    `SELECT latitude, longitude, accuracy_m, speed_mps, battery_pct, captured_at
     FROM location_pings
     WHERE salesman_id = $1 AND captured_at::date = $2
     ORDER BY captured_at ASC`,
    [req.params.id, date]
  );
  const leads = await db.query(
    `SELECT id, business_name, latitude, longitude, verification_status, created_at
     FROM leads WHERE salesman_id = $1 AND created_at::date = $2`,
    [req.params.id, date]
  );
  const attendance = await db.query(
    `SELECT
       MIN(start_day_at) AS start_day_at, MAX(end_day_at) AS end_day_at,
       (array_agg(start_lat ORDER BY start_day_at ASC))[1] AS start_lat,
       (array_agg(start_lng ORDER BY start_day_at ASC))[1] AS start_lng,
       (array_agg(end_lat ORDER BY end_day_at DESC NULLS LAST))[1] AS end_lat,
       (array_agg(end_lng ORDER BY end_day_at DESC NULLS LAST))[1] AS end_lng,
       SUM(total_distance_m) AS total_distance_m, COUNT(*) AS session_count
     FROM attendance WHERE salesman_id = $1 AND day = $2`,
    [req.params.id, date]
  );
  res.json({ route: rows, leads: leads.rows, attendance: attendance.rows[0]?.start_day_at ? attendance.rows[0] : null });
});'''
new_history = r'''router.get("/salesmen/:id/history", async (req, res) => {
  const istToday = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  const date = req.query.date || istToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date" });

  const { rows } = await db.query(
    `SELECT latitude, longitude, accuracy_m, speed_mps, battery_pct, captured_at
     FROM location_pings
     WHERE salesman_id = $1
       AND captured_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
       AND captured_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
     ORDER BY captured_at ASC`,
    [req.params.id, date]
  );
  const leads = await db.query(
    `SELECT id, business_name, latitude, longitude, verification_status, created_at
     FROM leads
     WHERE salesman_id = $1
       AND created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
       AND created_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`,
    [req.params.id, date]
  );
  const attendance = await db.query(
    `SELECT
       MIN(start_day_at) AS start_day_at, MAX(end_day_at) AS end_day_at,
       (array_agg(start_lat ORDER BY start_day_at ASC))[1] AS start_lat,
       (array_agg(start_lng ORDER BY start_day_at ASC))[1] AS start_lng,
       (array_agg(end_lat ORDER BY end_day_at DESC NULLS LAST))[1] AS end_lat,
       (array_agg(end_lng ORDER BY end_day_at DESC NULLS LAST))[1] AS end_lng,
       SUM(total_distance_m) AS total_distance_m, COUNT(*) AS session_count
     FROM attendance WHERE salesman_id = $1 AND day = $2`,
    [req.params.id, date]
  );
  res.json({ route: rows, leads: leads.rows, attendance: attendance.rows[0]?.start_day_at ? attendance.rows[0] : null });
});'''
admin = replace_once(admin, old_history, new_history, 'admin route history query')
admin_path.write_text(admin)

# --- daily cleanup integration ---------------------------------------------
cron_path = Path('src/routes/cronSafe.routes.js')
cron = cron_path.read_text()
cron = replace_once(
    cron,
    "const { runSalesBriefings } = require('../utils/salesBriefing');\n",
    "const { runSalesBriefings } = require('../utils/salesBriefing');\nconst { cleanupLocationPings } = require('../utils/locationPings');\n",
    'cron cleanup import',
)
old_daily = r'''router.post('/run-daily-reminders', (req,res) => guarded(req,res,'daily-reminders', async()=>{
  const reminders = await runDailyReminders();
  const tasks = await require('../utils/taskReminders').runTaskReminders();
  const quotations = await require('../utils/quotations').runQuotationReminders();
  return { reminders, tasks, quotations };
}));'''
new_daily = r'''router.post('/run-daily-reminders', (req,res) => guarded(req,res,'daily-reminders', async()=>{
  const reminders = await runDailyReminders();
  const tasks = await require('../utils/taskReminders').runTaskReminders();
  const quotations = await require('../utils/quotations').runQuotationReminders();
  const locationPings = await cleanupLocationPings();
  return { reminders, tasks, quotations, locationPings };
}));'''
cron = replace_once(cron, old_daily, new_daily, 'daily cron cleanup')
cron_path.write_text(cron)

# --- migration --------------------------------------------------------------
Path('src/migrations/099_location_ping_scaling.sql').write_text(r'''-- Raw GPS pings are high-volume operational history. The existing
-- (salesman_id, captured_at DESC) index serves last-fix and daily route reads.
-- This global captured_at index keeps bounded retention cleanup efficient.
CREATE INDEX IF NOT EXISTS idx_location_pings_captured_at
  ON location_pings (captured_at);
''')

# --- tests ------------------------------------------------------------------
Path('test/locationPings.test.js').write_text(r'''const test = require('node:test');
const assert = require('node:assert/strict');
const {
  locationPingConfig,
  haversineMeters,
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
''')

print('GPS scaling changes prepared')
