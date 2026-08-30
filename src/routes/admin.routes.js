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

async function fetchExportRows({ salesmanId, status }) {
  const clauses = [];
  const params = [];
  let i = 1;
  if (salesmanId) { clauses.push(`l.salesman_id = $${i++}`); params.push(salesmanId); }
  if (status) { clauses.push(`l.status = $${i++}`); params.push(status); }
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
            sp.last_seen_at, sp.daily_target, sp.employee_code
     FROM users u JOIN salesman_profiles sp ON sp.user_id = u.id
     WHERE u.role = 'salesman'
     ORDER BY u.full_name`
  );
  res.json({ salesmen: rows });
});

// POST /admin/salesmen — create a new salesman
router.post("/salesmen", async (req, res) => {
  const { fullName, phone, email, password, employeeCode, dailyTarget } = req.body;
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
      `INSERT INTO salesman_profiles (user_id, employee_code, daily_target) VALUES ($1,$2,$3)`,
      [user.id, employeeCode, dailyTarget || 8]
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

// PATCH /admin/salesmen/:id — activate/deactivate, reassign target etc.
router.patch("/salesmen/:id", async (req, res) => {
  const { isActive, dailyTarget } = req.body;
  await db.query(`UPDATE users SET is_active = COALESCE($2, is_active) WHERE id = $1`, [req.params.id, isActive]);
  if (dailyTarget != null) {
    await db.query(`UPDATE salesman_profiles SET daily_target = $2 WHERE user_id = $1`, [req.params.id, dailyTarget]);
  }
  await logActivity({ actorId: req.user.id, action: "salesman.updated", entityType: "user", entityId: req.params.id, metadata: req.body });
  res.json({ ok: true });
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
  res.json({ route: rows, leads: leads.rows });
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

module.exports = router;
