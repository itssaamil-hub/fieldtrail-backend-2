const express = require("express");
const bcrypt = require("bcryptjs");
const XLSX = require("xlsx");
const PDFDocument = require("pdfkit");
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
            sp.last_seen_at, sp.daily_target, sp.monthly_target, sp.employee_code, sp.area
     FROM users u JOIN salesman_profiles sp ON sp.user_id = u.id
     WHERE u.role = 'salesman'
     ORDER BY u.full_name`
  );
  res.json({ salesmen: rows });
});

// POST /admin/salesmen — create a new salesman
router.post("/salesmen", async (req, res) => {
  const { fullName, phone, email, password, employeeCode, dailyTarget, monthlyTarget, area } = req.body;
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
      `INSERT INTO salesman_profiles (user_id, employee_code, daily_target, monthly_target, area) VALUES ($1,$2,$3,$4,$5)`,
      [user.id, employeeCode, dailyTarget || 8, monthlyTarget || 200, area]
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
  const { isActive, dailyTarget, monthlyTarget, fullName, phone, password, area, employeeCode } = req.body;
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
    if (dailyTarget != null || monthlyTarget != null || area != null || employeeCode != null) {
      await db.query(
        `UPDATE salesman_profiles SET
           daily_target = COALESCE($2, daily_target),
           monthly_target = COALESCE($3, monthly_target),
           area = COALESCE($4, area),
           employee_code = COALESCE($5, employee_code)
         WHERE user_id = $1`,
        [id, dailyTarget, monthlyTarget, area, employeeCode]
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
  const { subLocation, posName, renewalMonth, renewalDate, contactName, phone, notes, dealValue } = req.body;

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
       notes = COALESCE($8, notes),
       deal_value = COALESCE($9, deal_value)
     WHERE id = $1 RETURNING *`,
    [id, subLocation, posName, renewalMonth, renewalDate, contactName, phone, notes, dealValue]
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

