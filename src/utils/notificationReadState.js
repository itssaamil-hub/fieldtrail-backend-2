const { ACTIONS } = require('./activityFeed');
const { localDate } = require('./salesBriefing');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function badRequest(message) { const err = new Error(message); err.status = 400; return err; }
async function ensureState(userId, query) {
  await query('INSERT INTO notification_read_state (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
}
async function getUnread(user, query = require('../db').query) {
  await ensureState(user.id, query);
  if (user.role === 'admin') {
    const { rows } = await query(`SELECT count(*)::integer AS count FROM activity_logs a
      JOIN notification_read_state r ON r.user_id = $1
      WHERE a.action = ANY($2::text[])
      AND (a.action <> 'lead.status_changed' OR (a.metadata->>'from') IS DISTINCT FROM (a.metadata->>'to'))
      AND (a.created_at, a.id) > (r.activity_seen_at, r.activity_seen_id)`, [user.id, ACTIONS]);
    return { count: rows[0].count, kind: 'activity' };
  }
  const { rows } = await query(`SELECT count(*)::integer AS count FROM sales_briefing_deliveries d
    JOIN notification_read_state r ON r.user_id = d.user_id
    WHERE d.user_id = $1 AND d.day = $2::date AND r.briefing_seen_day IS DISTINCT FROM d.day`, [user.id, localDate()]);
  return { count: rows[0].count, kind: 'briefing' };
}
async function markRead(user, body, query = require('../db').query) {
  if (body?.kind === 'activity') {
    if (user.role !== 'admin') { const err = new Error('Requires admin role'); err.status = 403; throw err; }
    if (typeof body.throughId !== 'string' || !UUID.test(body.throughId)) throw badRequest('Invalid activity ID');
    await ensureState(user.id, query);
    // Never use the client clock or move a watermark backwards. Events arriving later stay unread.
    await query(`UPDATE notification_read_state r SET activity_seen_at = a.created_at, activity_seen_id = a.id
      FROM activity_logs a WHERE r.user_id = $1 AND a.id = $2 AND a.action = ANY($3::text[])
      AND (a.created_at, a.id) > (r.activity_seen_at, r.activity_seen_id)`, [user.id, body.throughId, ACTIONS]);
  } else if (body?.kind === 'briefing') {
    if (user.role !== 'salesman') throw badRequest('Briefing read state belongs to salesmen');
    if (typeof body.day !== 'string' || body.day !== localDate()) throw badRequest('Invalid briefing day');
    await ensureState(user.id, query);
    await query(`UPDATE notification_read_state r SET briefing_seen_day = d.day
      FROM sales_briefing_deliveries d WHERE r.user_id = $1 AND d.user_id = r.user_id AND d.day = $2::date`, [user.id, body.day]);
  } else throw badRequest('Invalid notification kind');
  return { ok: true };
}
module.exports = { getUnread, markRead };
