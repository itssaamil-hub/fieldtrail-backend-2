const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istParts(date) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    ms: shifted.getUTCMilliseconds(),
  };
}

function istToUtc(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  return new Date(Date.UTC(year, month, day, hour, minute, second, ms) - IST_OFFSET_MS);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function comparison(current, previous) {
  const c = Number(current || 0);
  const p = Number(previous || 0);
  return {
    current: c,
    previous: p,
    pct: p === 0 ? (c === 0 ? 0 : null) : Math.round(((c - p) / p) * 100),
  };
}

function previousSnapshot(period, now = new Date()) {
  if (period === "monthly") {
    const p = istParts(now);
    const previousMonthDate = new Date(Date.UTC(p.year, p.month - 1, 1));
    const y = previousMonthDate.getUTCFullYear();
    const m = previousMonthDate.getUTCMonth();
    const d = Math.min(p.day, daysInMonth(y, m));
    return istToUtc(y, m, d, p.hour, p.minute, p.second, p.ms);
  }
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

router.get("/", async (req, res) => {
  const period = req.query.period === "monthly" ? "monthly" : "weekly";
  const salesmanId = req.query.salesmanId && req.query.salesmanId !== "all" ? req.query.salesmanId : null;

  if (salesmanId && !/^[0-9a-f-]{36}$/i.test(salesmanId)) {
    return res.status(400).json({ error: "Invalid employee" });
  }

  const now = new Date();
  const snapshotAt = previousSnapshot(period, now);
  const p = istParts(now);
  const todayStart = istToUtc(p.year, p.month, p.day);

  // Keep parameter numbering contiguous. PostgreSQL cannot infer a parameter
  // type when a prepared statement skips an index (for example $1, $3, $4).
  const currentParams = [salesmanId, todayStart, now];
  const snapshotParams = [salesmanId, snapshotAt];
  const salesmanClause = "($1::uuid IS NULL OR l.salesman_id = $1::uuid)";

  // Use the same population as /admin/leads: only leads attached to a valid
  // user row. This keeps dashboard totals identical to the CRM lead list.
  const current = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE l.status = 'conversation')::int AS conversation,
       COUNT(*) FILTER (WHERE l.status = 'negotiation')::int AS negotiation,
       COUNT(*) FILTER (WHERE l.status = 'won')::int AS won,
       COUNT(*) FILTER (WHERE l.status = 'cold')::int AS cold,
       COUNT(*) FILTER (WHERE l.created_at >= $2::timestamptz AND l.created_at <= $3::timestamptz)::int AS leads_today,
       COUNT(*) FILTER (WHERE l.created_at >= $2::timestamptz AND l.created_at <= $3::timestamptz AND l.status = 'hot')::int AS hot_today,
       COALESCE(SUM(l.deal_value) FILTER (WHERE l.status = 'won'), 0)::numeric AS won_value
     FROM leads l
     JOIN users u ON u.id = l.salesman_id
     WHERE ${salesmanClause}`,
    currentParams
  );

  // Reconstruct each lead's status at the historical snapshot using the same
  // lead population as the CRM list, so comparison percentages stay aligned.
  const previous = await db.query(
    `WITH snapshot AS (
       SELECT
         l.id,
         COALESCE(next_change.old_status, l.status) AS status_at_snapshot
       FROM leads l
       JOIN users u ON u.id = l.salesman_id
       LEFT JOIN LATERAL (
         SELECT h.old_status
         FROM lead_status_history h
         WHERE h.lead_id = l.id AND h.changed_at > $2::timestamptz
         ORDER BY h.changed_at ASC
         LIMIT 1
       ) next_change ON TRUE
       WHERE ${salesmanClause}
         AND l.created_at <= $2::timestamptz
     )
     SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status_at_snapshot = 'conversation')::int AS conversation,
       COUNT(*) FILTER (WHERE status_at_snapshot = 'negotiation')::int AS negotiation,
       COUNT(*) FILTER (WHERE status_at_snapshot = 'won')::int AS won
     FROM snapshot`,
    snapshotParams
  );

  const c = current.rows[0] || {};
  const prev = previous.rows[0] || {};

  res.json({
    period,
    salesmanId: salesmanId || "all",
    snapshotAt,
    metrics: {
      total: Number(c.total || 0),
      conversation: Number(c.conversation || 0),
      negotiation: Number(c.negotiation || 0),
      won: Number(c.won || 0),
      cold: Number(c.cold || 0),
      leadsToday: Number(c.leads_today || 0),
      hotToday: Number(c.hot_today || 0),
      wonValue: Number(c.won_value || 0),
    },
    comparisons: {
      conversation: comparison(c.conversation, prev.conversation),
      negotiation: comparison(c.negotiation, prev.negotiation),
      total: comparison(c.total, prev.total),
      won: comparison(c.won, prev.won),
    },
  });
});

module.exports = router;
