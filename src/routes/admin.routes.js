const express = require("express");
const bcrypt = require("bcryptjs");
const XLSX = require("xlsx");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logActivity } = require("../utils/logging");
const { getCrmSettings } = require("../utils/crmSettings");

// The exact 9 fields the spec wants in every export, in this exact order.
// Keep the export logic centered on this list so CSV/XLSX/Sheets can never
// drift out of sync with each other or pick up extra columns later.
const EXPORT_FIELDS = [
  { key: "business_name", label: "Business Name" },
  { key: "sub_location", label: "Sub Location" },
  { key: "pos_name", label: "POS Name" },
  { key: "renewal_month", label: "Renewal Month" },
  { key: "renewal_date", label: "Renewal Date" },
  { key: "status", label: "Status" },
  { key: "contact_name", label: "Contact Name" },
  { key: "phone", label: "Contact Number" },
  { key: "notes", label: "Comments" },
];

async function fetchExportRows({ salesmanId, status, date }) {
  const clauses = [];
  const params = [];
  let i = 1;
  if (salesmanId) { clauses.push(`l.salesman_id = $${i++}`); params.push(salesmanId); }
  if (status) { clauses.push(`l.status = $${i++}`); params.push(status); }
  if (date) { clauses.push(`l.created_at::date = $${i++}`); params.push(date); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const { rows } = await db.query(
    `SELECT l.business_name, l.sub_location, l.pos_name, l.renewal_month, l.renewal_date,
            l.status, l.contact_name, l.phone, l.notes
     FROM leads l
     ${where} ORDER BY l.created_at DESC`,
    params
  );
  return rows;
}

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

// -----------------------------------------------------------------------
// GET /admin/dashboard/summary
router.get("/dashboard/summary", async (req, res) => {
  const [salesmen, activeSalesmen, totalLeads, leadsToday, converted, pending] = await Promise.all([
    db.query(`SELECT count(*) FROM users WHERE role = 'salesman' AND is_active`),
    db.query(`SELECT count(*) FROM salesman_profiles WHERE status != 'offline'`),
    db.query(`SELECT count(*) FROM leads`),
    db.query(`SELECT count(*) FROM leads WHERE created_at >= now() - interval '24 hours'`),
    db.query(`SELECT count(*) FROM leads WHERE status = 'won'`),
    db.query(`SELECT count(*) FROM leads WHERE status NOT IN ('won','lost')`),
  ]);

  res.json({
    totalSalesmen: Number(salesmen.rows[0].count),
    activeSalesmen: Number(activeSalesmen.rows[0].count),
    totalLeads: Number(totalLeads.rows[0].count),
    leadsToday: Number(leadsToday.rows[0].count),
    leadsConverted: Number(converted.rows[0].count),
    leadsPending: Number(pending.rows[0].count),
  });
});

// GET /admin/salesmen — live roster with last known position
router.get("/salesmen", async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.full_name, u.phone, u.photo_url, u.is_active,
            sp.status, sp.last_lat, sp.last_lng, sp.last_battery_pct, sp.last_speed_mps,
            sp.last_seen_at, sp.daily_target, sp.employee_code, sp.area
     FROM users u JOIN salesman_profiles sp ON sp.user_id = u.id
     WHERE u.role = 'salesman'
     ORDER BY u.full_name`
  );
  res.json({ salesmen: rows });
});

// POST /admin/salesmen — create a new salesman
router.post("/salesmen", async (req, res) => {
  const { fullName, phone, email, password, employeeCode, dailyTarget, area } = req.body;
  if (!fullName || !phone || !password) {
    return res.status(400).json({ error: "fullName, phone and password are required" });
  }
  const passwordHash = await bcrypt.hash(password, 10);

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO users (role, full_name, phone, email, password_hash)
       VALUES ('salesman', $1, $2, $3, $4) RETURNING id, full_name, phone`,
      [fullName, phone, email, passwordHash]
    );
    const user = rows[0];
    await client.query(
      `INSERT INTO salesman_profiles (user_id, employee_code, daily_target, area) VALUES ($1,$2,$3,$4)`,
      [user.id, employeeCode, dailyTarget || 8, area]
    );
    await client.query("COMMIT");
    await logActivity({ actorId: req.user.id, action: "salesman.created", entityType: "user", entityId: user.id });
    res.status(201).json({ salesman: user });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "Phone number already in use" });
    throw err;
  } finally {
    client.release();
  }
});

