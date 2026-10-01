const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

router.get("/", async (req, res) => {
  const month = String(req.query.month || "").trim();
  if (month !== "all" && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return res.status(400).json({ error: "Invalid month" });
  }

  const { rows } = await db.query(
    `WITH params AS (
       SELECT CASE WHEN $1 = 'all' THEN NULL::date ELSE ($1 || '-01')::date END AS month_start
     ), lead_stats AS (
       SELECT l.salesman_id,
         COUNT(*) FILTER (
           WHERE p.month_start IS NULL OR (
             (l.created_at AT TIME ZONE 'Asia/Kolkata')::date >= p.month_start
             AND (l.created_at AT TIME ZONE 'Asia/Kolkata')::date < (p.month_start + INTERVAL '1 month')::date
           )
         )::int AS leads_created
       FROM leads l CROSS JOIN params p
       GROUP BY l.salesman_id
     ), won_stats AS (
       SELECT m.salesman_id,
         COUNT(*)::int AS won,
         COALESCE(SUM(COALESCE(l.deal_value, 0)), 0)::numeric AS revenue
       FROM lead_stage_milestones m
       JOIN leads l ON l.id=m.lead_id
       CROSS JOIN params p
       WHERE m.stage='won'
         AND (
           p.month_start IS NULL OR (
             (m.occurred_at AT TIME ZONE 'Asia/Kolkata')::date >= p.month_start
             AND (m.occurred_at AT TIME ZONE 'Asia/Kolkata')::date < (p.month_start + INTERVAL '1 month')::date
           )
         )
       GROUP BY m.salesman_id
     )
     SELECT
       u.id AS salesman_id,
       u.full_name,
       COALESCE(ls.leads_created, 0)::int AS leads_created,
       COALESCE(ws.won, 0)::int AS won,
       COALESCE(ws.revenue, 0)::numeric AS revenue
     FROM users u
     LEFT JOIN lead_stats ls ON ls.salesman_id = u.id
     LEFT JOIN won_stats ws ON ws.salesman_id = u.id
     WHERE u.role = 'salesman'
     ORDER BY u.full_name`,
    [month]
  );

  res.json({
    month,
    rows: rows.map((row) => ({
      ...row,
      revenue: Number(row.revenue || 0),
    })),
  });
});

module.exports = router;
