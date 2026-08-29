const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { assessReading } = require("../utils/verification");
const { logActivity, notify } = require("../utils/logging");

const router = express.Router();
router.use(requireAuth, requireRole("salesman"));

async function getSettings() {
  const { rows } = await db.query(`SELECT * FROM verification_settings ORDER BY updated_at DESC LIMIT 1`);
  return rows[0];
}

async function getLastKnown(salesmanId) {
  const { rows } = await db.query(
    `SELECT latitude AS lat, longitude AS lng, captured_at
     FROM location_pings WHERE salesman_id = $1 ORDER BY captured_at DESC LIMIT 1`,
    [salesmanId]
  );
  return rows[0] || null;
}

// -----------------------------------------------------------------------
// POST /salesman/day/start   { lat, lng }
router.post("/day/start", async (req, res) => {
  const { lat, lng } = req.body;
  const salesmanId = req.user.id;
  const today = new Date().toISOString().slice(0, 10);

  await db.query(
    `INSERT INTO attendance (salesman_id, day, start_day_at, start_lat, start_lng)
     VALUES ($1, $2, now(), $3, $4)
     ON CONFLICT (salesman_id, day)
     DO UPDATE SET start_day_at = now(), start_lat = $3, start_lng = $4`,
    [salesmanId, today, lat, lng]
  );
  await db.query(
    `UPDATE salesman_profiles SET status = 'online', last_seen_at = now() WHERE user_id = $1`,
    [salesmanId]
  );
  await notify({ type: "day_started", salesmanId, payload: { lat, lng } });
  await logActivity({ actorId: salesmanId, action: "attendance.day_start", entityType: "attendance", entityId: null });

  res.json({ ok: true });
});

// POST /salesman/day/end   { lat, lng }
router.post("/day/end", async (req, res) => {
  const { lat, lng } = req.body;
  const salesmanId = req.user.id;
  const today = new Date().toISOString().slice(0, 10);

  await db.query(
    `UPDATE attendance SET end_day_at = now(), end_lat = $2, end_lng = $3
     WHERE salesman_id = $1 AND day = $4`,
    [salesmanId, lat, lng, today]
  );
  await db.query(
    `UPDATE salesman_profiles SET status = 'offline', last_seen_at = now() WHERE user_id = $1`,
    [salesmanId]
  );
  await notify({ type: "day_ended", salesmanId, payload: { lat, lng } });
  await logActivity({ actorId: salesmanId, action: "attendance.day_end", entityType: "attendance", entityId: null });

  res.json({ ok: true });
});

// -----------------------------------------------------------------------
// POST /salesman/location/ping
// Body: { lat, lng, accuracyM, speedMps, batteryPct, isMockSuspected, capturedAt }
// Called every ~10-30s by the device while the day is active.
router.post("/location/ping", async (req, res) => {
  const salesmanId = req.user.id;
  const { lat, lng, accuracyM, speedMps, batteryPct, isMockSuspected, capturedAt } = req.body;

  if (lat == null || lng == null || !capturedAt) {
    return res.status(400).json({ error: "lat, lng and capturedAt are required" });
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

  if (isMockSuspected) {
    await notify({ type: "mock_gps_suspected", salesmanId, payload: { lat, lng } });
  }
  if (accuracyM != null && accuracyM > 100) {
    await notify({ type: "poor_accuracy", salesmanId, payload: { accuracyM } });
  }

  res.json({ ok: true });
});

// -----------------------------------------------------------------------
// POST /salesman/leads
// Body includes client_uuid (device-generated) for offline-safe idempotency.
router.post("/leads", async (req, res) => {
  const salesmanId = req.user.id;
  const {
    clientUuid, businessName, contactName, phone, whatsapp, address, category,
    branchCount, currentPos, estimatedRequirement, notes, photoUrl,
    lat, lng, accuracyM, isMockSuspected, capturedAt, deviceId, reverseGeocodedAddress,
  } = req.body;

  if (!clientUuid || !businessName || lat == null || lng == null || accuracyM == null || !capturedAt || !deviceId) {
    return res.status(400).json({ error: "Missing required fields (clientUuid, businessName, lat, lng, accuracyM, capturedAt, deviceId)" });
  }

  // Idempotent on client_uuid: if this lead was already synced (e.g. retried
  // after a flaky connection), return the existing row instead of erroring.
  const existing = await db.query(`SELECT * FROM leads WHERE client_uuid = $1`, [clientUuid]);
  if (existing.rows[0]) {
    return res.status(200).json({ lead: existing.rows[0], deduped: true });
  }

  const settings = await getSettings();
  const lastKnown = await getLastKnown(salesmanId);
  const { verification_status, flags } = assessReading({
    lat, lng, accuracyM, isMockSuspected, capturedAt, lastKnown, settings,
  });

  const { rows } = await db.query(
    `INSERT INTO leads (
       client_uuid, salesman_id, business_name, contact_name, phone, whatsapp, address,
       category, branch_count, current_pos, estimated_requirement, notes, photo_url,
       latitude, longitude, accuracy_m, reverse_geocoded_address, captured_at, device_id,
       is_mock_suspected, verification_status, synced_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now()
     ) RETURNING *`,
    [
      clientUuid, salesmanId, businessName, contactName, phone, whatsapp, address,
      category, branchCount, currentPos, estimatedRequirement, notes, photoUrl,
      lat, lng, accuracyM, reverseGeocodedAddress, capturedAt, deviceId,
      !!isMockSuspected, verification_status,
    ]
  );
  const lead = rows[0];

  await notify({ type: "new_lead", salesmanId, leadId: lead.id, payload: { businessName, verification_status } });
  for (const flag of flags) {
    if (flag !== "poor_accuracy") { // already covered by verification_status on the lead itself
      await notify({ type: flag, salesmanId, leadId: lead.id, payload: {} });
    }
  }
  await logActivity({ actorId: salesmanId, action: "lead.created", entityType: "lead", entityId: lead.id, metadata: { verification_status, flags } });

  res.status(201).json({ lead, deduped: false });
});

// GET /salesman/leads  — own leads only
router.get("/leads", async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM leads WHERE salesman_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ leads: rows });
});

