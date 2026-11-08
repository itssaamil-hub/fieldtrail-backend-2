// Employee-owned Won deals, scoped to the canonical saved Won Date.
// Separate read-only route: never expose Admin Won Date access to salespeople.
const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("salesman"));
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const wonFrom = [
  "FROM leads l",
  "LEFT JOIN lead_stage_milestones m ON m.lead_id = l.id AND m.stage = 'won'",
  "WHERE l.salesman_id = $1::uuid AND l.status = 'won'",
  "AND ($2::text = 'all' OR (",
  " m.occurred_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')",
  " AND m.occurred_at < ((date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 month') AT TIME ZONE 'Asia/Kolkata')",
  "))",
].join("\n");

function parseWonListParams(input = {}) {
  const period = input.period == null ? "month" : input.period;
  if (period !== "all" && period !== "month") {
    const err = new Error("Invalid Won period");
    err.status = 400;
    throw err;
  }
  const pageString = input.page == null ? "1" : String(input.page);
  const limitString = input.limit == null ? "50" : String(input.limit);
  if (!/^[1-9]\d{0,4}$/.test(pageString) || !/^[1-9]\d{0,2}$/.test(limitString)) {
    const err = new Error("Invalid Won pagination");
    err.status = 400;
    throw err;
  }
  const page = Number(pageString), limit = Number(limitString);
  if (page > 10000 || limit > 100) {
    const err = new Error("Won pagination out of range");
    err.status = 400;
    throw err;
  }
  return { period, page, limit, offset: (page - 1) * limit };
}

async function getEmployeeWonDeals({ employeeId, period, page, limit, offset }, query = db.query) {
  // Summary spans the full filtered result, not just the loaded page.
  const [summary, records] = await Promise.all([
    query("SELECT COUNT(*)::int AS total, COALESCE(SUM(COALESCE(l.deal_value,0)),0)::numeric AS won_value\n" + wonFrom,
      [employeeId, period]),
    query(
      "SELECT l.*, to_char(m.occurred_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS won_date\n" +
      wonFrom + "\nORDER BY m.occurred_at DESC NULLS LAST, l.created_at DESC, l.id DESC\n" +
      "LIMIT $3::int OFFSET $4::int",
      [employeeId, period, limit, offset]
    ),
  ]);
  const total = Number(summary.rows[0]?.total || 0);
  return {
    period, page, limit, total,
    wonValue: Number(summary.rows[0]?.won_value || 0),
    hasNext: offset + records.rows.length < total,
    leads: records.rows,
  };
}

router.get("/", async (req, res) => {
  const selection = parseWonListParams(req.query);
  return res.json(await getEmployeeWonDeals({ ...selection, employeeId: req.user.id }));
});

router.use((err, _req, res, next) => {
  if (err.status === 400) return res.status(400).json({ error: err.message });
  next(err);
});

module.exports = router;
module.exports.parseWonListParams = parseWonListParams;
module.exports.getEmployeeWonDeals = getEmployeeWonDeals;
