const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

// Paginated admin lead reads. Existing callers that do not send page/limit
// keep the historical latest-500 behavior so dashboard/report flows can be
// migrated independently without a breaking API change.
router.get("/leads", async (req, res) => {
  const { salesmanId, status, date, from, to } = req.query;
  const search = String(req.query.search || "").trim().slice(0, 200);
  const explicitlyPaged = req.query.page != null || req.query.limit != null || req.query.search != null || req.query.date != null;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = explicitlyPaged
    ? Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 50))
    : 500;
  const offset = explicitlyPaged ? (page - 1) * limit : 0;

  const clauses = [];
  const params = [];
  let i = 1;

  if (salesmanId) {
    clauses.push(`l.salesman_id = $${i++}`);
    params.push(salesmanId);
  }
  if (status) {
    clauses.push(`l.status = $${i++}`);
    params.push(status);
  }
  if (date) {
    clauses.push(`l.created_at >= $${i}::date AND l.created_at < ($${i}::date + interval '1 day')`);
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
      `SELECT l.*, u.full_name AS salesman_name,
              (wm.occurred_at AT TIME ZONE 'Asia/Kolkata')::date AS won_date
       FROM leads l
       JOIN users u ON u.id = l.salesman_id
       LEFT JOIN lead_stage_milestones wm ON wm.lead_id=l.id AND wm.stage='won'
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
