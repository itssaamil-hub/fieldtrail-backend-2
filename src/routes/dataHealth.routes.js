const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});

const check = async (key, severity, sql, params = []) => {
  const { rows } = await db.query(sql, params);
  const count = Number(rows[0]?.count || 0);
  return { key, severity, count, ok: count === 0 };
};

router.get('/', async (req, res) => {
  const checks = await Promise.all([
    check('leads_assigned_to_inactive_employee','warning',`
      SELECT count(*) FROM leads l JOIN users u ON u.id=l.salesman_id
      WHERE u.role<>'salesman' OR u.is_active=false`),
    check('multiple_open_attendance_sessions','critical',`
      SELECT count(*) FROM (
        SELECT salesman_id FROM attendance
        WHERE start_day_at IS NOT NULL AND end_day_at IS NULL
        GROUP BY salesman_id HAVING count(*)>1
      ) x`),
    check('attendance_end_before_start','critical',`
      SELECT count(*) FROM attendance
      WHERE end_day_at IS NOT NULL AND start_day_at IS NOT NULL AND end_day_at < start_day_at`),
    check('attendance_invalid_coordinates','critical',`
      SELECT count(*) FROM attendance
      WHERE (start_lat IS NOT NULL AND (start_lat < -90 OR start_lat > 90))
         OR (start_lng IS NOT NULL AND (start_lng < -180 OR start_lng > 180))
         OR (end_lat IS NOT NULL AND (end_lat < -90 OR end_lat > 90))
         OR (end_lng IS NOT NULL AND (end_lng < -180 OR end_lng > 180))`),
    check('invalid_location_pings','critical',`
      SELECT count(*) FROM location_pings
      WHERE latitude < -90 OR latitude > 90 OR longitude < -180 OR longitude > 180
         OR (accuracy_m IS NOT NULL AND accuracy_m < 0)
         OR (battery_pct IS NOT NULL AND (battery_pct < 0 OR battery_pct > 100))`),
    check('invalid_visits','critical',`
      SELECT count(*) FROM visits
      WHERE latitude < -90 OR latitude > 90 OR longitude < -180 OR longitude > 180
         OR (accuracy_m IS NOT NULL AND accuracy_m < 0)
         OR (left_at IS NOT NULL AND left_at < arrived_at)`),
    check('won_without_deal_value','warning',`
      SELECT count(*) FROM leads WHERE status='won' AND deal_value IS NULL`),
    check('negative_deal_value','critical',`
      SELECT count(*) FROM leads WHERE deal_value < 0`),
    check('task_assignee_lead_owner_mismatch','warning',`
      SELECT count(*) FROM crm_tasks t JOIN leads l ON l.id=t.lead_id
      WHERE t.lead_id IS NOT NULL AND t.assigned_to<>l.salesman_id AND t.status<>'completed'`),
    check('payments_without_lead','critical',`
      SELECT count(*) FROM lead_payments p LEFT JOIN leads l ON l.id=p.lead_id
      WHERE p.lead_id IS NOT NULL AND l.id IS NULL`),
    check('nonpositive_payments','critical',`
      SELECT count(*) FROM lead_payments WHERE amount <= 0`),
    check('payments_exceed_current_deal_value','warning',`
      SELECT count(*) FROM (
        SELECT l.id,coalesce(sum(p.amount),0) paid,coalesce(ca.total,l.deal_value,0) total
        FROM leads l LEFT JOIN lead_payments p ON p.lead_id=l.id
        LEFT JOIN collection_accounts ca ON ca.lead_id=l.id
        GROUP BY l.id,ca.total,l.deal_value
        HAVING coalesce(sum(p.amount),0)>coalesce(ca.total,l.deal_value,0)
      ) x`),
    check('nonpositive_expenses','critical',`
      SELECT count(*) FROM expenses WHERE amount <= 0`),
    check('onboarding_without_lead','critical',`
      SELECT count(*) FROM customer_onboarding c LEFT JOIN leads l ON l.id=c.lead_id WHERE l.id IS NULL`),
    check('push_subscription_for_inactive_user','warning',`
      SELECT count(*) FROM push_subscriptions p JOIN users u ON u.id=p.user_id WHERE u.is_active=false`),
    check('duplicate_open_owner_history','critical',`
      SELECT count(*) FROM (
        SELECT lead_id FROM lead_owner_history WHERE unassigned_at IS NULL
        GROUP BY lead_id HAVING count(*)>1
      ) x`),
    check('lead_missing_owner_history','warning',`
      SELECT count(*) FROM leads l LEFT JOIN lead_owner_history h ON h.lead_id=l.id
      WHERE h.id IS NULL`),
    check('owner_history_current_owner_mismatch','warning',`
      SELECT count(*) FROM leads l
      LEFT JOIN lead_owner_history h ON h.lead_id=l.id AND h.unassigned_at IS NULL
      WHERE h.salesman_id IS DISTINCT FROM l.salesman_id`),
    check('current_followup_missing_event','warning',`
      SELECT count(*) FROM leads l
      WHERE l.next_follow_up_date IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM lead_followup_events f WHERE f.lead_id=l.id)`),
    check('won_missing_milestone','warning',`
      SELECT count(*) FROM leads l
      WHERE l.status='won' AND NOT EXISTS(
        SELECT 1 FROM lead_stage_milestones m WHERE m.lead_id=l.id AND m.stage='won'
      )`),
    check('quotation_current_revision_missing','critical',`
      SELECT count(*) FROM quotations q
      LEFT JOIN quotation_revisions r ON r.quote_id=q.id AND r.revision=q.current_revision
      WHERE r.quote_id IS NULL`),
    check('quotation_events_missing_revision','warning',`
      SELECT count(*) FROM quotation_events e
      LEFT JOIN quotation_revisions r ON r.quote_id=e.quote_id AND r.revision=e.revision
      WHERE r.quote_id IS NULL`),
    check('quotation_accepted_without_sent_at','warning',`
      SELECT count(*) FROM quotation_revisions
      WHERE status='accepted' AND sent_at IS NULL`),
    check('message_blank_body','critical',`
      SELECT count(*) FROM messages WHERE length(btrim(coalesce(body,'')))=0`),
    check('message_parent_missing','warning',`
      SELECT count(*) FROM messages m LEFT JOIN messages p ON p.id=m.parent_message_id
      WHERE m.parent_message_id IS NOT NULL AND p.id IS NULL`),
    check('message_thread_root_missing','warning',`
      SELECT count(*) FROM messages m LEFT JOIN messages r ON r.id=m.thread_root_id
      WHERE m.thread_root_id IS NOT NULL AND r.id IS NULL`),
    check('scheduled_job_failed_recently','warning',`
      SELECT count(*) FROM scheduled_job_runs
      WHERE status='failed' AND started_at >= now() - interval '7 days'`),
    check('scheduled_job_stuck_running','warning',`
      SELECT count(*) FROM scheduled_job_runs
      WHERE status='running' AND started_at < now() - interval '30 minutes'`),
  ]);

  const summary = checks.reduce((a,c)=>{
    a.total += c.count;
    if (!c.ok) a[c.severity] = (a[c.severity] || 0) + c.count;
    return a;
  }, { total:0, critical:0, warning:0 });
  res.json({ok:summary.critical===0,checkedAt:new Date().toISOString(),summary,checks});
});

module.exports = router;