// GET /admin/leads/:id/history — status-change timeline for any lead
// (who changed it, from what, to what, when).
router.get("/leads/:id/history", async (req, res) => {
  const exists = await db.query(`SELECT id FROM leads WHERE id = $1`, [req.params.id]);
  if (!exists.rows[0]) return res.status(404).json({ error: "Lead not found" });

  const { rows } = await db.query(
    `SELECT h.id, h.old_status, h.new_status, h.changed_at, u.full_name AS changed_by_name
     FROM lead_status_history h JOIN users u ON u.id = h.changed_by
     WHERE h.lead_id = $1 ORDER BY h.changed_at ASC`,
    [req.params.id]
  );
  res.json({ history: rows });
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

// DELETE /admin/messages/:id
router.delete("/messages/:id", async (req, res) => {
  const { rowCount } = await db.query(`DELETE FROM messages WHERE id = $1`, [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: "Message not found" });
  res.json({ ok: true });
});

// -----------------------------------------------------------------------
// LEAD FIELD OPTIONS — admin-managed presets for Category / POS Name
// dropdowns in the Add Lead form.
const ALLOWED_FIELD_KEYS = ["category", "pos_name", "sub_location"];

// GET /admin/lead-options — all fields, grouped
router.get("/lead-options", async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, field_key, value FROM lead_field_options ORDER BY field_key, value`
  );
  const grouped = { category: [], pos_name: [], sub_location: [] };
  for (const r of rows) {
    if (!grouped[r.field_key]) grouped[r.field_key] = [];
    grouped[r.field_key].push({ id: r.id, value: r.value });
  }
  res.json({ options: grouped });
});

// POST /admin/lead-options { fieldKey, value }
router.post("/lead-options", async (req, res) => {
  const { fieldKey, value } = req.body;
  if (!ALLOWED_FIELD_KEYS.includes(fieldKey)) return res.status(400).json({ error: "Invalid fieldKey" });
  if (!value || !value.trim()) return res.status(400).json({ error: "Value is required" });

  try {
    const { rows } = await db.query(
      `INSERT INTO lead_field_options (field_key, value) VALUES ($1,$2) RETURNING id, field_key, value`,
      [fieldKey, value.trim()]
    );
    res.status(201).json({ option: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That option already exists" });
    throw err;
  }
});

// DELETE /admin/lead-options/:id
router.delete("/lead-options/:id", async (req, res) => {
  const { rowCount } = await db.query(`DELETE FROM lead_field_options WHERE id = $1`, [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: "Option not found" });
  res.json({ ok: true });
});

// GET /admin/reports/time-in-stage
// Average number of days a lead spends in each status before moving on,
// computed from lead_status_history: for every transition into a status,
// find the next transition for that lead and measure the gap.
router.get("/reports/time-in-stage", async (req, res) => {
  const { rows } = await db.query(`
    WITH transitions AS (
      SELECT
        lead_id,
        new_status AS status,
        changed_at,
        LEAD(changed_at) OVER (PARTITION BY lead_id ORDER BY changed_at) AS next_changed_at
      FROM lead_status_history
    )
    SELECT
      status,
      COUNT(*) FILTER (WHERE next_changed_at IS NOT NULL) AS completed_count,
      COALESCE(AVG(EXTRACT(EPOCH FROM (next_changed_at - changed_at)) / 86400.0) FILTER (WHERE next_changed_at IS NOT NULL), 0) AS avg_days
    FROM transitions
    GROUP BY status
  `);
  res.json({
    stages: rows.map((r) => ({ status: r.status, avgDays: Number(r.avg_days), completedCount: Number(r.completed_count) })),
  });
});

// GET /admin/reports/daily-activity?date=YYYY-MM-DD&salesmanId=
// Per-salesman visit count, leads created, and distance travelled for one day.
router.get("/reports/daily-activity", async (req, res) => {
  const day = req.query.date || new Date().toISOString().slice(0, 10);
  const params = [day];
  let salesmanClause = "";
  if (req.query.salesmanId) {
    params.push(req.query.salesmanId);
    salesmanClause = `AND u.id = $${params.length}`;
  }

  const { rows } = await db.query(
    `SELECT
       u.id AS salesman_id, u.full_name AS salesman_name,
       a.start_day_at, a.end_day_at, a.total_distance_m,
       COALESCE(v.visit_count, 0) AS visit_count,
       COALESCE(l.leads_count, 0) AS leads_count
     FROM users u
     LEFT JOIN attendance a ON a.salesman_id = u.id AND a.day = $1
     LEFT JOIN (
       SELECT salesman_id, COUNT(*) AS visit_count FROM visits WHERE arrived_at::date = $1 GROUP BY salesman_id
     ) v ON v.salesman_id = u.id
     LEFT JOIN (
       SELECT salesman_id, COUNT(*) AS leads_count FROM leads WHERE created_at::date = $1 GROUP BY salesman_id
     ) l ON l.salesman_id = u.id
     WHERE u.role = 'salesman' ${salesmanClause}
     ORDER BY u.full_name ASC`,
    params
  );

  res.json({
    date: day,
    salesmen: rows.map((r) => ({
      salesmanId: r.salesman_id,
      salesmanName: r.salesman_name,
      dayStarted: r.start_day_at,
      dayEnded: r.end_day_at,
      distanceKm: r.total_distance_m != null ? Number(r.total_distance_m) / 1000 : 0,
      visitCount: Number(r.visit_count),
      leadsCount: Number(r.leads_count),
    })),
  });
});

// GET /admin/payments?salesmanId=&onlyPending=true
// Every Won lead with a deal value, plus how much has been paid and how
// much is still pending, derived live from lead_payments.
async function fetchPaymentsRows({ salesmanId, onlyPending }) {
  const clauses = [`l.status = 'won'`, `l.deal_value IS NOT NULL`];
  const params = [];
  if (salesmanId) {
    params.push(salesmanId);
    clauses.push(`l.salesman_id = $${params.length}`);
  }

  const { rows } = await db.query(
    `SELECT
       l.id, l.business_name, l.contact_name, l.phone, l.deal_value,
       l.salesman_id, u.full_name AS salesman_name,
       COALESCE(p.paid_total, 0) AS paid_total,
       COALESCE(p.payment_count, 0) AS payment_count,
       p.last_paid_at
     FROM leads l
     JOIN users u ON u.id = l.salesman_id
     LEFT JOIN (
       SELECT lead_id, SUM(amount) AS paid_total, COUNT(*) AS payment_count, MAX(paid_at) AS last_paid_at
       FROM lead_payments GROUP BY lead_id
     ) p ON p.lead_id = l.id
     WHERE ${clauses.join(" AND ")}
     ORDER BY (l.deal_value - COALESCE(p.paid_total, 0)) DESC, l.business_name ASC`,
    params
  );

  let payments = rows.map((r) => ({
    leadId: r.id,
    business: r.business_name,
    contactName: r.contact_name,
    phone: r.phone,
    salesmanId: r.salesman_id,
    salesmanName: r.salesman_name,
    dealValue: Number(r.deal_value),
    paidTotal: Number(r.paid_total),
    pending: Number(r.deal_value) - Number(r.paid_total),
    paymentCount: Number(r.payment_count),
    lastPaidAt: r.last_paid_at,
  }));

  if (onlyPending === "true") {
    payments = payments.filter((p) => p.pending > 0);
  }
  return payments;
}

const PAYMENTS_EXPORT_FIELDS = [
  { key: "business", label: "Business Name" },
  { key: "salesmanName", label: "Salesman" },
  { key: "contactName", label: "Contact Name" },
  { key: "phone", label: "Phone" },
  { key: "dealValue", label: "Deal Value" },
  { key: "paidTotal", label: "Paid" },
  { key: "pending", label: "Pending" },
  { key: "paymentCount", label: "Payments Made" },
];

router.get("/payments", async (req, res) => {
  const payments = await fetchPaymentsRows(req.query);

  // Collection totals for the same salesman filter, independent of onlyPending
  // (the summary always reflects every Won deal, not just the filtered rows).
  const collectionParams = [];
  let salesmanClause = "";
  if (req.query.salesmanId) {
    collectionParams.push(req.query.salesmanId);
    salesmanClause = `AND l.salesman_id = $${collectionParams.length}`;
  }
  const { rows: collectionRows } = await db.query(
    `SELECT
       COALESCE(SUM(p.amount) FILTER (WHERE date_trunc('month', p.paid_at) = date_trunc('month', now())), 0) AS collected_this_month,
       COALESCE(SUM(p.amount), 0) AS collected_all_time
     FROM lead_payments p
     JOIN leads l ON l.id = p.lead_id
     WHERE l.status = 'won' ${salesmanClause}`,
    collectionParams
  );

  const allRows = await fetchPaymentsRows({ salesmanId: req.query.salesmanId });
  const dealValueTotal = allRows.reduce((sum, r) => sum + r.dealValue, 0);
  const paidTotalAll = allRows.reduce((sum, r) => sum + r.paidTotal, 0);

  res.json({
    payments,
    summary: {
      pendingTotal: dealValueTotal - paidTotalAll,
      dealValueTotal,
      collectedThisMonth: Number(collectionRows[0].collected_this_month),
      collectedAllTime: Number(collectionRows[0].collected_all_time),
    },
  });
});

// GET /admin/payments/export.csv?salesmanId=&onlyPending=
router.get("/payments/export.csv", async (req, res) => {
  const rows = await fetchPaymentsRows(req.query);
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = PAYMENTS_EXPORT_FIELDS.map((f) => f.label).map(escape).join(",");
  const lines = rows.map((r) => PAYMENTS_EXPORT_FIELDS.map((f) => escape(r[f.key])).join(","));
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=payment_due_export.csv");
  res.send([header, ...lines].join("\n"));
});

// GET /admin/payments/export.xlsx?salesmanId=&onlyPending=
router.get("/payments/export.xlsx", async (req, res) => {
  const rows = await fetchPaymentsRows(req.query);
  const data = rows.map((r) => {
    const obj = {};
    for (const f of PAYMENTS_EXPORT_FIELDS) obj[f.label] = r[f.key] ?? "";
    return obj;
  });
  const sheet = XLSX.utils.json_to_sheet(data, { header: PAYMENTS_EXPORT_FIELDS.map((f) => f.label) });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Payment Due");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=payment_due_export.xlsx");
  res.send(buffer);
});

// GET /admin/payments/export.pdf?salesmanId=&onlyPending=
router.get("/payments/export.pdf", async (req, res) => {
  const rows = await fetchPaymentsRows(req.query);
  const totalDeal = rows.reduce((s, r) => s + r.dealValue, 0);
  const totalPaid = rows.reduce((s, r) => s + r.paidTotal, 0);
  const totalPending = rows.reduce((s, r) => s + r.pending, 0);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=payment_due_export.pdf");

  const doc = new PDFDocument({ margin: 36, size: "A4", layout: "landscape" });
  doc.pipe(res);

  doc.fontSize(16).font("Helvetica-Bold").text("Payment Due Report", { align: "left" });
  doc.fontSize(9).font("Helvetica").fillColor("#666").text(`Generated ${new Date().toLocaleString("en-IN")}`);
  doc.moveDown(1);

  doc.fontSize(10).fillColor("#000").font("Helvetica-Bold");
  doc.text(`Total deal value: Rs ${totalDeal.toFixed(2)}   Paid: Rs ${totalPaid.toFixed(2)}   Pending: Rs ${totalPending.toFixed(2)}`);
  doc.moveDown(1);

  const colWidths = [140, 90, 90, 80, 70, 70, 70, 60];
  const headers = PAYMENTS_EXPORT_FIELDS.map((f) => f.label);
  let y = doc.y;
  const startX = doc.x;

  const drawRow = (cells, isHeader) => {
    let x = startX;
    doc.font(isHeader ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
    cells.forEach((cell, i) => {
      doc.text(String(cell ?? ""), x, y, { width: colWidths[i], ellipsis: true });
      x += colWidths[i];
    });
    y += 16;
  };

  drawRow(headers, true);
  doc.moveTo(startX, y - 3).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y - 3).strokeColor("#ccc").stroke();

  rows.forEach((r) => {
    if (y > 540) { doc.addPage(); y = doc.y; }
    drawRow(PAYMENTS_EXPORT_FIELDS.map((f) => (typeof r[f.key] === "number" ? r[f.key].toFixed(2) : r[f.key])), false);
  });

  doc.end();
});

// GET /admin/payments/export-sheets-info
router.get("/payments/export-sheets-info", async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const csvUrl = `${req.protocol}://${req.get("host")}/admin/payments/export.csv${qs ? `?${qs}` : ""}`;
  res.json({
    csvUrl,
    importFormula: `=IMPORTDATA("${csvUrl}")`,
    instructions: "Open a new Google Sheet, paste the importFormula into cell A1, and it will pull in the current export. Re-enter the formula (or use File > Import > By URL) to refresh with newer data.",
  });
});

// GET /admin/leads/:id/payments — payment history for one lead
router.get("/leads/:id/payments", async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id, p.amount, p.note, p.paid_at, u.full_name AS recorded_by_name
     FROM lead_payments p JOIN users u ON u.id = p.recorded_by
     WHERE p.lead_id = $1 ORDER BY p.paid_at DESC`,
    [req.params.id]
  );
  res.json({
    payments: rows.map((r) => ({ id: r.id, amount: Number(r.amount), note: r.note, paidAt: r.paid_at, recordedByName: r.recorded_by_name })),
  });
});

// POST /admin/leads/:id/payments — record a payment against a Won lead
router.post("/leads/:id/payments", async (req, res) => {
  const { amount, note } = req.body;
  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) return res.status(400).json({ error: "Enter a valid payment amount." });

  const lead = await db.query(`SELECT id, status, deal_value FROM leads WHERE id = $1`, [req.params.id]);
  if (!lead.rows[0]) return res.status(404).json({ error: "Lead not found" });
  if (lead.rows[0].status !== "won") return res.status(400).json({ error: "Payments can only be recorded against Won leads." });
  if (lead.rows[0].deal_value == null) return res.status(400).json({ error: "This lead has no deal value set yet." });

  const paidSoFar = await db.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM lead_payments WHERE lead_id = $1`, [req.params.id]);
  const remaining = Number(lead.rows[0].deal_value) - Number(paidSoFar.rows[0].total);
  if (numAmount > remaining + 0.01) {
    return res.status(400).json({ error: `That's more than the ₹${remaining.toFixed(2)} still pending.` });
  }

  const { rows } = await db.query(
    `INSERT INTO lead_payments (lead_id, amount, note, recorded_by) VALUES ($1,$2,$3,$4)
     RETURNING id, amount, note, paid_at`,
    [req.params.id, numAmount, note || null, req.user.id]
  );
  res.status(201).json({ payment: rows[0] });
});

