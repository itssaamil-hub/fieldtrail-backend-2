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
    weekday: shifted.getUTCDay(),
  };
}

function istToUtc(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  return new Date(Date.UTC(year, month, day, hour, minute, second, ms) - IST_OFFSET_MS);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function periodBounds(period, now = new Date()) {
  const p = istParts(now);

  if (period === "monthly") {
    const currentStart = istToUtc(p.year, p.month, 1);
    const previousMonthDate = new Date(Date.UTC(p.year, p.month - 1, 1));
    const previousYear = previousMonthDate.getUTCFullYear();
    const previousMonth = previousMonthDate.getUTCMonth();
    const previousDay = Math.min(p.day, daysInMonth(previousYear, previousMonth));
    const previousStart = istToUtc(previousYear, previousMonth, 1);
    const previousEnd = istToUtc(previousYear, previousMonth, previousDay, p.hour, p.minute, p.second, p.ms);
    return { currentStart, currentEnd: now, previousStart, previousEnd };
  }

  // Monday 00:00 IST through now, compared with the same elapsed portion
  // of the previous Monday-Sunday week.
  const daysSinceMonday = (p.weekday + 6) % 7;
  const currentStart = istToUtc(p.year, p.month, p.day - daysSinceMonday);
  const previousStart = new Date(currentStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const previousEnd = new Date(previousStart.getTime() + (now.getTime() - currentStart.getTime()));
  return { currentStart, currentEnd: now, previousStart, previousEnd };
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

router.get("/", async (req, res) => {
  const period = req.query.period === "monthly" ? "monthly" : "weekly";
  const salesmanId = req.query.salesmanId && req.query.salesmanId !== "all" ? req.query.salesmanId : null;

  if (salesmanId && !/^[0-9a-f-]{36}$/i.test(salesmanId)) {
    return res.status(400).json({ error: "Invalid employee" });
  }

  const { currentStart, currentEnd, previousStart, previousEnd } = periodBounds(period);
  const params = [currentStart, currentEnd, previousStart, previousEnd, salesmanId];
  const salesmanClause = "($5::uuid IS NULL OR salesman_id = $5::uuid)";

  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= $1 AND created_at <= $2 AND ${salesmanClause}) AS current_total,
       COUNT(*) FILTER (WHERE created_at >= $3 AND created_at <= $4 AND ${salesmanClause}) AS previous_total,
       COUNT(*) FILTER (WHERE created_at >= $1 AND created_at <= $2 AND status = 'conversation' AND ${salesmanClause}) AS current_conversation,
       COUNT(*) FILTER (WHERE created_at >= $3 AND created_at <= $4 AND status = 'conversation' AND ${salesmanClause}) AS previous_conversation,
       COUNT(*) FILTER (WHERE created_at >= $1 AND created_at <= $2 AND status = 'negotiation' AND ${salesmanClause}) AS current_negotiation,
       COUNT(*) FILTER (WHERE created_at >= $3 AND created_at <= $4 AND status = 'negotiation' AND ${salesmanClause}) AS previous_negotiation,
       COUNT(*) FILTER (WHERE created_at >= $1 AND created_at <= $2 AND status = 'won' AND ${salesmanClause}) AS current_won,
       COUNT(*) FILTER (WHERE created_at >= $3 AND created_at <= $4 AND status = 'won' AND ${salesmanClause}) AS previous_won
     FROM leads`,
    params
  );

  const row = rows[0] || {};
  res.json({
    period,
    comparisons: {
      conversation: comparison(row.current_conversation, row.previous_conversation),
      negotiation: comparison(row.current_negotiation, row.previous_negotiation),
      total: comparison(row.current_total, row.previous_total),
      won: comparison(row.current_won, row.previous_won),
    },
  });
});

module.exports = router;
