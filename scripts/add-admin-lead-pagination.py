from pathlib import Path

path = Path('src/routes/admin.routes.js')
text = path.read_text()
start_marker = 'router.get("/leads", async (req, res) => {'
start = text.index(start_marker)
end = text.index('\n});', start) + 4
old = text[start:end]
if 'LIMIT 500' not in old:
    raise SystemExit('Expected legacy /admin/leads LIMIT 500 route not found')

new = r'''router.get("/leads", async (req, res) => {
  const { salesmanId, status, date, from, to } = req.query;
  const search = String(req.query.search || "").trim().slice(0, 200);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const clauses = [];
  const params = [];
  let i = 1;

  if (salesmanId) { clauses.push(`l.salesman_id = $${i++}`); params.push(salesmanId); }
  if (status) { clauses.push(`l.status = $${i++}`); params.push(status); }
  if (date) {
    clauses.push(`l.created_at >= $${i}::date AND l.created_at < ($${i}::date + interval '1 day')`);
    params.push(date); i += 1;
  } else {
    if (from) { clauses.push(`l.created_at >= $${i++}::timestamptz`); params.push(from); }
    if (to) { clauses.push(`l.created_at < $${i++}::timestamptz`); params.push(to); }
  }
  if (search) {
    clauses.push(`(
      l.business_name ILIKE $${i} OR l.contact_name ILIKE $${i} OR l.phone ILIKE $${i}
      OR l.sub_location ILIKE $${i} OR l.pos_name ILIKE $${i} OR u.full_name ILIKE $${i}
    )`);
    params.push(`%${search}%`); i += 1;
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const countSql = `SELECT count(*)::int AS total FROM leads l JOIN users u ON u.id = l.salesman_id ${where}`;
  const dataParams = [...params, limit, offset];
  const limitParam = params.length + 1;
  const offsetParam = params.length + 2;

  const [countResult, dataResult] = await Promise.all([
    db.query(countSql, params),
    db.query(
      `SELECT l.*, u.full_name AS salesman_name
       FROM leads l JOIN users u ON u.id = l.salesman_id
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
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  });
});'''

text = text[:start] + new + text[end:]
path.write_text(text)

migration = Path('src/migrations/061_admin_lead_pagination_indexes.sql')
migration.write_text('''CREATE INDEX IF NOT EXISTS idx_leads_created_id_desc\n  ON leads (created_at DESC, id DESC);\n\nCREATE INDEX IF NOT EXISTS idx_leads_salesman_created_desc\n  ON leads (salesman_id, created_at DESC, id DESC);\n\nCREATE INDEX IF NOT EXISTS idx_leads_status_created_desc\n  ON leads (status, created_at DESC, id DESC);\n\nCREATE INDEX IF NOT EXISTS idx_leads_salesman_status_created_desc\n  ON leads (salesman_id, status, created_at DESC, id DESC);\n''')
print('Added paginated /admin/leads route and supporting indexes')
