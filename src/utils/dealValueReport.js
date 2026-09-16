async function getDealValueReport(query = require('../db').query) {
  // Aggregate in Postgres over the entire pipeline, not the capped lead-list API.
  const { rows } = await query(`SELECT status::text AS status,
    count(*)::integer AS lead_count,
    count(*) FILTER (WHERE deal_value IS NULL)::integer AS missing_count,
    COALESCE(sum(deal_value), 0)::text AS total_value
    FROM leads GROUP BY status ORDER BY status`);
  return { stages: rows };
}
module.exports = { getDealValueReport };
