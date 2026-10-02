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
    weekday: shifted.getUTCDay(),
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

function weekStart(date) {
  const p = istParts(date);
  const daysFromMonday = (p.weekday + 6) % 7;
  return new Date(dayStart(date).getTime() - daysFromMonday * 24 * 60 * 60 * 1000);
}

function monthStart(date) {
  const p = istParts(date);
  return istToUtc(p.year, p.month, 1);
}

function wonPeriodWindow(period, now = new Date()) {
  const previousEnd = previousSnapshot(period, now);
  return {
    currentStart: period === "monthly" ? monthStart(now) : weekStart(now),
    currentEnd: now,
    previousStart: period === "monthly" ? monthStart(previousEnd) : weekStart(previousEnd),
    previousEnd,
  };
}

function comparison(current, previous) {
  const c = Number(current || 0);
  const p = Number(previous || 0);
  return {
    current: c,
    previous: p,
    pct: p === 0 ? (c === 0 ? 0 : 100) : Math.round(((c - p) / p) * 100),
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
       COUNT(*) FILTER (WHERE created_at >= $3::timestamptz AND created_at <= $2::timestamptz)::int AS leads_today,
       COUNT(*) FILTER (WHERE created_at >= $3::timestamptz AND created_at <= $2::timestamptz AND status_at_snapshot = 'hot')::int AS hot_today
     FROM snapshot`,
    [salesmanId, snapshotAt, dayWindowStart]
  );
  const r = rows[0] || {};
  return {
    total: Number(r.total || 0),
    hot: Number(r.hot || 0),
    conversation: Number(r.conversation || 0),
    negotiation: Number(r.negotiation || 0),
    leadsToday: Number(r.leads_today || 0),
    hotToday: Number(r.hot_today || 0),
  };
}

// ADMIN MAIN KPI ONLY: current real Won state. Never use milestone dates here.
async function currentWonKpiMetrics({ salesmanId = null, query = db.query }) {
  const { rows } = await query(
    `SELECT
       COUNT(*)::int AS current_won_count,
       COALESCE(SUM(COALESCE(l.deal_value, 0)), 0)::numeric AS current_won_value
     FROM leads l
     WHERE l.status = 'won'
       AND ($1::uuid IS NULL OR l.salesman_id = $1::uuid)`,
    [salesmanId]
  );
  return {
    currentWonCount: Number(rows[0]?.current_won_count || 0),
    currentWonValue: Number(rows[0]?.current_won_value || 0),
  };
}

// SALESMAN MAIN KPI ONLY: current Won deals whose canonical first-Won milestone
// falls in the current IST calendar month. The milestone stays for history if
// the deal later leaves Won, but the main KPI must then stop counting it.
// This is intentionally independent from the Weekly/Monthly comparison setting.
async function currentMonthWonMetrics({ salesmanId, now = new Date(), query = db.query }) {
  const start = monthStart(now);
  const { rows } = await query(
    `SELECT
       COUNT(*)::int AS month_won_count,
       COALESCE(SUM(COALESCE(l.deal_value, 0)), 0)::numeric AS month_won_value
     FROM lead_stage_milestones m
     JOIN leads l ON l.id = m.lead_id
     WHERE m.stage = 'won'
       AND l.status = 'won'
       AND m.salesman_id = $1::uuid
       AND m.occurred_at >= $2::timestamptz
       AND m.occurred_at <= $3::timestamptz`,
    [salesmanId, start, now]
  );
  return {
    monthWonCount: Number(rows[0]?.month_won_count || 0),
    monthWonValue: Number(rows[0]?.month_won_value || 0),
  };
}

// COMPARISON ONLY: unique first-Won milestone events in the selected period.
// This count must never be used as the Admin main/current Won KPI.
async function wonComparisonPeriodCount({ salesmanId = null, start, end, query = db.query }) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS period_won_count
     FROM lead_stage_milestones m
     WHERE m.stage = 'won'
       AND ($1::uuid IS NULL OR m.salesman_id = $1::uuid)
       AND m.occurred_at >= $2::timestamptz
       AND m.occurred_at <= $3::timestamptz`,
    [salesmanId, start, end]
  );
  return Number(rows[0]?.period_won_count || 0);
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
  const wonWindow = wonPeriodWindow(effectivePeriod, now);

  const [currentPipeline, previousPipeline, currentWonKpi, currentPeriodWonCount, previousPeriodWonCount] = await Promise.all([
    pipelineSnapshot({ salesmanId: scopedSalesmanId, snapshotAt: now, dayWindowStart: dayStart(now), query }),
    pipelineSnapshot({ salesmanId: scopedSalesmanId, snapshotAt, dayWindowStart: dayStart(snapshotAt), query }),
    currentWonKpiMetrics({ salesmanId: scopedSalesmanId, query }),
    wonComparisonPeriodCount({ salesmanId: scopedSalesmanId, start: wonWindow.currentStart, end: wonWindow.currentEnd, query }),
    wonComparisonPeriodCount({ salesmanId: scopedSalesmanId, start: wonWindow.previousStart, end: wonWindow.previousEnd, query }),
  ]);

  if (role === "salesman") {
    const [renewalsDue, currentMonthWon] = await Promise.all([
      currentRenewalsDue(userId, now, query),
      currentMonthWonMetrics({ salesmanId: userId, now, query }),
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
        won: currentMonthWon.monthWonCount,
        wonValue: currentMonthWon.monthWonValue,
        renewalsDue,
      },
      comparisons: {
        today: comparison(currentPipeline.leadsToday, previousPipeline.leadsToday),
        hot: comparison(currentPipeline.hot, previousPipeline.hot),
        conversation: comparison(currentPipeline.conversation, previousPipeline.conversation),
        negotiation: comparison(currentPipeline.negotiation, previousPipeline.negotiation),
        won: comparison(currentPeriodWonCount, previousPeriodWonCount),
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
      won: currentWonKpi.currentWonCount,
      leadsToday: currentPipeline.leadsToday,
      hotToday: currentPipeline.hotToday,
      wonValue: currentWonKpi.currentWonValue,
    },
    comparisons: {
      conversation: comparison(currentPipeline.conversation, previousPipeline.conversation),
      leadsToday: comparison(currentPipeline.leadsToday, previousPipeline.leadsToday),
      hotToday: comparison(currentPipeline.hotToday, previousPipeline.hotToday),
      negotiation: comparison(currentPipeline.negotiation, previousPipeline.negotiation),
      total: comparison(currentPipeline.total, previousPipeline.total),
      won: comparison(currentPeriodWonCount, previousPeriodWonCount),
    },
  };
}

module.exports = {
  DEFAULT_DISPLAY_SETTINGS,
  normalizeDisplaySettings,
  previousSnapshot,
  dayStart,
  weekStart,
  monthStart,
  wonPeriodWindow,
  comparison,
  getDisplaySettings,
  saveDisplaySettings,
  currentWonKpiMetrics,
  currentMonthWonMetrics,
  wonComparisonPeriodCount,
  getDashboardComparisonData,
};