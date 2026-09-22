const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { assessReading } = require("../utils/verification");
const { logActivity, notify } = require("../utils/logging");
const { notifyStatusChange, notifyUsers } = require("../utils/pushNotifications");
const { getCrmSettings, validateLeadAgainstSettings } = require("../utils/crmSettings");
const { permissions } = require("../utils/dayClosing");
const { findLeadDuplicates } = require("../utils/duplicateProtection");

const router = express.Router();
router.use(requireAuth, requireRole("salesman"));

// GET /salesman/settings — read-only view of the Lead/Location settings
// the admin configured, so the app knows which fields to mark required
// and whether to even attempt GPS capture. No write access from this side.
router.get("/settings", async (req, res) => {
  const settings = await getCrmSettings();
  const employeePermissions = await permissions(db.query, req.user.id);
  res.json({ leadSettings: settings.lead_settings, locationSettings: settings.location_settings, messageSettings: settings.message_settings || { employeeRepliesEnabled: true }, employeePermissions: { allowLeadWithoutStartDay: !!employeePermissions.allow_lead_without_start_day } });
});

// POST /salesman/leads/duplicate-check — checks the shared CRM before save.
router.post("/leads/duplicate-check", async (req, res) => {
  const settings = await getCrmSettings();
  const ls = settings.lead_settings || {};
  if (ls.duplicateProtectionEnabled === false) return res.json({ matches: [], blocking: false });
  const matches = await findLeadDuplicates({
    phone: ls.duplicateCheckPhone === false ? null : req.body.phone,
    businessName: ls.duplicateCheckBusinessLocation === false ? null : req.body.businessName,
    subLocation: ls.duplicateCheckBusinessLocation === false ? null : req.body.subLocation,
  });
  const phoneMatch = matches.some(m => m.matchType === "phone");
  res.json({ matches, blocking: phoneMatch && ls.allowDuplicateOverride !== true, allowOverride: ls.allowDuplicateOverride === true });
});

// GET /salesman/my-performance?month=YYYY-MM-DD
// Read-only monthly target + actual won/sales metrics for the signed-in salesman.
router.get("/my-performance", async (req, res) => {
  const month = /^\d{4}-\d{2}-\d{2}$/.test(req.query.month || "") ? req.query.month : null;
  const { rows } = await db.query(`
    WITH bounds AS (
      SELECT date_trunc('month',COALESCE($2::date,(now() AT TIME ZONE 'Asia/Kolkata')::date))::date AS start_day,
             (date_trunc('month',COALESCE($2::date,(now() AT TIME ZONE 'Asia/Kolkata')::date))+interval '1 month - 1 day')::date AS end_day
    ), won_this_month AS (
      SELECT DISTINCT l.id, coalesce(l.deal_value,0)::numeric AS deal_value
      FROM leads l
      CROSS JOIN bounds b
      WHERE l.salesman_id=$1
        AND l.status='won'
        AND EXISTS (
          SELECT 1
          FROM activity_logs al
          WHERE al.entity_id=l.id
            AND al.actor_id=$1
            AND al.action='lead.status_changed'
            AND al.metadata->>'to'='won'
            AND (al.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN b.start_day AND b.end_day
        )
    ), actual AS (
      SELECT count(*)::int AS won,
             coalesce(sum(deal_value),0)::numeric AS sales_value
      FROM won_this_month
    )
    SELECT b.start_day,b.end_day,coalesce(t.won_target,0)::int AS won_target,
           coalesce(t.sales_value_target,0)::numeric AS sales_value_target,
           a.won,a.sales_value
    FROM bounds b CROSS JOIN actual a
    LEFT JOIN sales_targets t ON t.salesman_id=$1 AND t.month=b.start_day
  `,[req.user.id,month]);
  const r=rows[0];
  res.json({...r,sales_value:Number(r.sales_value||0),sales_value_target:Number(r.sales_value_target||0)});
});

// GET /salesman/lead-options — read-only, populates the Category/POS Name
// dropdowns in Add Lead with whatever the admin has configured.
router.get("/lead-options", async (req, res) => {
  const { rows } = await db.query(
    `SELECT field_key, value FROM lead_field_options ORDER BY field_key, value`
  );
  const grouped = { category: [], pos_name: [], sub_location: [] };
  for (const r of rows) {
    if (!grouped[r.field_key]) grouped[r.field_key] = [];
    grouped[r.field_key].push(r.value);
  }
  res.json({ options: grouped });
});

