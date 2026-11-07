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

module.exports = router;
module.exports._test = { currentIndiaMonth };
