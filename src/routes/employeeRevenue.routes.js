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
     ), latest_won_events AS (
       SELECT entity_id, MAX(created_at) AS won_at
       FROM activity_logs
       WHERE action = 'lead.status_changed' AND metadata->>'to' = 'won'
       GROUP BY entity_id
     ), stats AS (
       SELECT
         l.salesman_id,
         COUNT(*) FILTER (
           WHERE p.month_start IS NULL OR (
             (l.created_at AT TIME ZONE 'Asia/Kolkata')::date >= p.month_start
             AND (l.created_at AT TIME ZONE 'Asia/Kolkata')::date < (p.month_start + INTERVAL '1 month')::date
           )
         )::int AS leads_created,
         COUNT(*) FILTER (
           WHERE l.status = 'won'
             AND we.won_at IS NOT NULL
             AND (
               p.month_start IS NULL OR (
                 (we.won_at AT TIME ZONE 'Asia/Kolkata')::date >= p.month_start
                 AND (we.won_at AT TIME ZONE 'Asia/Kolkata')::date < (p.month_start + INTERVAL '1 month')::date
               )
             )
         )::int AS won,
         COALESCE(SUM(
           CASE WHEN l.status = 'won'
             AND we.won_at IS NOT NULL
             AND (
               p.month_start IS NULL OR (
                 (we.won_at AT TIME ZONE 'Asia/Kolkata')::date >= p.month_start
                 AND (we.won_at AT TIME ZONE 'Asia/Kolkata')::date < (p.month_start + INTERVAL '1 month')::date
               )
             )
           THEN COALESCE(l.deal_value, 0) ELSE 0 END
         ), 0)::numeric AS revenue
       FROM leads l
       CROSS JOIN params p
       LEFT JOIN latest_won_events we ON we.entity_id = l.id
       GROUP BY l.salesman_id
     )
     SELECT
       u.id AS salesman_id,
       u.full_name,
       COALESCE(s.leads_created, 0)::int AS leads_created,
       COALESCE(s.won, 0)::int AS won,
       COALESCE(s.revenue, 0)::numeric AS revenue
     FROM users u
     LEFT JOIN stats s ON s.salesman_id = u.id
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