// PATCH /admin/salesmen/:id — full edit (name/phone/password/area/employee
// code/target) as well as activate/deactivate. Password is only updated
// when a new one is actually supplied.
router.patch("/salesmen/:id", async (req, res) => {
  const { isActive, dailyTarget, fullName, phone, password, area, employeeCode } = req.body;
  const { id } = req.params;

  try {
    if (fullName != null || phone != null || isActive != null || password) {
      const passwordHash = password ? await bcrypt.hash(password, 10) : null;
      await db.query(
        `UPDATE users SET
           full_name = COALESCE($2, full_name),
           phone = COALESCE($3, phone),
           is_active = COALESCE($4, is_active),
           password_hash = COALESCE($5, password_hash)
         WHERE id = $1`,
        [id, fullName, phone, isActive, passwordHash]
      );
    }
    if (dailyTarget != null || area != null || employeeCode != null) {
      await db.query(
        `UPDATE salesman_profiles SET
           daily_target = COALESCE($2, daily_target),
           area = COALESCE($3, area),
           employee_code = COALESCE($4, employee_code)
         WHERE user_id = $1`,
        [id, dailyTarget, area, employeeCode]
      );
    }
    await logActivity({ actorId: req.user.id, action: "salesman.updated", entityType: "user", entityId: id, metadata: req.body });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Phone number already in use" });
    throw err;
  }
});

// DELETE /admin/salesmen/:id — permanent delete. Blocked by the DB itself
// (leads.salesman_id has no cascade) while the salesman still has any
// leads — that's the intended rule: delete their leads first.
router.delete("/salesmen/:id", async (req, res) => {
  try {
    const { rowCount } = await db.query(`DELETE FROM users WHERE id = $1 AND role = 'salesman'`, [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: "Salesman not found" });
    await logActivity({ actorId: req.user.id, action: "salesman.deleted", entityType: "user", entityId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23503") {
      const { rows } = await db.query(`SELECT count(*) FROM leads WHERE salesman_id = $1`, [req.params.id]);
      return res.status(409).json({ error: `This salesman still has ${rows[0].count} lead(s). Delete their leads first.` });
    }
    throw err;
  }
});


// GET /admin/salesmen/:id/history?date=YYYY-MM-DD — route for that day
router.get("/salesmen/:id/history", async (req, res) => {
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
    `SELECT start_day_at, start_lat, start_lng, end_day_at, end_lat, end_lng
     FROM attendance WHERE salesman_id = $1 AND day = $2`,
    [req.params.id, date]
  );
  res.json({ route: rows, leads: leads.rows, attendance: attendance.rows[0] || null });
});

// -----------------------------------------------------------------------
// GET /admin/leads?salesmanId=&status=&from=&to=
router.get("/leads", async (req, res) => {
  const { salesmanId, status, from, to } = req.query;
  const clauses = [];
  const params = [];
  let i = 1;

  if (salesmanId) { clauses.push(`l.salesman_id = $${i++}`); params.push(salesmanId); }
  if (status) { clauses.push(`l.status = $${i++}`); params.push(status); }
  if (from) { clauses.push(`l.created_at >= $${i++}`); params.push(from); }
  if (to) { clauses.push(`l.created_at <= $${i++}`); params.push(to); }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await db.query(
    `SELECT l.*, u.full_name AS salesman_name
     FROM leads l JOIN users u ON u.id = l.salesman_id
     ${where} ORDER BY l.created_at DESC LIMIT 500`,
    params
  );
  res.json({ leads: rows });
});

