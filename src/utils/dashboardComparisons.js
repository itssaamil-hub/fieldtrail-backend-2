const db = require("../db");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DEFAULT_DISPLAY_SETTINGS = Object.freeze({
  showAdminComparisons: true,
  showEmployeeComparisons: true,
  comparisonPeriod: "weekly",
});

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

function previousSnapshot(period, now = new Date()) {
  if (period !== "monthly") return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const p = istParts(now);
  const previousMonthDate = new Date(Date.UTC(p.year, p.month - 1, 1));
  const y = previousMonthDate.getUTCFullYear();
  const m = previousMonthDate.getUTCMonth();
  const d = Math.min(p.day, daysInMonth(y, m));
  return istToUtc(y, m, d, p.hour, p.minute, p.second, p.ms);
}

function dayStart(date) {
  const p = istParts(date);
  return istToUtc(p.year, p.month, p.day);
}

function monthStart(date) {
  const p = istParts(date);
  return istToUtc(p.year, p.month, 1);
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

function normalizeDisplaySettings(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    showAdminComparisons: raw.showAdminComparisons !== false,
    showEmployeeComparisons: raw.showEmployeeComparisons !== false,
    comparisonPeriod: raw.comparisonPeriod === "monthly" ? "monthly" : "weekly",
  };
}

async function getDisplaySettings(query = db.query) {
  const { rows } = await query(
    `SELECT display_settings FROM crm_settings ORDER BY updated_at DESC LIMIT 1`
  );
  return normalizeDisplaySettings(rows[0]?.display_settings || DEFAULT_DISPLAY_SETTINGS);
}

async function saveDisplaySettings(next, actorId, query = db.query) {
  const settings = normalizeDisplaySettings(next);
  const { rowCount } = await query(
    `UPDATE crm_settings
     SET display_settings = $1::jsonb, updated_by = $2, updated_at = now()
     WHERE id = (SELECT id FROM crm_settings ORDER BY updated_at DESC LIMIT 1)`,
    [JSON.stringify(settings), actorId]
  );
  if (!rowCount) {
    const err = new Error("CRM settings row is missing");
    err.status = 500;
    throw err;
  }
  return settings;
}

async function pipelineSnapshot({ salesmanId = null, snapshotAt, dayWindowStart, query = db.query }) {
  const { rows } = await query(
    `WITH snapshot AS (
       SELECT
         l.id,
         l.created_at,
         l.deal_value,
         l.renewal_date,
         l.renewal_month,
         COALESCE(next_change.old_status, l.status) AS status_at_snapshot
       FROM leads l
       JOIN users u ON u.id = l.salesman_id
       LEFT JOIN LATERAL (
         SELECT h.old_status
         FROM lead_status_history h
         WHERE h.lead_id = l.id
           AND h.changed_at > $2::timestamptz
         ORDER BY h.changed_at ASC
         LIMIT 1
       ) next_change ON TRUE
       WHERE ($1::uuid IS NULL OR l.salesman_id = $1::uuid)
         AND l.created_at <= $2::timestamptz
     )
     SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status_at_snapshot = 'hot')::int AS hot,
       COUNT(*) FILTER (WHERE status_at_snapshot = 'conversation')::int AS conversation,
       COUNT(*) FILTER (WHERE status_at_snapshot = 'negotiation')::int AS negotiation,
       COUNT(*) FILTER (WHERE status_at_snapshot = 'won')::int AS won,
       COUNT(*) FILTER (WHERE created_at >= $3::timestamptz AND created_at <= $2::timestamptz)::int AS leads_today,
       COUNT(*) FILTER (WHERE created_at >= $3::timestamptz AND created_at <= $2::timestamptz AND status_at_snapshot = 'hot')::int AS hot_today,
       COALESCE(SUM(deal_value) FILTER (WHERE status_at_snapshot = 'won'), 0)::numeric AS won_value
     FROM snapshot`,
    [salesmanId, snapshotAt, dayWindowStart]
  );
  const r = rows[0] || {};
  return {
    total: Number(r.total || 0),
    hot: Number(r.hot || 0),
    conversation: Number(r.conversation || 0),
    negotiation: Number(r.negotiation || 0),
    won: Number(r.won || 0),
    leadsToday: Number(r.leads_today || 0),
    hotToday: Number(r.hot_today || 0),
    wonValue: Number(r.won_value || 0),
  };
}

