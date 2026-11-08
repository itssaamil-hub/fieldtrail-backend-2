const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Paginated admin lead reads. Existing callers that do not send page/limit
// keep the historical latest-500 behavior so dashboard/report flows can be
// migrated independently without a breaking API change.
router.get("/leads", async (req, res) => {
  const { salesmanId, status, date, from, to } = req.query;
  // Opt-in filter for the Negotiation KPI only; default lead reads are unchanged.
  const negotiationPeriod = req.query.negotiationPeriod || null;
  if (negotiationPeriod !== null && (negotiationPeriod !== "month" || status !== "negotiation")) {
    return res.status(400).json({ error: "Invalid Negotiation KPI period." });
  }
  // Admin Dashboard month drill-down only; ordinary lead lists are unchanged.
  const dashboardMonth = req.query.dashboardMonth == null ? null : String(req.query.dashboardMonth);
  if (dashboardMonth !== null && (!/^(20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(dashboardMonth)
    || (status && !["hot", "conversation", "negotiation", "won"].includes(status))
    || negotiationPeriod !== null || date || from || to)) {
    return res.status(400).json({ error: "Invalid dashboard month filter." });
  }
  const leadId = req.query.leadId ? String(req.query.leadId) : null;
  if (leadId && !UUID.test(leadId)) return res.status(400).json({error:"Invalid lead"});
  const search = String(req.query.search || "").trim().slice(0, 200);
  const explicitlyPaged = req.query.page != null || req.query.limit != null || req.query.search != null || req.query.date != null || req.query.dashboardMonth != null || leadId != null;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = leadId ? 1 : explicitlyPaged
    ? Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 50))
    : 500;
  const offset = explicitlyPaged ? (page - 1) * limit : 0;

  const clauses = [];
  const params = [];
  let i = 1;

  if (leadId) {
    clauses.push(`l.id = $${i++}::uuid`);
    params.push(leadId);
  }
  if (salesmanId) {
    clauses.push(`l.salesman_id = $${i++}`);
    params.push(salesmanId);
  }
  if (status) {
    clauses.push(`l.status = $${i++}`);
    params.push(status);
  }
  if (dashboardMonth !== null) {
    // Month boundaries are IST; stage cards use the last stage-entry event.
    const start = "((($" + i + "::text || '-01')::date)::timestamp AT TIME ZONE 'Asia/Kolkata')";
    const end = "((($" + i + "::text || '-01')::date + INTERVAL '1 month')::timestamp AT TIME ZONE 'Asia/Kolkata')";
    const occurred = status === "won"
      ? "(SELECT m.occurred_at FROM lead_stage_milestones m WHERE m.lead_id = l.id AND m.stage = 'won' ORDER BY m.occurred_at ASC LIMIT 1)"
      : status
        ? "COALESCE((SELECT h.changed_at FROM lead_status_history h WHERE h.lead_id = l.id AND h.new_status = l.status ORDER BY h.changed_at DESC, h.id DESC LIMIT 1), l.created_at)"
        : "l.created_at";
    clauses.push(occurred + " >= " + start + " AND " + occurred + " < " + end);
    params.push(dashboardMonth);
    i += 1;
  }
  if (negotiationPeriod === "month") {
    // Current Negotiation deals that last ENTERED this stage in the current
    // India calendar month. For deals created directly in Negotiation without a
    // status change, use creation time. A transition out and back uses the
    // latest entry. Never equate lead creation month with transition month.
    clauses.push(`COALESCE((
      SELECT h.changed_at FROM lead_status_history h
      WHERE h.lead_id = l.id AND h.new_status = 'negotiation'
      ORDER BY h.changed_at DESC, h.id DESC LIMIT 1
    ), l.created_at) >= (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
    AND COALESCE((
      SELECT h.changed_at FROM lead_status_history h
      WHERE h.lead_id = l.id AND h.new_status = 'negotiation'
      ORDER BY h.changed_at DESC, h.id DESC LIMIT 1
    ), l.created_at) <= now()`);
  }
  if (date) {
    clauses.push(`l.created_at >= ${i}::date AND l.created_at < (${i}::date + interval '1 day')`);
    params.push(date);
    i += 1;
  } else {
    if (from) {
      clauses.push(`l.created_at >= $${i++}::timestamptz`);
      params.push(from);
    }
    if (to) {
      clauses.push(`l.created_at < $${i++}::timestamptz`);
      params.push(to);
    }
  }
  if (search) {
    clauses.push(`(
      l.business_name ILIKE $${i} OR l.contact_name ILIKE $${i} OR l.phone ILIKE $${i}
      OR l.sub_location ILIKE $${i} OR l.pos_name ILIKE $${i} OR u.full_name ILIKE $${i}
    )`);
    params.push(`%${search}%`);
    i += 1;
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limitParam = params.length + 1;
  const offsetParam = params.length + 2;
  const dataParams = [...params, limit, offset];

  const [countResult, dataResult] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS total
       FROM leads l JOIN users u ON u.id = l.salesman_id
       ${where}`,
      params
    ),
    db.query(
      `SELECT l.*, u.full_name AS salesman_name, won.occurred_at AS won_date
       FROM leads l
       JOIN users u ON u.id = l.salesman_id
       LEFT JOIN lead_stage_milestones won ON won.lead_id = l.id AND won.stage = 'won'
       ${where}
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      dataParams
    ),
  ]);

  const total = Number(countResult.rows[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  res.json({
    leads: dataResult.rows,
    total,
    page,
    limit,
    totalPages,
    hasNext: explicitlyPaged && page < totalPages,
    hasPrevious: explicitlyPaged && page > 1,
  });
});

module.exports = router;
