from pathlib import Path

path = Path('src/routes/salesman.routes.js')
text = path.read_text()
old = '''// GET /salesman/leads  — own leads only
router.get("/leads", async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM leads WHERE salesman_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ leads: rows });
});'''
if old not in text:
    raise SystemExit('Expected salesman leads route not found')
new = r'''// GET /salesman/leads — own leads only. Pagination is opt-in so older
// frontend deployments keep their existing response shape during rollout.
router.get("/leads", async (req, res) => {
  const paginated = req.query.page != null || req.query.limit != null || req.query.status || req.query.date || req.query.search;
  if (!paginated) {
    const { rows } = await db.query(
      `SELECT * FROM leads WHERE salesman_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    return res.json({ leads: rows });
  }

  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const search = String(req.query.search || "").trim().slice(0, 200);
  const params = [req.user.id];
  const clauses = ["salesman_id = $1"];
  let i = 2;

  if (req.query.status) { clauses.push(`status = $${i++}`); params.push(req.query.status); }
  if (req.query.date) {
    clauses.push(`created_at >= $${i}::date AND created_at < ($${i}::date + interval '1 day')`);
    params.push(req.query.date); i += 1;
  }
  if (search) {
    clauses.push(`(business_name ILIKE $${i} OR contact_name ILIKE $${i} OR phone ILIKE $${i} OR sub_location ILIKE $${i} OR pos_name ILIKE $${i})`);
    params.push(`%${search}%`); i += 1;
  }

  const where = `WHERE ${clauses.join(" AND ")}`;
  const [countResult, dataResult] = await Promise.all([
    db.query(`SELECT count(*)::int AS total FROM leads ${where}`, params),
    db.query(
      `SELECT * FROM leads ${where} ORDER BY created_at DESC, id DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]
    ),
  ]);
  const total = Number(countResult.rows[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  res.json({ leads: dataResult.rows, total, page, limit, totalPages, hasNext: page < totalPages, hasPrevious: page > 1 });
});

// GET /salesman/leads-summary — accurate KPI counts without downloading the
// salesman's entire lead history to the phone.
router.get("/leads-summary", async (req, res) => {
  const { rows } = await db.query(`
    WITH bounds AS (
      SELECT
        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date AS today,
        date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date AS month_start,
        (date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') + interval '1 month')::date AS next_month_start
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE (l.created_at AT TIME ZONE 'Asia/Kolkata')::date = b.today)::int AS today,
      COUNT(*) FILTER (WHERE (l.created_at AT TIME ZONE 'Asia/Kolkata')::date >= b.month_start AND (l.created_at AT TIME ZONE 'Asia/Kolkata')::date < b.next_month_start)::int AS month,
      COUNT(*) FILTER (WHERE l.status = 'hot')::int AS hot,
      COUNT(*) FILTER (WHERE l.status = 'conversation')::int AS conversation,
      COUNT(*) FILTER (WHERE l.status = 'negotiation')::int AS negotiation,
      COUNT(*) FILTER (WHERE l.status = 'won')::int AS won,
      COUNT(*) FILTER (WHERE l.status NOT IN ('won','lost'))::int AS pending,
      COALESCE(SUM(l.deal_value) FILTER (WHERE l.status = 'won'), 0)::numeric AS won_value,
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
  `, [req.user.id]);
  const r = rows[0] || {};
  res.json({
    total: Number(r.total || 0), today: Number(r.today || 0), month: Number(r.month || 0),
    hot: Number(r.hot || 0), conversation: Number(r.conversation || 0), negotiation: Number(r.negotiation || 0),
    won: Number(r.won || 0), pending: Number(r.pending || 0), wonValue: Number(r.won_value || 0),
    renewalsDue: Number(r.renewals_due || 0),
  });
});'''
text = text.replace(old, new)
path.write_text(text)

migration = Path('src/migrations/062_salesman_lead_pagination_indexes.sql')
migration.write_text('''-- Supports salesman-owned newest-first pages and status-filtered pages.\nCREATE INDEX IF NOT EXISTS idx_leads_salesman_status_created_id\n  ON leads (salesman_id, status, created_at DESC, id DESC);\n''')
print('salesman lead pagination + summary added')