// PATCH /salesman/leads/:id  — status/notes only; location fields are
// rejected by the DB trigger even if someone tries to sneak them in here.
router.patch("/leads/:id", async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;

  const owned = await db.query(`SELECT id, status FROM leads WHERE id = $1 AND salesman_id = $2`, [id, req.user.id]);
  if (!owned.rows[0]) return res.status(404).json({ error: "Lead not found" });

  const { rows } = await db.query(
    `UPDATE leads SET status = COALESCE($3, status), notes = COALESCE($4, notes) WHERE id = $1 AND salesman_id = $2 RETURNING *`,
    [id, req.user.id, status, notes]
  );

  if (status && status !== owned.rows[0].status) {
    await db.query(
      `INSERT INTO lead_status_history (lead_id, changed_by, old_status, new_status) VALUES ($1,$2,$3,$4)`,
      [id, req.user.id, owned.rows[0].status, status]
    );
    if (status === "won") await notify({ type: "lead_converted", salesmanId: req.user.id, leadId: id, payload: {} });
    await logActivity({ actorId: req.user.id, action: "lead.status_changed", entityType: "lead", entityId: id, metadata: { from: owned.rows[0].status, to: status } });
  }

  res.json({ lead: rows[0] });
});

// -----------------------------------------------------------------------
// POST /salesman/visits/start
router.post("/visits/start", async (req, res) => {
  const { clientUuid, businessName, lat, lng, accuracyM, leadId } = req.body;
  if (!clientUuid || lat == null || lng == null) {
    return res.status(400).json({ error: "clientUuid, lat and lng are required" });
  }

  const existing = await db.query(`SELECT * FROM visits WHERE client_uuid = $1`, [clientUuid]);
  if (existing.rows[0]) return res.json({ visit: existing.rows[0], deduped: true });

  const { rows } = await db.query(
    `INSERT INTO visits (client_uuid, salesman_id, lead_id, business_name, latitude, longitude, accuracy_m, arrived_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING *`,
    [clientUuid, req.user.id, leadId || null, businessName, lat, lng, accuracyM]
  );
  await db.query(`UPDATE salesman_profiles SET status = 'on_visit' WHERE user_id = $1`, [req.user.id]);

  res.status(201).json({ visit: rows[0] });
});

// POST /salesman/visits/:id/end
router.post("/visits/:id/end", async (req, res) => {
  const { notes, photoUrls, leadCreated } = req.body;
  const { rows } = await db.query(
    `UPDATE visits SET left_at = now(), notes = COALESCE($3, notes),
        photo_urls = COALESCE($4, photo_urls), lead_created = COALESCE($5, lead_created)
     WHERE id = $1 AND salesman_id = $2 RETURNING *`,
    [req.params.id, req.user.id, notes, photoUrls, leadCreated]
  );
  if (!rows[0]) return res.status(404).json({ error: "Visit not found" });

  await db.query(`UPDATE salesman_profiles SET status = 'online' WHERE user_id = $1`, [req.user.id]);
  res.json({ visit: rows[0] });
});

module.exports = router;
