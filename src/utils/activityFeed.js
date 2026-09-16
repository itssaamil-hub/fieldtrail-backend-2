const ACTIONS = ['onboarding.updated', 'task.deleted', 'task.created', 'task.completed', 'lead.created', 'lead.created_by_admin', 'lead.status_changed', 'lead.edited', 'lead.deleted', 'attendance.day_start', 'attendance.day_end', 'salesman.created', 'salesman.updated', 'salesman.deleted', 'message.sent', 'message.broadcast', 'settings.updated'];
const statusLabel = value => value ? String(value).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Unknown';
function cursorError() { const error = new Error('Invalid activity cursor'); error.status = 400; return error; }
function decodeCursor(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw cursorError();
  try {
    const c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!c || typeof c.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(c.time) || !Number.isFinite(Date.parse(c.time)) || typeof c.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.id)) throw cursorError();
    if (new Date(c.time).toISOString().slice(0, 19) !== c.time.slice(0, 19)) throw cursorError();
    return c;
  } catch { throw cursorError(); }
}
function formatActivity(row) {
  const actor = row.actor_name || 'Former user';
  const business = row.business_name || 'a removed lead';
  const subject = row.subject_name || 'an employee';
  const from = row.from_status ? statusLabel(row.from_status) : null;
  const to = row.to_status ? statusLabel(row.to_status) : null;
  const descriptions = {
    'lead.created': `added ${business}`,
    'lead.created_by_admin': `added ${business}`,
    'lead.status_changed': `moved ${business}${from ? ` from ${from}` : ''} to ${to || 'an unknown stage'}`,
    'lead.edited': `updated ${business}`,
    'lead.deleted': `deleted ${business}`,
    'attendance.day_start': 'started their day',
    'attendance.day_end': 'ended their day',
    'salesman.created': `added ${subject}`,
    'salesman.updated': `updated ${subject}`,
    'salesman.deleted': `removed ${subject}`,
    'message.sent': `sent a message to ${row.recipient_name || 'an employee'}`,
    'message.broadcast': 'sent a message to all employees',
    'onboarding.updated': `updated the onboarding checklist for ${business}`,
    'settings.updated': 'updated CRM settings',
    'task.created': `assigned task “${row.task_title || 'Task'}” to ${row.recipient_name || 'an employee'}`,
    'task.deleted': `deleted task “${row.task_title || 'Task'}”`,
    'task.completed': `completed task “${row.task_title || 'Task'}”`,
  };
  return { id: row.id, action: row.action, actorName: actor, businessName: row.business_name || null,
    description: `${actor} ${descriptions[row.action] || 'updated the CRM'}.`,
    fromStatus: row.from_status || null, toStatus: row.to_status || null, createdAt: row.event_time };
}
async function getActivityFeed(cursorValue, query = require('../db').query) {
  const cursor = decodeCursor(cursorValue);
  // Only project display-safe fields. Never return raw metadata (older logs may contain passwords).
  const { rows } = await query(`SELECT a.id, a.action,
    to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS event_time,
    COALESCE(u.full_name, a.metadata->>'actorName') AS actor_name,
    COALESCE(a.metadata->>'businessName', l.business_name) AS business_name,
    subject.full_name AS subject_name, recipient.full_name AS recipient_name,
    a.metadata->>'taskTitle' AS task_title, a.metadata->>'from' AS from_status, a.metadata->>'to' AS to_status
    FROM activity_logs a
    LEFT JOIN users u ON u.id = a.actor_id
    LEFT JOIN leads l ON a.entity_type = 'lead' AND l.id = a.entity_id
    LEFT JOIN users subject ON a.entity_type = 'user' AND subject.id = a.entity_id
    LEFT JOIN users recipient ON recipient.id::text = a.metadata->>'recipientId'
    WHERE a.action = ANY($1::text[])
      AND (a.action <> 'lead.status_changed' OR (a.metadata->>'from') IS DISTINCT FROM (a.metadata->>'to'))
      AND ($2::timestamptz IS NULL OR (a.created_at, a.id) < ($2::timestamptz, $3::uuid))
    ORDER BY a.created_at DESC, a.id DESC LIMIT 31`, [ACTIONS, cursor?.time || null, cursor?.id || null]);
  const page = rows.slice(0, 30), last = page[page.length - 1];
  return { activities: page.map(formatActivity), nextCursor: rows.length > 30 ? Buffer.from(JSON.stringify({ time: last.event_time, id: last.id })).toString('base64url') : null };
}
module.exports = { ACTIONS, getActivityFeed, decodeCursor, formatActivity };