// GET /salesman/profile — own profile, including whatever the admin has
// set for daily_target/area/employee_code. The app was previously
// hardcoding the daily target to 8 client-side, ignoring this entirely.
router.get("/profile", async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.full_name, u.phone, sp.daily_target, sp.monthly_target, sp.area, sp.employee_code
     FROM users u JOIN salesman_profiles sp ON sp.user_id = u.id
     WHERE u.id = $1`,
    [req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Profile not found" });
  res.json({ profile: rows[0] });
});

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
async function broadcastSalesmanStatus(req, userId) {
  const broadcast = req.app.get("broadcastToAdmins");
  if (typeof broadcast !== "function") return;
  const { rows } = await db.query(
    `SELECT u.id, sp.status, sp.last_lat AS lat, sp.last_lng AS lng,
            sp.last_battery_pct AS "batteryPct", sp.last_speed_mps AS "speedMps",
            sp.last_seen_at AS "lastSeenAt"
       FROM users u JOIN salesman_profiles sp ON sp.user_id=u.id WHERE u.id=$1`,
    [userId]
  );
  if (rows[0]) broadcast({ type: "salesman_status", salesman: rows[0] });
}

router.post("/day/start", async (req, res) => {
 try {
   const result = await require('../utils/dayClosing').startDay(req.user.id,req.body);
   await broadcastSalesmanStatus(req, req.user.id);
   res.json(result);
 } catch(e){if(e.status)return res.status(e.status).json({error:e.message});throw e;}
});

// POST /salesman/day/end   { lat, lng }
router.post("/day/end", async (req, res) => {
  try {
    const result = await require('../utils/dayClosing').endDay(req.user.id,req.body);
    await broadcastSalesmanStatus(req, req.user.id);
    res.json(result);
  } catch(e){if(e.status)return res.status(e.status).json({error:e.message});throw e;}
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
});

// -----------------------------------------------------------------------
// POST /salesman/leads
// Body includes client_uuid (device-generated) for offline-safe idempotency.
router.post("/leads", async (req, res) => {
  const salesmanId = req.user.id;
  const {
    clientUuid, businessName, subLocation, posName, renewalMonth, renewalDate,
    contactName, phone, whatsapp, address, category,
    branchCount, estimatedRequirement, notes, photoUrl, status, dealValue, nextFollowUpDate,
    lat, lng, accuracyM, isMockSuspected, capturedAt, deviceId, reverseGeocodedAddress,
  } = req.body;

  if (!clientUuid) {
    return res.status(400).json({ error: "clientUuid is required" });
  }

  // Idempotent on client_uuid: if this lead was already synced (e.g. retried
  // after a flaky connection), return the existing row instead of erroring.
  const existing = await db.query(`SELECT * FROM leads WHERE client_uuid = $1`, [clientUuid]);
  if (existing.rows[0]) {
    return res.status(200).json({ lead: existing.rows[0], deduped: true });
  }

  const crmSettings = await getCrmSettings();
  const duplicateSettings = crmSettings.lead_settings || {};
  if (duplicateSettings.duplicateProtectionEnabled !== false && duplicateSettings.duplicateCheckPhone !== false && phone) {
    const duplicates = await findLeadDuplicates({ phone });
    const exactPhone = duplicates.find(m => m.matchType === "phone");
    if (exactPhone && !(duplicateSettings.allowDuplicateOverride === true && req.body.allowDuplicate === true)) {
      return res.status(409).json({ error: `Lead already exists: ${exactPhone.business_name}${exactPhone.salesman_name ? ` · Assigned to ${exactPhone.salesman_name}` : ""}`, code: "DUPLICATE_LEAD", duplicate: exactPhone, canOverride: duplicateSettings.allowDuplicateOverride === true });
    }
  }
  const employeePermissions = await permissions(db.query, salesmanId);
  const trustedLeadCapture = !!employeePermissions.allow_lead_without_start_day;

  // Normal salesmen must have an active Start Day before creating a lead.
  // Trusted employees can create leads without Start Day and without GPS.
  if (!trustedLeadCapture) {
    const active = await db.query(
      `SELECT id FROM attendance WHERE salesman_id=$1 AND start_day_at IS NOT NULL AND end_day_at IS NULL ORDER BY start_day_at DESC LIMIT 1`,
      [salesmanId]
    );
    if (!active.rows.length) return res.status(409).json({ error: "Start your day before adding a lead." });
  }

  const validationSettings = trustedLeadCapture
    ? { ...crmSettings, location_settings: { ...crmSettings.location_settings, locationMandatoryForNewLead: false } }
    : crmSettings;
  const check = validateLeadAgainstSettings(
    { businessName, subLocation, posName, contactName, phone, status, notes, dealValue, nextFollowUpDate, lat, lng },
    validationSettings
  );
  if (!check.ok) {
    return res.status(400).json({ error: check.error });
  }

  // GPS is only actually required/meaningful when the admin has GPS Location
  // turned on. When it's off, we accept the lead with no location at all.
  const gpsOn = crmSettings.location_settings.gpsLocation;
  const hasLocation = !trustedLeadCapture && gpsOn && lat != null && lng != null;

  let verification_status = null;
  if (hasLocation) {
    const settings = await getSettings();
    const lastKnown = await getLastKnown(salesmanId);
    ({ verification_status } = assessReading({
      lat, lng, accuracyM, isMockSuspected, capturedAt, lastKnown, settings,
    }));
  }

  const { rows } = await db.query(
    `INSERT INTO leads (
       client_uuid, salesman_id, business_name, sub_location, pos_name, renewal_month, renewal_date,
       contact_name, phone, whatsapp, address,
       category, branch_count, estimated_requirement, notes, photo_url, status, deal_value,
       latitude, longitude, accuracy_m, reverse_geocoded_address, captured_at, device_id,
       is_mock_suspected, verification_status, next_follow_up_date, synced_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($17,'cold')::lead_status,$18,
       $19,$20,$21,$22,$23,$24,$25,$26,$27, now()
     ) RETURNING *`,
    [
      clientUuid, salesmanId, businessName, subLocation, posName, renewalMonth, renewalDate || null,
      contactName, phone, whatsapp, address,
      category, branchCount, estimatedRequirement, notes, photoUrl, status, dealValue || null,
      hasLocation ? lat : null, hasLocation ? lng : null, hasLocation ? accuracyM : null,
      hasLocation ? reverseGeocodedAddress : null, hasLocation ? capturedAt : null, hasLocation ? deviceId : null,
      hasLocation ? !!isMockSuspected : false, hasLocation ? verification_status : null, nextFollowUpDate || null,
    ]
  );
  const lead = rows[0];

  await notify({ type: "new_lead", salesmanId, leadId: lead.id, payload: { businessName, verification_status } });
  await logActivity({ actorId: salesmanId, action: "lead.created", entityType: "lead", entityId: lead.id, metadata: { verification_status, businessName: lead.business_name } });
  if (lead.status && lead.status !== "cold") {
    notifyStatusChange(lead, { isNew: true }).catch((err) => console.error("push notify failed:", err.message));
  }

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

// GET /salesman/leads/:id — full detail view of one of the salesman's own leads
router.get("/leads/:id", async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM leads WHERE id = $1 AND salesman_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Lead not found" });
  res.json({ lead: rows[0] });
});

// PATCH /salesman/leads/:id  — status/notes only; location fields are
// rejected by the DB trigger even if someone tries to sneak them in here.
router.patch("/leads/:id", async (req, res) => {
  const { id } = req.params;
  const { status, notes, subLocation, posName, renewalMonth, renewalDate, contactName, phone, dealValue, nextFollowUpDate } = req.body;

  const owned = await db.query(`SELECT * FROM leads WHERE id = $1 AND salesman_id = $2`, [id, req.user.id]);
  if (!owned.rows[0]) return res.status(404).json({ error: "Lead not found" });

  const { rows } = await db.query(
    `UPDATE leads SET
       status = COALESCE($3, status),
       notes = COALESCE($4, notes),
       sub_location = COALESCE($5, sub_location),
       pos_name = COALESCE($6, pos_name),
       renewal_month = COALESCE($7, renewal_month),
       renewal_date = COALESCE($8, renewal_date),
       contact_name = COALESCE($9, contact_name),
       phone = COALESCE($10, phone),
       deal_value = COALESCE($11, deal_value),
       next_follow_up_date = CASE WHEN $13 THEN $12::date ELSE next_follow_up_date END
     WHERE id = $1 AND salesman_id = $2 RETURNING *`,
    [id, req.user.id, status, notes, subLocation, posName, renewalMonth, renewalDate, contactName, phone, dealValue, nextFollowUpDate, Object.prototype.hasOwnProperty.call(req.body, "nextFollowUpDate")]
  );

  if (status && status !== owned.rows[0].status) {
    await db.query(
      `INSERT INTO lead_status_history (lead_id, changed_by, old_status, new_status) VALUES ($1,$2,$3,$4)`,
      [id, req.user.id, owned.rows[0].status, status]
    );
    if (status === "won") await notify({ type: "lead_converted", salesmanId: req.user.id, leadId: id, payload: {} });
    await logActivity({ actorId: req.user.id, action: "lead.status_changed", entityType: "lead", entityId: id, metadata: { from: owned.rows[0].status, to: status, businessName: rows[0].business_name } });
    notifyStatusChange(rows[0]).catch((err) => console.error("push notify failed:", err.message));
  }
  const before = owned.rows[0];
  const after = rows[0];
  const businessName = after.business_name;
  const followUpProvided = Object.prototype.hasOwnProperty.call(req.body, "nextFollowUpDate");
  const oldFollowUp = before.next_follow_up_date ? String(before.next_follow_up_date).slice(0, 10) : null;
  const newFollowUp = after.next_follow_up_date ? String(after.next_follow_up_date).slice(0, 10) : null;

  if (followUpProvided && oldFollowUp !== newFollowUp) {
    const action = oldFollowUp && !newFollowUp ? "lead.follow_up_done"
      : !oldFollowUp && newFollowUp ? "lead.follow_up_scheduled"
      : "lead.follow_up_rescheduled";
    await logActivity({ actorId: req.user.id, action, entityType: "lead", entityId: id,
      metadata: { businessName, from: oldFollowUp, to: newFollowUp } });
  }

  if (notes != null && String(before.notes || "") !== String(after.notes || "")) {
    await logActivity({ actorId: req.user.id, action: "lead.comment_updated", entityType: "lead", entityId: id,
      metadata: { businessName, from: before.notes || "", to: after.notes || "" } });
  }

  const fieldMap = { subLocation: "sub_location", posName: "pos_name", renewalMonth: "renewal_month",
    renewalDate: "renewal_date", contactName: "contact_name", phone: "phone", dealValue: "deal_value" };
  const changes = {};
  for (const [apiField, dbField] of Object.entries(fieldMap)) {
    if (req.body[apiField] != null && String(before[dbField] ?? "") !== String(after[dbField] ?? "")) {
      changes[apiField] = { from: before[dbField], to: after[dbField] };
    }
  }
  if (Object.keys(changes).length) {
    await logActivity({ actorId: req.user.id, action: "lead.edited", entityType: "lead", entityId: id,
      metadata: { businessName, changes } });
  }

  res.json({ lead: rows[0] });
});

// GET /salesman/leads/:id/history — status-change timeline for one of the
// salesman's own leads (who changed it, from what, to what, when).
router.get("/leads/:id/history", async (req, res) => {
  const owned = await db.query(`SELECT id FROM leads WHERE id = $1 AND salesman_id = $2`, [req.params.id, req.user.id]);
  if (!owned.rows[0]) return res.status(404).json({ error: "Lead not found" });

  const { rows } = await db.query(
    `SELECT a.id, a.action,
            a.metadata->>'from' AS old_value,
            a.metadata->>'to' AS new_value,
            CASE WHEN a.action='lead.status_changed' THEN a.metadata->>'from' END AS old_status,
            CASE WHEN a.action='lead.status_changed' THEN a.metadata->>'to' END AS new_status,
            a.metadata->'changes' AS changes,
            a.metadata->>'body' AS message_body,
            a.metadata->>'recipientName' AS recipient_name,
            a.metadata->>'messageId' AS message_id,
            a.created_at AS changed_at,
            COALESCE(u.full_name, 'Former user') AS changed_by_name
     FROM activity_logs a
     LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.entity_type='lead' AND a.entity_id=$1
       AND a.action IN ('lead.created','lead.created_by_admin','lead.status_changed',
                        'lead.follow_up_scheduled','lead.follow_up_rescheduled','lead.follow_up_done',
                        'lead.comment_updated','lead.edited','lead.admin_mention','lead.employee_reply')
       AND (
         a.action NOT IN ('lead.admin_mention','lead.employee_reply')
         OR NOT EXISTS (
           SELECT 1 FROM messages dm
           WHERE dm.id::text = a.metadata->>'messageId' AND dm.deleted_at IS NOT NULL
         )
       )
     ORDER BY a.created_at ASC`,
    [req.params.id]
  );
  res.json({ history: rows });
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

// -----------------------------------------------------------------------
// GET /salesman/messages — own inbox, newest first
router.get("/messages", async (req, res) => {
  const { rows } = await db.query(
    `SELECT m.id,m.sender_id,m.body,m.created_at,m.read_at,m.lead_id,m.message_type,m.parent_message_id,m.thread_root_id,
            l.business_name,COALESCE(u.full_name,'Admin') AS sender_name
     FROM messages m
     LEFT JOIN leads l ON l.id=m.lead_id
     LEFT JOIN users u ON u.id=m.sender_id
     WHERE m.recipient_id = $1 AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json({ messages: rows });
});


