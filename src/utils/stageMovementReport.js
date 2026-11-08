// Read-only monthly Stage Movement Report. Existing status audit is authoritative.
const db = require("../db");
const STAGES = Object.freeze(["hot", "conversation", "negotiation", "won"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function parseFilters(input = {}) {
  const month = input.month;
  if (typeof month !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) {
    throw badRequest("Select a valid month (YYYY-MM).");
  }
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  const IST_MS = 330 * 60 * 1000;
  const start = new Date(Date.UTC(year, monthIndex, 1) - IST_MS);
  const end = new Date(Date.UTC(year, monthIndex + 1, 1) - IST_MS);
  const salesmanId = input.salesmanId == null || input.salesmanId === "" || input.salesmanId === "all"
    ? null : input.salesmanId;
  if (salesmanId !== null && (typeof salesmanId !== "string" || !UUID.test(salesmanId))) {
    throw badRequest("Invalid employee.");
  }
  return { month, start, end, salesmanId };
}

function parsePage(input = {}) {
  if (!STAGES.includes(input.stage)) throw badRequest("Invalid stage.");
  const rawPage = input.page == null ? "1" : String(input.page);
  const rawLimit = input.limit == null ? "50" : String(input.limit);
  if (!/^[1-9]\d{0,3}$/.test(rawPage) || !/^[1-9]\d{0,2}$/.test(rawLimit)) {
    throw badRequest("Invalid page or limit.");
  }
  const page = Number(rawPage);
  const limit = Number(rawLimit);
  if (page > 1000 || limit > 100) throw badRequest("Page or limit out of range.");
  return { stage: input.stage, page, limit, offset: (page - 1) * limit };
}

// At most one event per deal/stage in the selected month even if it re-entered.
// Attribution follows CURRENT lead owner (the same scope as the Admin Dashboard).
// The real changed_by audit actor is separately preserved in detail rows.
// Permanently deleted deals cannot be recovered from lead_status_history here.
const EVENTS_CTE = [
  "WITH stage_events AS (",
  " SELECT DISTINCT ON (h.lead_id, h.new_status)",
  "  h.id, h.lead_id, h.new_status::text AS stage,",
  "  h.old_status::text AS previous_stage, h.changed_by, h.changed_at,",
  "  l.salesman_id, l.business_name, l.status::text AS current_status,",
  "  COALESCE(owner.full_name, 'Former employee') AS owner_name,",
  "  COALESCE(actor.full_name, 'Former user') AS actor_name",
  " FROM lead_status_history h",
  " JOIN leads l ON l.id = h.lead_id",
  " LEFT JOIN users owner ON owner.id = l.salesman_id",
  " LEFT JOIN users actor ON actor.id = h.changed_by",
  " WHERE h.new_status::text IN ('hot','conversation','negotiation','won')",
  "   AND h.changed_at >= $1::timestamptz AND h.changed_at < $2::timestamptz",
  "   AND ($3::uuid IS NULL OR l.salesman_id = $3::uuid)",
  " ORDER BY h.lead_id, h.new_status, h.changed_at DESC, h.id DESC",
  ")"
].join("\n");

async function getSummary(filters, query = db.query) {
  const sql = EVENTS_CTE + "\n" + [
    "SELECT u.id AS salesman_id, u.full_name AS employee_name,",
    " COUNT(m.lead_id) FILTER (WHERE m.stage = 'hot')::int AS hot,",
    " COUNT(m.lead_id) FILTER (WHERE m.stage = 'conversation')::int AS conversation,",
    " COUNT(m.lead_id) FILTER (WHERE m.stage = 'negotiation')::int AS negotiation,",
    " COUNT(m.lead_id) FILTER (WHERE m.stage = 'won')::int AS won",
    "FROM users u LEFT JOIN stage_events m ON m.salesman_id = u.id",
    "WHERE u.role = 'salesman' AND ($3::uuid IS NULL OR u.id = $3::uuid)",
    " AND (u.is_active OR m.lead_id IS NOT NULL)",
    "GROUP BY u.id, u.full_name ORDER BY u.full_name, u.id"
  ].join("\n");
  const { rows } = await query(sql, [filters.start, filters.end, filters.salesmanId]);
  const employees = rows.map(row => ({
    salesmanId: row.salesman_id,
    employeeName: row.employee_name,
    hot: Number(row.hot || 0),
    conversation: Number(row.conversation || 0),
    negotiation: Number(row.negotiation || 0),
    won: Number(row.won || 0),
  }));
  const totals = {};
  for (const stage of STAGES) {
    totals[stage] = employees.reduce((sum, person) => sum + person[stage], 0);
  }
  const movements = STAGES.reduce((sum, stage) => sum + totals[stage], 0);
  return { month: filters.month, salesmanId: filters.salesmanId || "all",
    timezone: "Asia/Kolkata", totals, movements, employees };
}

async function getEvents(filters, selection, query = db.query) {
  const sql = EVENTS_CTE + "\n" + [
    "SELECT id, lead_id, stage, previous_stage, changed_at, changed_by,",
    " business_name, current_status, salesman_id, owner_name, actor_name,",
    " COUNT(*) OVER()::int AS total",
    "FROM stage_events WHERE stage = $4::text",
    "ORDER BY changed_at DESC, id DESC LIMIT $5::int OFFSET $6::int"
  ].join("\n");
  const { rows } = await query(sql, [
    filters.start, filters.end, filters.salesmanId,
    selection.stage, selection.limit, selection.offset
  ]);
  const total = Number(rows[0]?.total || 0);
  return {
    month: filters.month, salesmanId: filters.salesmanId || "all",
    stage: selection.stage, page: selection.page, limit: selection.limit,
    total, hasNext: selection.offset + rows.length < total,
    events: rows.map(row => ({
      id: row.id, leadId: row.lead_id, businessName: row.business_name,
      stage: row.stage, previousStage: row.previous_stage,
      currentStatus: row.current_status, occurredAt: row.changed_at,
      salesmanId: row.salesman_id, employeeName: row.owner_name,
      changedById: row.changed_by, changedByName: row.actor_name
    }))
  };
}

module.exports = { STAGES, parseFilters, parsePage, getSummary, getEvents };