// PATCH /admin/leads/:id/payments/:paymentId — correct a payment amount/note
// (e.g. wrong amount entered by mistake). Validates the new amount still
// fits within the deal value once the *other* payments are accounted for.
router.patch("/leads/:id/payments/:paymentId", async (req, res) => {
  const { amount, note } = req.body;
  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) return res.status(400).json({ error: "Enter a valid payment amount." });

  const lead = await db.query(`SELECT id, deal_value FROM leads WHERE id = $1`, [req.params.id]);
  if (!lead.rows[0]) return res.status(404).json({ error: "Lead not found" });
  if (lead.rows[0].deal_value == null) return res.status(400).json({ error: "This lead has no deal value set." });

  const existing = await db.query(`SELECT id FROM lead_payments WHERE id = $1 AND lead_id = $2`, [req.params.paymentId, req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: "Payment not found" });

  const otherPaid = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM lead_payments WHERE lead_id = $1 AND id != $2`,
    [req.params.id, req.params.paymentId]
  );
  const remaining = Number(lead.rows[0].deal_value) - Number(otherPaid.rows[0].total);
  if (numAmount > remaining + 0.01) {
    return res.status(400).json({ error: `That's more than the ₹${remaining.toFixed(2)} available (deal value minus your other payments).` });
  }

  const { rows } = await db.query(
    `UPDATE lead_payments SET amount = $1, note = $2 WHERE id = $3 RETURNING id, amount, note, paid_at`,
    [numAmount, note || null, req.params.paymentId]
  );
  res.json({ payment: rows[0] });
});

