const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("salesman"));

const MONTH = /^20\\d{2}-(?:0[1-9]|1[0-2])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function istCurrentMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year").value;
  const month = parts.find((part) => part.type === "month").value;
  return `${year}-${month}`;
}

function checkedMonth(value, now = new Date()) {
  const month = value == null || value === "" ? istCurrentMonth(now) : value;
  if (typeof month !== "string" || !MONTH.test(month)) {
    const error = new Error("Select a valid month (YYYY-MM).");
    error.status = 400;
    throw error;
  }
  return month;
}

function requireCurrentMonth(value) {
  const month = checkedMonth(value);
  if (month !== istCurrentMonth()) {
    const error = new Error("Past months are read-only. Choose the current month to update your focus list.");
    error.status = 409;
    throw error;
  }
  return `${month}-01`;
}

function checkedLeadId(value) {
  if (typeof value !== "string" || !UUID.test(value)) {
    const error = new Error("Invalid deal ID.");
    error.status = 400;
    throw error;
  }
  return value;
}

// Private month-wise list, joined to CURRENT employee ownership to avoid exposing reassigned deals.
router.get("/", async (req, res) => {
  const month = checkedMonth(req.query.month);
  const { rows } = await db.query([
    "SELECT l.id, l.business_name, l.status, l.deal_value, l.created_at,",
    "l.updated_at, l.next_follow_up_date, f.added_at, f.completed_at",
    "FROM salesman_monthly_focus f",
    "JOIN leads l ON l.id = f.lead_id AND l.salesman_id = $1",
    "WHERE f.salesman_id = $1 AND f.month_start = $2::date",
    "ORDER BY (f.completed_at IS NULL) DESC, f.added_at DESC, l.id DESC",
  ].join(" "), [req.user.id, `${month}-01`]);
  res.json({ month, items: rows });
});

// Search the employee's own existing deals. Never expose the team's other leads.
router.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 100);
  const { rows } = await db.query([
    "SELECT id, business_name, status, deal_value, next_follow_up_date, created_at",
    "FROM leads WHERE salesman_id = $1",
    "AND ($2::text = '' OR business_name ILIKE '%' || $2 || '%' OR contact_name ILIKE '%' || $2 || '%')",
    "ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT 25",
  ].join(" "), [req.user.id, query]);
  res.json({ leads: rows });
});

// An idempotent addition; does not alter the CRM lead, its stage, or activity log.
router.post("/", async (req, res) => {
  const monthStart = requireCurrentMonth(req.body?.month);
  const leadId = checkedLeadId(req.body?.leadId);
  const { rows } = await db.query([
    "INSERT INTO salesman_monthly_focus (salesman_id, month_start, lead_id)",
    "SELECT $1, $2::date, l.id FROM leads l",
    "WHERE l.id = $3 AND l.salesman_id = $1",
    "ON CONFLICT (salesman_id, month_start, lead_id) DO NOTHING",
    "RETURNING lead_id",
  ].join(" "), [req.user.id, monthStart, leadId]);
  if (!rows.length) {
    // Duplicate inserts are fine; distinguish them from an unowned/missing deal.
    const check = await db.query([
      "SELECT 1 FROM salesman_monthly_focus f",
      "JOIN leads l ON l.id = f.lead_id AND l.salesman_id = $1",
      "WHERE f.salesman_id = $1 AND f.month_start = $2::date AND f.lead_id = $3",
    ].join(" "), [req.user.id, monthStart, leadId]);
    if (!check.rows.length) return res.status(404).json({ error: "Deal not found or not assigned to you." });
  }
  res.json({ ok: true });
});

// "Done" means monthly focus work completed; it NEVER moves the CRM deal to Won.
router.patch("/:leadId", async (req, res) => {
  const monthStart = requireCurrentMonth(req.body?.month);
  const leadId = checkedLeadId(req.params.leadId);
  if (typeof req.body?.completed !== "boolean") return res.status(400).json({ error: "completed must be true or false." });
  const { rows } = await db.query([
    "UPDATE salesman_monthly_focus f",
    "SET completed_at = CASE WHEN $4::boolean THEN COALESCE(f.completed_at, NOW()) ELSE NULL END",
    "FROM leads l WHERE l.id = f.lead_id AND l.salesman_id = $1",
    "AND f.salesman_id = $1 AND f.month_start = $2::date AND f.lead_id = $3",
    "RETURNING f.lead_id, f.completed_at",
  ].join(" "), [req.user.id, monthStart, leadId, req.body.completed]);
  if (!rows.length) return res.status(404).json({ error: "Monthly deal not found." });
  res.json({ ok: true, completedAt: rows[0].completed_at });
});

router.delete("/:leadId", async (req, res) => {
  const monthStart = requireCurrentMonth(req.query.month);
  const leadId = checkedLeadId(req.params.leadId);
  const { rowCount } = await db.query([
    "DELETE FROM salesman_monthly_focus f USING leads l",
    "WHERE l.id = f.lead_id AND l.salesman_id = $1",
    "AND f.salesman_id = $1 AND f.month_start = $2::date AND f.lead_id = $3",
  ].join(" "), [req.user.id, monthStart, leadId]);
  if (!rowCount) return res.status(404).json({ error: "Monthly deal not found." });
  res.json({ ok: true });
});

module.exports = router;
module.exports._test = { istCurrentMonth, checkedMonth, requireCurrentMonth, checkedLeadId };