// POST /salesman/messages/:id/reply — reply to an Admin lead message.
// Replies are immutable, stay on the same lead/thread, and are also logged to Lead Activity.
router.post("/messages/:id/reply", async (req, res) => {
  const body = String(req.body?.body || "").trim();
  if (!body) return res.status(400).json({ error: "Reply is required" });
  if (body.length > 2000) return res.status(400).json({ error: "Reply is too long" });

  const settings = await getCrmSettings();
  if (settings.message_settings?.employeeRepliesEnabled === false) {
    return res.status(403).json({ error: "Employee replies are disabled by Admin" });
  }

  const parentResult = await db.query(
    `SELECT m.id,m.sender_id,m.recipient_id,m.lead_id,m.thread_root_id,l.business_name,l.salesman_id
     FROM messages m JOIN leads l ON l.id=m.lead_id
     WHERE m.id=$1 AND m.recipient_id=$2 AND m.lead_id IS NOT NULL AND m.message_type='lead_mention' AND m.deleted_at IS NULL`,
    [req.params.id, req.user.id]
  );
  const parent = parentResult.rows[0];
  if (!parent) return res.status(404).json({ error: "Lead message not found" });
  if (parent.salesman_id !== req.user.id) return res.status(403).json({ error: "You no longer have access to this lead" });

  const { rows } = await db.query(
    `INSERT INTO messages (sender_id,recipient_id,body,lead_id,message_type,parent_message_id,thread_root_id)
     VALUES ($1,$2,$3,$4,'lead_reply',$5,$6) RETURNING *`,
    [req.user.id, parent.sender_id, body, parent.lead_id, parent.id, parent.thread_root_id || parent.id]
  );
  await logActivity({ actorId:req.user.id, action:'lead.employee_reply', entityType:'lead', entityId:parent.lead_id,
    metadata:{ recipientId:parent.sender_id, body, messageId:rows[0].id, parentMessageId:parent.id } });

  const [admins, sender] = await Promise.all([
    db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`),
    db.query(`SELECT full_name FROM users WHERE id=$1`, [req.user.id])
  ]);
  notifyUsers(admins.rows.map(x=>x.id), null, {
    title:`${sender.rows[0]?.full_name || 'Salesman'} replied · ${parent.business_name}`,
    body:body.slice(0,180), url:`/#lead=${parent.lead_id}`
  }).catch(err=>console.error('lead reply push failed:',err.message));

  res.status(201).json({ message:{...rows[0],business_name:parent.business_name} });
});

// PATCH /salesman/messages/:id/read
router.patch("/messages/:id/read", async (req, res) => {
  const { rows } = await db.query(
    `UPDATE messages SET read_at = now() WHERE id = $1 AND recipient_id = $2 AND read_at IS NULL RETURNING *`,
    [req.params.id, req.user.id]
  );
  res.json({ message: rows[0] || null });
});

// DELETE /salesman/messages/:id — remove from own inbox only
router.delete("/messages/:id", async (req, res) => {
  const existing = await db.query(`SELECT id,lead_id FROM messages WHERE id=$1 AND recipient_id=$2`, [req.params.id, req.user.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Message not found" });
  if (existing.rows[0].lead_id) return res.status(409).json({ error: "Lead conversation messages are permanent and cannot be deleted" });
  await db.query(`DELETE FROM messages WHERE id=$1 AND recipient_id=$2`, [req.params.id, req.user.id]);
  res.json({ ok: true });
});

module.exports = router;