// DELETE /admin/leads/:id/payments/:paymentId — remove a payment entered by mistake
router.delete("/leads/:id/payments/:paymentId", async (req, res) => {
  const { rowCount } = await db.query(`DELETE FROM lead_payments WHERE id = $1 AND lead_id = $2`, [req.params.paymentId, req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: "Payment not found" });
  res.json({ ok: true });
});
router.get("/expenses", async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.category) {
    params.push(req.query.category);
    clauses.push(`e.category = $${params.length}`);
  }
  if (req.query.salesmanId) {
    params.push(req.query.salesmanId);
    clauses.push(`e.salesman_id = $${params.length}`);
  }
  if (req.query.from) {
    params.push(req.query.from);
    clauses.push(`e.spent_on >= $${params.length}`);
  }
  if (req.query.to) {
    params.push(req.query.to);
    clauses.push(`e.spent_on <= $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const { rows } = await db.query(
    `SELECT e.id, e.category, e.amount, e.note, e.spent_on, e.salesman_id, u.full_name AS salesman_name
     FROM expenses e LEFT JOIN users u ON u.id = e.salesman_id
     ${where}
     ORDER BY e.spent_on DESC, e.created_at DESC`,
    params
  );

  res.json({
    expenses: rows.map((r) => ({
      id: r.id, category: r.category, amount: Number(r.amount), note: r.note,
      spentOn: r.spent_on, salesmanId: r.salesman_id, salesmanName: r.salesman_name,
    })),
  });
});

// POST /admin/expenses
router.post("/expenses", async (req, res) => {
  const { category, amount, salesmanId, note, spentOn } = req.body;
  const numAmount = Number(amount);
  if (!category || !category.trim()) return res.status(400).json({ error: "Pick a category." });
  if (!numAmount || numAmount <= 0) return res.status(400).json({ error: "Enter a valid amount." });

  const { rows } = await db.query(
    `INSERT INTO expenses (category, amount, salesman_id, note, spent_on, recorded_by)
     VALUES ($1,$2,$3,$4,COALESCE($5, CURRENT_DATE),$6)
     RETURNING id, category, amount, note, spent_on, salesman_id`,
    [category.trim(), numAmount, salesmanId || null, note || null, spentOn || null, req.user.id]
  );
  res.status(201).json({ expense: rows[0] });
});

// DELETE /admin/expenses/:id
router.delete("/expenses/:id", async (req, res) => {
  const { rowCount } = await db.query(`DELETE FROM expenses WHERE id = $1`, [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: "Expense not found" });
  res.json({ ok: true });
});

module.exports = router;
