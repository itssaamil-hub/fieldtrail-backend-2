const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

router.use(requireAuth, requireRole('admin'));

function workingDays(start, end) {
  let count = 0;
  const d = new Date(`${start}T12:00:00Z`);
  const last = new Date(`${end}T12:00:00Z`);
  while (d <= last) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

router.get('/', async (req, res) => {
  const month = DAY_RE.test(req.query.month || '') ? req.query.month : null;
  const salesmanId = req.query.salesmanId || null;
  if (salesmanId && !UUID.test(salesmanId)) return res.status(400).json({ error: 'Invalid employee' });

  const { rows } = await db.query(`
    WITH bounds AS (
      SELECT
        date_trunc('month', COALESCE($1::date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date))::date AS start_day,
        (date_trunc('month', COALESCE($1::date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date)) + interval '1 month - 1 day')::date AS end_day,
        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date AS today
    ), people AS (
      SELECT u.id, u.full_name FROM users u
      WHERE u.role='salesman' AND ($2::uuid IS NULL OR u.id=$2)
    ), lead_stats AS (
      SELECT l.salesman_id,
        count(*) FILTER (WHERE (l.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN b.start_day AND b.end_day)::int AS leads_added,
        count(*) FILTER (WHERE l.next_follow_up_date BETWEEN b.start_day AND b.end_day)::int AS followups_due,
        count(*) FILTER (WHERE l.next_follow_up_date BETWEEN b.start_day AND LEAST(b.end_day,b.today) AND l.status NOT IN ('won','lost'))::int AS overdue_followups
      FROM leads l CROSS JOIN bounds b GROUP BY l.salesman_id
    ), status_stats AS (
      SELECT l.salesman_id,
        count(DISTINCT a.entity_id) FILTER (WHERE a.metadata->>'to'='demo')::int AS demos,
        count(DISTINCT a.entity_id) FILTER (WHERE a.metadata->>'to'='negotiation')::int AS negotiations,
        count(DISTINCT a.entity_id) FILTER (WHERE a.metadata->>'to'='won')::int AS won,
        count(DISTINCT a.entity_id) FILTER (WHERE a.metadata->>'to'='lost')::int AS lost,
        coalesce(sum(l.deal_value) FILTER (WHERE a.metadata->>'to'='won'),0)::numeric AS sales_value
      FROM activity_logs a
      JOIN leads l ON a.entity_type='lead' AND l.id=a.entity_id
      CROSS JOIN bounds b
      WHERE a.action='lead.status_changed'
        AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN b.start_day AND b.end_day
      GROUP BY l.salesman_id
    ), followup_done AS (
      SELECT l.salesman_id, count(*)::int AS followups_completed
      FROM activity_logs a JOIN leads l ON a.entity_type='lead' AND l.id=a.entity_id CROSS JOIN bounds b
      WHERE a.action='lead.follow_up_done'
        AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN b.start_day AND b.end_day
      GROUP BY l.salesman_id
    ), task_stats AS (
      SELECT t.assigned_to salesman_id,
        count(*) FILTER (WHERE t.status='completed' AND (t.completed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN b.start_day AND b.end_day)::int AS tasks_completed,
        count(*) FILTER (WHERE t.status IN ('pending','in_progress') AND (t.due_at AT TIME ZONE 'Asia/Kolkata')::date <= LEAST(b.end_day,b.today))::int AS tasks_overdue
      FROM crm_tasks t CROSS JOIN bounds b GROUP BY t.assigned_to
    ), attendance_stats AS (
      SELECT a.salesman_id,
        count(DISTINCT a.day) FILTER (WHERE a.start_day_at IS NOT NULL)::int AS active_days
      FROM attendance a CROSS JOIN bounds b
      WHERE a.day BETWEEN b.start_day AND b.end_day
      GROUP BY a.salesman_id
    ), closing_stats AS (
      SELECT r.user_id salesman_id,
        count(DISTINCT r.day) FILTER (WHERE r.status<>'draft')::int AS closing_days
      FROM day_closing_reports r CROSS JOIN bounds b
      WHERE r.day BETWEEN b.start_day AND b.end_day
      GROUP BY r.user_id
    ), visit_stats AS (
      SELECT v.salesman_id, count(*)::int AS visits
      FROM visits v CROSS JOIN bounds b
      WHERE (v.arrived_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN b.start_day AND b.end_day
      GROUP BY v.salesman_id
    )
    SELECT p.id, p.full_name,
      coalesce(ls.leads_added,0)::int AS leads_added,
      coalesce(ls.followups_due,0)::int AS followups_due,
      coalesce(ls.overdue_followups,0)::int AS overdue_followups,
      coalesce(fd.followups_completed,0)::int AS followups_completed,
      coalesce(ss.demos,0)::int AS demos,
      coalesce(ss.negotiations,0)::int AS negotiations,
      coalesce(ss.won,0)::int AS won,
      coalesce(ss.lost,0)::int AS lost,
      coalesce(ss.sales_value,0)::numeric AS sales_value,
      coalesce(ts.tasks_completed,0)::int AS tasks_completed,
      coalesce(ts.tasks_overdue,0)::int AS tasks_overdue,
      coalesce(a.active_days,0)::int AS active_days,
      coalesce(c.closing_days,0)::int AS closing_days,
      coalesce(v.visits,0)::int AS visits,
      b.start_day, b.end_day, LEAST(b.end_day,b.today) AS effective_end
    FROM people p CROSS JOIN bounds b
    LEFT JOIN lead_stats ls ON ls.salesman_id=p.id
    LEFT JOIN status_stats ss ON ss.salesman_id=p.id
    LEFT JOIN followup_done fd ON fd.salesman_id=p.id
    LEFT JOIN task_stats ts ON ts.salesman_id=p.id
    LEFT JOIN attendance_stats a ON a.salesman_id=p.id
    LEFT JOIN closing_stats c ON c.salesman_id=p.id
    LEFT JOIN visit_stats v ON v.salesman_id=p.id
    ORDER BY p.full_name
  `, [month, salesmanId]);

  const normalized = rows.map(r => {
    const leads = Number(r.leads_added || 0), demos = Number(r.demos || 0), won = Number(r.won || 0), sales = Number(r.sales_value || 0), active = Number(r.active_days || 0);
    const workDays = workingDays(String(r.start_day).slice(0,10), String(r.effective_end).slice(0,10));
    return {
      id: r.id,
      name: r.full_name,
      leadsAdded: leads,
      followUpsDue: Number(r.followups_due || 0),
      followUpsCompleted: Number(r.followups_completed || 0),
      overdueFollowUps: Number(r.overdue_followups || 0),
      demos,
      negotiations: Number(r.negotiations || 0),
      won,
      lost: Number(r.lost || 0),
      salesValue: sales,
      averageDealValue: won ? Math.round(sales / won) : 0,
      leadToDemoPct: leads ? Math.round(demos / leads * 1000) / 10 : 0,
      demoToWonPct: demos ? Math.round(won / demos * 1000) / 10 : 0,
      leadToWonPct: leads ? Math.round(won / leads * 1000) / 10 : 0,
      tasksCompleted: Number(r.tasks_completed || 0),
      tasksOverdue: Number(r.tasks_overdue || 0),
      activeDays: active,
      workingDays: workDays,
      dayClosingSubmitted: Number(r.closing_days || 0),
      visits: Number(r.visits || 0),
      averageLeadsPerActiveDay: active ? Math.round(leads / active * 10) / 10 : 0,
      averageFollowUpsPerActiveDay: active ? Math.round(Number(r.followups_completed || 0) / active * 10) / 10 : 0,
    };
  });

  res.set('Cache-Control', 'no-store');
  res.json({ month: rows[0]?.start_day || month, rows: normalized });
});

module.exports = router;