async function employeeWonSnapshot({ salesmanId, snapshotAt, query = db.query }) {
  const start = monthStart(snapshotAt);
  const { rows } = await query(
    `WITH scoped AS (
       SELECT
         l.id,
         l.deal_value,
         COALESCE(next_change.old_status, l.status) AS status_at_snapshot
       FROM leads l
       LEFT JOIN LATERAL (
         SELECT h.old_status
         FROM lead_status_history h
         WHERE h.lead_id = l.id AND h.changed_at > $2::timestamptz
         ORDER BY h.changed_at ASC
         LIMIT 1
       ) next_change ON TRUE
       WHERE l.salesman_id = $1
         AND l.created_at <= $2::timestamptz
     ), won_in_month AS (
       SELECT DISTINCT h.lead_id
       FROM lead_status_history h
       JOIN leads l ON l.id = h.lead_id
       WHERE l.salesman_id = $1
         AND h.new_status = 'won'
         AND h.changed_at >= $3::timestamptz
         AND h.changed_at <= $2::timestamptz
     )
     SELECT
       COUNT(*)::int AS won,
       COALESCE(SUM(s.deal_value), 0)::numeric AS won_value
     FROM scoped s
     JOIN won_in_month w ON w.lead_id = s.id
     WHERE s.status_at_snapshot = 'won'`,
    [salesmanId, snapshotAt, start]
  );
  return {
    won: Number(rows[0]?.won || 0),
    wonValue: Number(rows[0]?.won_value || 0),
  };
}

async function currentRenewalsDue(salesmanId, now = new Date(), query = db.query) {
  const today = dayStart(now);
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count
     FROM leads l
     WHERE l.salesman_id = $1
       AND (
         (l.renewal_date IS NOT NULL AND l.renewal_date BETWEEN ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date AND (($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date + 30))
         OR (l.renewal_date IS NULL AND lower(l.renewal_month) IN (
           lower(to_char(($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, 'FMMonth')),
           lower(to_char((($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date + interval '1 month'), 'FMMonth'))
         ))
       )`,
    [salesmanId, today]
  );
  return Number(rows[0]?.count || 0);
}

async function getDashboardComparisonData({ role, userId, salesmanId, period, now = new Date(), query = db.query }) {
  const settings = await getDisplaySettings(query);
  const effectivePeriod = period === "monthly" || period === "weekly" ? period : settings.comparisonPeriod;
  const scopedSalesmanId = role === "salesman" ? userId : (salesmanId || null);
  const snapshotAt = previousSnapshot(effectivePeriod, now);

  const [currentPipeline, previousPipeline] = await Promise.all([
    pipelineSnapshot({ salesmanId: scopedSalesmanId, snapshotAt: now, dayWindowStart: dayStart(now), query }),
    pipelineSnapshot({ salesmanId: scopedSalesmanId, snapshotAt, dayWindowStart: dayStart(snapshotAt), query }),
  ]);

  if (role === "salesman") {
    const [currentWon, previousWon, renewalsDue] = await Promise.all([
      employeeWonSnapshot({ salesmanId: userId, snapshotAt: now, query }),
      employeeWonSnapshot({ salesmanId: userId, snapshotAt, query }),
      currentRenewalsDue(userId, now, query),
    ]);
    return {
      role,
      period: effectivePeriod,
      snapshotAt,
      settings,
      metrics: {
        total: currentPipeline.total,
        today: currentPipeline.leadsToday,
        hot: currentPipeline.hot,
        conversation: currentPipeline.conversation,
        negotiation: currentPipeline.negotiation,
        won: currentWon.won,
        wonValue: currentWon.wonValue,
        renewalsDue,
      },
      comparisons: {
        today: comparison(currentPipeline.leadsToday, previousPipeline.leadsToday),
        hot: comparison(currentPipeline.hot, previousPipeline.hot),
        conversation: comparison(currentPipeline.conversation, previousPipeline.conversation),
        negotiation: comparison(currentPipeline.negotiation, previousPipeline.negotiation),
        won: comparison(currentWon.won, previousWon.won),
      },
    };
  }

  return {
    role,
    period: effectivePeriod,
    snapshotAt,
    settings,
    metrics: {
      total: currentPipeline.total,
      conversation: currentPipeline.conversation,
      negotiation: currentPipeline.negotiation,
      won: currentPipeline.won,
      leadsToday: currentPipeline.leadsToday,
      hotToday: currentPipeline.hotToday,
      wonValue: currentPipeline.wonValue,
    },
    comparisons: {
      conversation: comparison(currentPipeline.conversation, previousPipeline.conversation),
      leadsToday: comparison(currentPipeline.leadsToday, previousPipeline.leadsToday),
      hotToday: comparison(currentPipeline.hotToday, previousPipeline.hotToday),
      negotiation: comparison(currentPipeline.negotiation, previousPipeline.negotiation),
      total: comparison(currentPipeline.total, previousPipeline.total),
      won: comparison(currentPipeline.won, previousPipeline.won),
    },
  };
}

module.exports = {
  DEFAULT_DISPLAY_SETTINGS,
  normalizeDisplaySettings,
  previousSnapshot,
  dayStart,
  monthStart,
  comparison,
  getDisplaySettings,
  saveDisplaySettings,
  getDashboardComparisonData,
};
