// "Brief" for one employee on one day: sessions, headline counts, the closing
// report, and a time-ordered list of everything they did. All day boundaries
// are IST, matching Day Closing.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const IST_DAY = (col) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date = $2::date`;
const label = (v) => (v ? String(v).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Unknown");
const QUOTE_ACTIONS = { created: "created", sent: "marked sent", approved: "approved", changes_requested: "sent back for changes", follow_up: "follow-up scheduled", accepted: "marked accepted", rejected: "marked rejected" };

function istToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function validDay(value) {
  if (!DAY_RE.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

async function getSalesmanBrief(query, salesmanId, day) {
  const who = await query(`SELECT u.id, u.full_name FROM users u WHERE u.id = $1 AND u.role = 'salesman'`, [salesmanId]);
  if (!who.rows[0]) { const e = new Error("Employee not found"); e.status = 404; throw e; }

  const [sessions, logs, visits, quotes, payments, closing] = await Promise.all([
    query(`SELECT id, session_number, start_day_at, end_day_at, total_distance_m FROM attendance
           WHERE salesman_id = $1 AND day = $2::date AND start_day_at IS NOT NULL ORDER BY session_number`, [salesmanId, day]),
    query(`SELECT a.action, a.created_at AS at, COALESCE(a.metadata->>'businessName', l.business_name) AS business,
                  a.metadata->>'from' AS from_status, a.metadata->>'to' AS to_status, a.metadata->>'taskTitle' AS task_title
           FROM activity_logs a LEFT JOIN leads l ON a.entity_type = 'lead' AND l.id = a.entity_id
           WHERE a.actor_id = $1 AND ${IST_DAY("a.created_at")}
             AND a.action IN ('lead.created','lead.status_changed','lead.edited','lead.deleted','task.completed','onboarding.updated')
             AND (a.action <> 'lead.status_changed' OR (a.metadata->>'from') IS DISTINCT FROM (a.metadata->>'to'))
           ORDER BY a.created_at`, [salesmanId, day]),
    query(`SELECT business_name, arrived_at, left_at, notes FROM visits WHERE salesman_id = $1 AND ${IST_DAY("arrived_at")} ORDER BY arrived_at`, [salesmanId, day]),
    query(`SELECT e.action, e.created_at AS at, l.business_name AS business, q.number
           FROM quotation_events e JOIN quotations q ON q.id = e.quote_id LEFT JOIN leads l ON l.id = q.lead_id
           WHERE e.actor_id = $1 AND ${IST_DAY("e.created_at")} ORDER BY e.created_at`, [salesmanId, day]),
    query(`SELECT p.amount, p.paid_at AS at, l.business_name AS business FROM lead_payments p JOIN leads l ON l.id = p.lead_id
           WHERE p.recorded_by = $1 AND ${IST_DAY("p.paid_at")} ORDER BY p.paid_at`, [salesmanId, day]),
    query(`SELECT r.status, r.outcomes, r.blockers, r.priorities, r.skip_reason, a.session_number
           FROM day_closing_reports r JOIN attendance a ON a.id = r.attendance_id
           WHERE r.user_id = $1 AND r.day = $2::date AND r.status <> 'draft' ORDER BY a.session_number`, [salesmanId, day]),
  ]);

  const events = [];
  for (const s of sessions.rows) {
    const n = sessions.rows.length > 1 ? ` (session ${s.session_number})` : "";
    events.push({ type: "day", at: s.start_day_at, text: `Started the day${n}` });
    if (s.end_day_at) events.push({ type: "day", at: s.end_day_at, text: `Ended the day${n}` });
  }
  for (const r of logs.rows) {
    const b = r.business || "a lead";
    const text = {
      "lead.created": `Added lead ${b}`,
      "lead.status_changed": `Moved ${b}${r.from_status ? ` from ${label(r.from_status)}` : ""} to ${label(r.to_status)}`,
      "lead.edited": `Updated ${b}`,
      "lead.deleted": `Deleted ${b}`,
      "task.completed": `Completed task “${r.task_title || "Task"}”`,
      "onboarding.updated": `Updated onboarding checklist for ${b}`,
    }[r.action];
    events.push({ type: r.action.split(".")[0], at: r.at, text });
  }
  for (const v of visits.rows) events.push({ type: "visit", at: v.arrived_at, text: `Visited ${v.business_name || "a location"}${v.left_at ? "" : " (still there)"}` });
  for (const q of quotes.rows) events.push({ type: "quote", at: q.at, text: `Quotation #${q.number}${q.business ? ` for ${q.business}` : ""} ${QUOTE_ACTIONS[q.action] || label(q.action).toLowerCase()}` });
  for (const p of payments.rows) events.push({ type: "payment", at: p.at, text: `Recorded payment of ₹${Number(p.amount).toLocaleString("en-IN")} from ${p.business}` });
  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  const count = (t) => events.filter((e) => e.type === t).length;
  const statusRows = logs.rows.filter((r) => r.action === "lead.status_changed");
  const distanceM = sessions.rows.reduce((sum, s) => sum + Number(s.total_distance_m || 0), 0);
  return {
    employee: { id: who.rows[0].id, name: who.rows[0].full_name },
    day,
    sessions: sessions.rows.map((s) => ({ session: s.session_number, startedAt: s.start_day_at, endedAt: s.end_day_at })),
    summary: {
      leadsAdded: logs.rows.filter((r) => r.action === "lead.created").length,
      statusChanges: statusRows.length,
      won: statusRows.filter((r) => r.to_status === "won").length,
      visits: visits.rows.length,
      quotes: quotes.rows.length,
      tasksDone: logs.rows.filter((r) => r.action === "task.completed").length,
      payments: payments.rows.length,
      distanceKm: Math.round(distanceM / 100) / 10,
    },
    closing: closing.rows.map((r) => ({ session: r.session_number, status: r.status, outcomes: r.outcomes, blockers: r.blockers, priorities: r.priorities, skipReason: r.skip_reason })),
    events,
  };
}

module.exports = { getSalesmanBrief, validDay, istToday };
