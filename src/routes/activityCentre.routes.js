const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_DAYS = new Set([7, 15, 30]);

function cleanSalesmanId(value) {
  if (!value || value === 'all') return null;
  if (typeof value !== 'string' || !UUID.test(value)) {
    const err = new Error('Invalid employee'); err.status = 400; throw err;
  }
  return value;
}

function cleanDays(value) {
  if (value == null || value === '') return 7;
  const days = Number(value);
  if (!Number.isInteger(days) || !ALLOWED_DAYS.has(days)) {
    const err = new Error('Invalid activity period'); err.status = 400; throw err;
  }
  return days;
}

function moduleFor(action, source) {
  if (source === 'quotation') return 'Quotation';
  if (source === 'payment') return 'Payment';
  if (action.startsWith('lead.')) return 'Lead';
  if (action.startsWith('task.')) return 'Task';
  if (action.startsWith('attendance.')) return 'Attendance';
  if (action.startsWith('salesman.')) return 'Employee';
  if (action.startsWith('onboarding.')) return 'Onboarding';
  if (action.startsWith('message.')) return 'Message';
  if (action.startsWith('settings.')) return 'Settings';
  return 'Activity';
}

function titleFor(row) {
  const a = row.action;
  const names = {
    'lead.created': 'Created lead',
    'lead.created_by_admin': 'Created lead',
    'lead.status_changed': 'Lead status changed',
    'lead.edited': 'Updated lead',
    'lead.deleted': 'Deleted lead',
    'lead.follow_up_scheduled': 'Added follow-up',
    'lead.follow_up_rescheduled': 'Rescheduled follow-up',
    'lead.follow_up_done': 'Completed follow-up',
    'lead.comment_updated': 'Updated lead note',
    'task.created': 'Created task',
    'task.completed': 'Completed task',
    'task.deleted': 'Deleted task',
    'attendance.day_start': 'Started Day',
    'attendance.day_end': 'Ended Day',
    'salesman.created': 'Created employee',
    'salesman.updated': 'Updated employee',
    'salesman.deleted': 'Deleted employee',
    'onboarding.updated': 'Updated onboarding',
    'message.sent': 'Sent message',
    'message.broadcast': 'Broadcast message',
    'settings.updated': 'Updated settings',
    'payment.recorded': 'Recorded payment',
    'quotation.created': 'Created quotation',
    'quotation.sent': 'Sent quotation',
    'quotation.accepted': 'Quotation accepted',
    'quotation.rejected': 'Quotation rejected',
    'quotation.approve': 'Approved quotation',
    'quotation.request_changes': 'Requested quotation changes',
    'quotation.changes_requested': 'Quotation changes requested',
    'quotation.follow_up': 'Quotation follow-up updated',
  };
  return names[a] || String(a || 'Activity').replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function detailFor(row) {
  if (row.source === 'payment') return row.amount != null ? `₹${Number(row.amount).toLocaleString('en-IN')}` : null;
  if (row.source === 'quotation') return row.record_label || null;
  if (row.action === 'lead.status_changed') {
    const from = row.from_value ? String(row.from_value).replace(/_/g, ' ') : null;
    const to = row.to_value ? String(row.to_value).replace(/_/g, ' ') : null;
    return from && to ? `${from} → ${to}` : (to || row.record_label || null);
  }
  if (row.action === 'lead.follow_up_rescheduled') return row.to_value ? `Next: ${row.to_value}` : row.record_label;
  if (row.action === 'task.created' || row.action === 'task.completed' || row.action === 'task.deleted') return row.task_title || row.record_label || null;
  return row.record_label || null;
}

router.get('/overview', async (req, res) => {
  const salesmanId = cleanSalesmanId(req.query.salesmanId);
  const days = cleanDays(req.query.days);
  const offset = days - 1;

  const [trendResult, activityResult] = await Promise.all([
    db.query(`
      WITH days AS (
        SELECT generate_series(
          (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date - $2::int,
          (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,
          interval '1 day'
        )::date AS day
      ), lead_counts AS (
        SELECT (l.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, count(*)::int AS leads_created
        FROM leads l
        WHERE ($1::uuid IS NULL OR l.salesman_id=$1)
          AND l.created_at >= (((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date - $2::int)::timestamp AT TIME ZONE 'Asia/Kolkata')
        GROUP BY 1
      ), status_counts AS (
        SELECT (a.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
          count(*) FILTER (WHERE a.metadata->>'to'='hot')::int AS moved_hot,
          count(*) FILTER (WHERE a.metadata->>'to'='negotiation')::int AS moved_negotiation,
          count(*) FILTER (WHERE a.metadata->>'to'='won')::int AS won
        FROM activity_logs a
        JOIN leads l ON a.entity_type='lead' AND l.id=a.entity_id
        WHERE a.action='lead.status_changed'
          AND ($1::uuid IS NULL OR l.salesman_id=$1)
          AND a.created_at >= (((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date - $2::int)::timestamp AT TIME ZONE 'Asia/Kolkata')
        GROUP BY 1
      ), followup_counts AS (
        SELECT (a.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, count(*)::int AS followups_done
        FROM activity_logs a
        JOIN leads l ON a.entity_type='lead' AND l.id=a.entity_id
        WHERE a.action='lead.follow_up_done'
          AND ($1::uuid IS NULL OR l.salesman_id=$1)
          AND a.created_at >= (((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date - $2::int)::timestamp AT TIME ZONE 'Asia/Kolkata')
        GROUP BY 1
      )
      SELECT d.day::text,
        coalesce(lc.leads_created,0)::int AS leads_created,
        coalesce(sc.moved_hot,0)::int AS moved_hot,
        coalesce(sc.moved_negotiation,0)::int AS moved_negotiation,
        coalesce(sc.won,0)::int AS won,
        coalesce(fc.followups_done,0)::int AS followups_done
      FROM days d
      LEFT JOIN lead_counts lc USING(day)
      LEFT JOIN status_counts sc USING(day)
      LEFT JOIN followup_counts fc USING(day)
      ORDER BY d.day
    `, [salesmanId, offset]),
    db.query(`
      WITH audit AS (
        SELECT a.id::text, a.created_at, 'audit'::text AS source, a.action,
          a.actor_id, coalesce(actor.full_name, 'Former user') AS actor_name,
          a.entity_type, a.entity_id::text,
          coalesce(a.metadata->>'businessName', l.business_name, subject.full_name) AS record_label,
          a.metadata->>'from' AS from_value, a.metadata->>'to' AS to_value,
          a.metadata->>'taskTitle' AS task_title,
          null::numeric AS amount
        FROM activity_logs a
        LEFT JOIN users actor ON actor.id=a.actor_id
        LEFT JOIN leads l ON a.entity_type='lead' AND l.id=a.entity_id
        LEFT JOIN users subject ON a.entity_type='user' AND subject.id=a.entity_id
        WHERE a.created_at >= now()-interval '30 days'
          AND ($1::uuid IS NULL OR a.actor_id=$1 OR l.salesman_id=$1 OR (a.entity_type='user' AND a.entity_id=$1) OR a.metadata->>'recipientId'=$1::text)
          AND a.action <> 'location.ping'
      ), quotes AS (
        SELECT qe.id::text, qe.created_at, 'quotation'::text AS source,
          ('quotation.'||qe.action)::text AS action, qe.actor_id,
          coalesce(u.full_name,'Former user') AS actor_name,
          'quotation'::text AS entity_type, qe.quote_id::text AS entity_id,
          coalesce(r.snapshot->'customer'->>'name', l.business_name, q.number::text) AS record_label,
          null::text AS from_value, null::text AS to_value, null::text AS task_title, null::numeric AS amount
        FROM quotation_events qe
        JOIN quotations q ON q.id=qe.quote_id
        LEFT JOIN quotation_revisions r ON r.quote_id=qe.quote_id AND r.revision=qe.revision
        LEFT JOIN leads l ON l.id=q.lead_id
        LEFT JOIN users u ON u.id=qe.actor_id
        WHERE qe.created_at >= now()-interval '30 days'
          AND ($1::uuid IS NULL OR q.owner_id=$1 OR l.salesman_id=$1 OR qe.actor_id=$1)
      ), payments AS (
        SELECT p.id::text, p.paid_at AS created_at, 'payment'::text AS source,
          'payment.recorded'::text AS action, p.recorded_by AS actor_id,
          coalesce(u.full_name,'Former user') AS actor_name,
          'lead'::text AS entity_type, p.lead_id::text AS entity_id,
          l.business_name AS record_label,
          null::text AS from_value, null::text AS to_value, null::text AS task_title, p.amount::numeric AS amount
        FROM lead_payments p
        JOIN leads l ON l.id=p.lead_id
        LEFT JOIN users u ON u.id=p.recorded_by
        WHERE p.paid_at >= now()-interval '30 days'
          AND ($1::uuid IS NULL OR l.salesman_id=$1 OR p.recorded_by=$1)
      )
      SELECT * FROM (
        SELECT * FROM audit
        UNION ALL SELECT * FROM quotes
        UNION ALL SELECT * FROM payments
      ) x
      ORDER BY created_at DESC, id DESC
      LIMIT 12
    `, [salesmanId]),
  ]);

  const trend = trendResult.rows.map(r => ({
    day: r.day,
    leadsCreated: Number(r.leads_created),
    movedHot: Number(r.moved_hot),
    movedNegotiation: Number(r.moved_negotiation),
    won: Number(r.won),
    followupsDone: Number(r.followups_done),
  }));

  const totals = trend.reduce((acc, r) => ({
    leadsCreated: acc.leadsCreated + r.leadsCreated,
    movedHot: acc.movedHot + r.movedHot,
    movedNegotiation: acc.movedNegotiation + r.movedNegotiation,
    won: acc.won + r.won,
    followupsDone: acc.followupsDone + r.followupsDone,
  }), { leadsCreated:0, movedHot:0, movedNegotiation:0, won:0, followupsDone:0 });

  const activities = activityResult.rows.map(row => ({
    id: `${row.source}:${row.id}`,
    source: row.source,
    action: row.action,
    module: moduleFor(row.action, row.source),
    title: titleFor(row),
    detail: detailFor(row),
    actorId: row.actor_id || null,
    actorName: row.actor_name || 'System',
    entityType: row.entity_type || null,
    entityId: row.entity_id || null,
    recordLabel: row.record_label || null,
    createdAt: row.created_at,
  }));

  res.json({ range: { days, timezone:'Asia/Kolkata' }, trend, totals, activities, generatedAt: new Date().toISOString() });
});

router.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
});

module.exports = router;
