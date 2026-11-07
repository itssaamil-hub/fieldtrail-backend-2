const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

const MONTH = /^20[0-9]{2}-(?:0[1-9]|1[0-2])$/;
function currentIndiaMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit",
  }).formatToParts(now);
  return parts.find(part => part.type === "year").value + "-" +
    parts.find(part => part.type === "month").value;
}

// Only admins can read team tracking. A deal must still belong to the same
// employee who selected it; stale assignments must never appear as current.
// Do not use the normal admin leads latest-500 limit here: older deals can be
// selected for the current month.
router.get("/", async (req, res) => {
  const month = req.query.month == null || req.query.month === ""
    ? currentIndiaMonth() : req.query.month;
  if (typeof month !== "string" || !MONTH.test(month)) {
    return res.status(400).json({ error: "Select a valid tracking month (YYYY-MM)." });
  }
  const { rows } = await db.query([
    "SELECT l.*, u.full_name AS salesman_name, f.added_at AS tracked_at",
    "FROM salesman_monthly_focus f",
    "JOIN leads l ON l.id = f.lead_id AND l.salesman_id = f.salesman_id",
    "JOIN users u ON u.id = f.salesman_id AND u.role = 'salesman'",
    "WHERE f.month_start = $1::date",
    "ORDER BY f.added_at DESC, l.id DESC",
  ].join(" "), [month + "-01"]);
  res.json({ month, deals: rows });
});


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validDealId(value, res) {
  if (typeof value !== "string" || !UUID.test(value)) {
    res.status(400).json({ error: "Invalid deal ID." });
    return false;
  }
  return true;
}
function validCurrentMonth(value, res) {
  const month = value == null || value === "" ? currentIndiaMonth() : value;
  if (typeof month !== "string" || !MONTH.test(month)) {
    res.status(400).json({ error: "Select a valid tracking month (YYYY-MM)." });
    return null;
  }
  if (month !== currentIndiaMonth()) {
    res.status(409).json({ error: "Past tracking months are read-only." });
    return null;
  }
  return month + "-01";
}

// Admin can track a deal on behalf of its CURRENT assigned employee only.
// Resolve assignment server-side; never accept an employee ID from the client.
router.get("/:leadId", async (req, res) => {
  if (!validDealId(req.params.leadId, res)) return;
  const month = req.query.month == null || req.query.month === "" ? currentIndiaMonth() : req.query.month;
  if (typeof month !== "string" || !MONTH.test(month)) {
    return res.status(400).json({ error: "Select a valid tracking month (YYYY-MM)." });
  }
  const { rows } = await db.query([
    "SELECT l.salesman_id, EXISTS (SELECT 1 FROM salesman_monthly_focus f",
    "WHERE f.lead_id = l.id AND f.salesman_id = l.salesman_id",
    "AND f.month_start = $2::date) AS tracked",
    "FROM leads l WHERE l.id = $1",
  ].join(" "), [req.params.leadId, month + "-01"]);
  if (!rows.length) return res.status(404).json({ error: "Deal not found." });
  res.json({ month, tracked: rows[0].tracked === true });
});

router.post("/:leadId", async (req, res) => {
  if (!validDealId(req.params.leadId, res)) return;
  const start = validCurrentMonth(req.body?.month, res);
  if (!start) return;
  const { rows } = await db.query([
    "INSERT INTO salesman_monthly_focus (salesman_id, month_start, lead_id)",
    "SELECT l.salesman_id, $2::date, l.id FROM leads l",
    "JOIN users u ON u.id = l.salesman_id AND u.role = 'salesman'",
    "WHERE l.id = $1",
    "ON CONFLICT (salesman_id, month_start, lead_id) DO NOTHING",
    "RETURNING lead_id",
  ].join(" "), [req.params.leadId, start]);
  if (!rows.length) {
    const existing = await db.query([
      "SELECT 1 FROM salesman_monthly_focus f",
      "JOIN leads l ON l.id = f.lead_id AND l.salesman_id = f.salesman_id",
      "WHERE l.id = $1 AND f.month_start = $2::date",
    ].join(" "), [req.params.leadId, start]);
    if (!existing.rows.length) return res.status(404).json({ error: "Deal not found or unassigned." });
  }
  res.json({ ok: true, tracked: true });
});

router.delete("/:leadId", async (req, res) => {
  if (!validDealId(req.params.leadId, res)) return;
  const start = validCurrentMonth(req.query.month, res);
  if (!start) return;
  const result = await db.query([
    "DELETE FROM salesman_monthly_focus f USING leads l",
    "WHERE l.id = f.lead_id AND l.salesman_id = f.salesman_id",
    "AND l.id = $1 AND f.month_start = $2::date",
  ].join(" "), [req.params.leadId, start]);
  if (!result.rowCount) return res.status(404).json({ error: "Monthly tracking not found." });
  res.json({ ok: true, tracked: false });
});

module.exports = router;
module.exports._test = { currentIndiaMonth };