// PATCH /admin/leads/:id/status
// PATCH /admin/leads/:id — general field edit (any lead, any salesman).
// Same editable field set as the salesman side; location/verification
// fields remain immutable (enforced by the DB trigger either way).
router.patch("/leads/:id", async (req, res) => {
  const { id } = req.params;
  const { subLocation, posName, renewalMonth, renewalDate, contactName, phone, notes } = req.body;

  const existing = await db.query(`SELECT id FROM leads WHERE id = $1`, [id]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Lead not found" });

  const { rows } = await db.query(
    `UPDATE leads SET
       sub_location = COALESCE($2, sub_location),
       pos_name = COALESCE($3, pos_name),
       renewal_month = COALESCE($4, renewal_month),
       renewal_date = COALESCE($5, renewal_date),
       contact_name = COALESCE($6, contact_name),
       phone = COALESCE($7, phone),
       notes = COALESCE($8, notes)
     WHERE id = $1 RETURNING *`,
    [id, subLocation, posName, renewalMonth, renewalDate, contactName, phone, notes]
  );
  await logActivity({ actorId: req.user.id, action: "lead.edited", entityType: "lead", entityId: id, metadata: req.body });

  res.json({ lead: rows[0] });
});

// DELETE /admin/leads/:id — permanent delete, admin only. Logged before
// deletion since the audit row can't reference a lead that no longer exists.
router.delete("/leads/:id", async (req, res) => {
  const existing = await db.query(`SELECT id, business_name FROM leads WHERE id = $1`, [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Lead not found" });

  await logActivity({ actorId: req.user.id, action: "lead.deleted", entityType: "lead", entityId: req.params.id, metadata: { businessName: existing.rows[0].business_name } });
  await db.query(`DELETE FROM leads WHERE id = $1`, [req.params.id]);

  res.json({ ok: true });
});

router.patch("/leads/:id/status", async (req, res) => {
  const { status } = req.body;
  const current = await db.query(`SELECT status FROM leads WHERE id = $1`, [req.params.id]);
  if (!current.rows[0]) return res.status(404).json({ error: "Lead not found" });

  const { rows } = await db.query(`UPDATE leads SET status = $2 WHERE id = $1 RETURNING *`, [req.params.id, status]);
  await db.query(
    `INSERT INTO lead_status_history (lead_id, changed_by, old_status, new_status) VALUES ($1,$2,$3,$4)`,
    [req.params.id, req.user.id, current.rows[0].status, status]
  );
  await logActivity({ actorId: req.user.id, action: "lead.status_changed", entityType: "lead", entityId: req.params.id, metadata: { from: current.rows[0].status, to: status } });

  res.json({ lead: rows[0] });
});

// GET /admin/leads/export.csv?salesmanId=&status=
// Only the 9 spec'd fields — nothing else, regardless of what's on the lead.
router.get("/leads/export.csv", async (req, res) => {
  const rows = await fetchExportRows(req.query);

  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = EXPORT_FIELDS.map((f) => f.label).map(escape).join(",");
  const lines = rows.map((r) => EXPORT_FIELDS.map((f) => escape(r[f.key])).join(","));

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=leads_export.csv");
  res.send([header, ...lines].join("\n"));
});

// GET /admin/leads/export.xlsx?salesmanId=&status=
router.get("/leads/export.xlsx", async (req, res) => {
  const rows = await fetchExportRows(req.query);

  const data = rows.map((r) => {
    const obj = {};
    for (const f of EXPORT_FIELDS) obj[f.label] = r[f.key] ?? "";
    return obj;
  });

  const sheet = XLSX.utils.json_to_sheet(data, { header: EXPORT_FIELDS.map((f) => f.label) });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Leads");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=leads_export.xlsx");
  res.send(buffer);
});

// GET /admin/leads/export-sheets-info
// There's no Google account connected to this backend, so this can't push
// directly into a Sheets doc via the Sheets API. What it CAN do: give back
// this same CSV as a stable link, which Google Sheets can pull in live via
// an IMPORTDATA formula — paste the returned formula into cell A1 of a new
// sheet and it loads (and can be manually refreshed) from this backend.
router.get("/leads/export-sheets-info", async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const csvUrl = `${req.protocol}://${req.get("host")}/admin/leads/export.csv${qs ? `?${qs}` : ""}`;
  res.json({
    csvUrl,
    importFormula: `=IMPORTDATA("${csvUrl}")`,
    instructions: "Open a new Google Sheet, paste the importFormula into cell A1, and it will pull in the current export. Re-enter the formula (or use File > Import > By URL) to refresh with newer data.",
  });
});

// -----------------------------------------------------------------------
// CRM SETTINGS — Lead Settings & Location Settings
// GET /admin/settings
router.get("/settings", async (req, res) => {
  const settings = await getCrmSettings();
  res.json({ leadSettings: settings.lead_settings, locationSettings: settings.location_settings });
});

// PATCH /admin/settings  { leadSettings?: {...}, locationSettings?: {...} }
router.patch("/settings", async (req, res) => {
  const { leadSettings, locationSettings } = req.body;
  const current = await getCrmSettings();

  const mergedLead = { ...current.lead_settings, ...(leadSettings || {}) };
  const mergedLocation = { ...current.location_settings, ...(locationSettings || {}) };

  await db.query(
    `UPDATE crm_settings SET lead_settings = $1, location_settings = $2, updated_by = $3, updated_at = now()
     WHERE id = (SELECT id FROM crm_settings ORDER BY updated_at DESC LIMIT 1)`,
    [mergedLead, mergedLocation, req.user.id]
  );
  await logActivity({ actorId: req.user.id, action: "settings.updated", entityType: "crm_settings", entityId: null, metadata: { leadSettings: mergedLead, locationSettings: mergedLocation } });

  res.json({ leadSettings: mergedLead, locationSettings: mergedLocation });
});

// GET /admin/performance — per-salesman rollup
router.get("/performance", async (req, res) => {
  const { rows } = await db.query(`
    SELECT u.id, u.full_name,
      count(l.*) AS leads_created,
      count(*) FILTER (WHERE l.verification_status = 'verified') AS verified_leads,
      count(*) FILTER (WHERE l.verification_status != 'verified') AS unverified_leads,
      count(*) FILTER (WHERE l.status = 'won') AS won,
      count(*) FILTER (WHERE l.status = 'lost') AS lost,
      count(*) FILTER (WHERE l.status = 'follow_up') AS follow_ups,
      count(*) FILTER (WHERE l.status = 'demo_scheduled') AS demos,
      round(
        (count(*) FILTER (WHERE l.status = 'won'))::numeric /
        NULLIF(count(*) FILTER (WHERE l.status IN ('won','lost')), 0) * 100, 1
      ) AS conversion_rate_pct
    FROM users u
    LEFT JOIN leads l ON l.salesman_id = u.id
    WHERE u.role = 'salesman'
    GROUP BY u.id, u.full_name
    ORDER BY u.full_name
  `);
  res.json({ performance: rows });
});

// GET /admin/notifications?unreadOnly=true
router.get("/notifications", async (req, res) => {
  const { unreadOnly } = req.query;
  const where = unreadOnly === "true" ? "WHERE is_read = false" : "";
  const { rows } = await db.query(`SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT 200`);
  res.json({ notifications: rows });
});

// -----------------------------------------------------------------------
// MESSAGES / TASKS — admin sends, salesman reads. recipientId omitted or
// null means broadcast to every salesman.
// POST /admin/messages { recipientId?: uuid, body: string }
router.post("/messages", async (req, res) => {
  const { recipientId, body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "Message body is required" });

  if (recipientId) {
    const { rows } = await db.query(
      `INSERT INTO messages (sender_id, recipient_id, body) VALUES ($1,$2,$3) RETURNING *`,
      [req.user.id, recipientId, body.trim()]
    );
    await logActivity({ actorId: req.user.id, action: "message.sent", entityType: "message", entityId: rows[0].id, metadata: { recipientId } });
    return res.status(201).json({ message: rows[0] });
  }

  // Broadcast: one row per active salesman, so each has their own read state.
  const salesmen = await db.query(`SELECT id FROM users WHERE role = 'salesman' AND is_active`);
  const inserted = [];
  for (const s of salesmen.rows) {
    const { rows } = await db.query(
      `INSERT INTO messages (sender_id, recipient_id, body) VALUES ($1,$2,$3) RETURNING *`,
      [req.user.id, s.id, body.trim()]
    );
    inserted.push(rows[0]);
  }
  await logActivity({ actorId: req.user.id, action: "message.broadcast", entityType: "message", entityId: null, metadata: { recipientCount: inserted.length } });
  res.status(201).json({ messages: inserted });
});

// GET /admin/messages?salesmanId= — sent history, optionally for one salesman
router.get("/messages", async (req, res) => {
  const { salesmanId } = req.query;
  const clauses = [];
  const params = [];
  let i = 1;
  if (salesmanId) { clauses.push(`m.recipient_id = $${i++}`); params.push(salesmanId); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const { rows } = await db.query(
    `SELECT m.*, u.full_name AS recipient_name
     FROM messages m JOIN users u ON u.id = m.recipient_id
     ${where} ORDER BY m.created_at DESC LIMIT 200`,
    params
  );
  res.json({ messages: rows });
});

module.exports = router;
