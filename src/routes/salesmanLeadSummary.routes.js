const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("salesman"));

// Accurate salesman dashboard KPIs. Won + won value are based on the date the
// lead actually moved to Won in IST, not the lead's original creation date.
router.get("/leads-summary", async (req, res) => {
  const { rows } = await db.query(`
    WITH bounds AS (
      SELECT
        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date AS today,
        date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date AS month_start,
        (date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') + interval '1 month')::date AS next_month_start
    ), won_month AS (
      SELECT DISTINCT al.entity_id AS lead_id
      FROM activity_logs al
      JOIN leads wl ON wl.id = al.entity_id AND wl.salesman_id = $1
      CROSS JOIN bounds b
      WHERE al.actor_id = $1
        AND al.action = 'lead.status_changed'
        AND al.metadata->>'to' = 'won'
        AND (al.created_at AT TIME ZONE 'Asia/Kolkata')::date >= b.month_start
        AND (al.created_at AT TIME ZONE 'Asia/Kolkata')::date < b.next_month_start
    ), lead_stats AS (
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE (l.created_at AT TIME ZONE 'Asia/Kolkata')::date = b.today)::int AS today,
        COUNT(*) FILTER (WHERE (l.created_at AT TIME ZONE 'Asia/Kolkata')::date >= b.month_start AND (l.created_at AT TIME ZONE 'Asia/Kolkata')::date < b.next_month_start)::int AS month,
        COUNT(*) FILTER (WHERE l.status = 'hot')::int AS hot,
        COUNT(*) FILTER (WHERE l.status = 'conversation')::int AS conversation,
        COUNT(*) FILTER (WHERE l.status = 'negotiation')::int AS negotiation,
        COUNT(*) FILTER (WHERE l.status NOT IN ('won','lost'))::int AS pending,
        COUNT(*) FILTER (WHERE
          (l.renewal_date IS NOT NULL AND l.renewal_date BETWEEN b.today AND b.today + 30)
          OR (l.renewal_date IS NULL AND lower(l.renewal_month) IN (
            lower(to_char(b.today, 'FMMonth')),
            lower(to_char(b.today + interval '1 month', 'FMMonth'))
          ))
        )::int AS renewals_due
      FROM leads l CROSS JOIN bounds b
      WHERE l.salesman_id = $1
      GROUP BY b.today, b.month_start, b.next_month_start
    ), won_stats AS (
      SELECT COUNT(*)::int AS won,
             COALESCE(SUM(l.deal_value), 0)::numeric AS won_value
      FROM won_month wm
      JOIN leads l ON l.id = wm.lead_id
    )
    SELECT ls.*, ws.won, ws.won_value
    FROM lead_stats ls CROSS JOIN won_stats ws
  `, [req.user.id]);

  const r = rows[0] || {};
  res.json({
    total: Number(r.total || 0),
    today: Number(r.today || 0),
    month: Number(r.month || 0),
    hot: Number(r.hot || 0),
    conversation: Number(r.conversation || 0),
    negotiation: Number(r.negotiation || 0),
    won: Number(r.won || 0),
    pending: Number(r.pending || 0),
    wonValue: Number(r.won_value || 0),
    renewalsDue: Number(r.renewals_due || 0),
  });
});

module.exports = router;
