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
    check('won_without_deal_value','warning',`
      SELECT count(*) FROM leads WHERE status='won' AND deal_value IS NULL`),
    check('task_assignee_lead_owner_mismatch','warning',`
      SELECT count(*) FROM crm_tasks t JOIN leads l ON l.id=t.lead_id
      WHERE t.lead_id IS NOT NULL AND t.assigned_to<>l.salesman_id AND t.status<>'completed'`),
    check('payments_without_lead','critical',`
      SELECT count(*) FROM lead_payments p LEFT JOIN leads l ON l.id=p.lead_id
      WHERE p.lead_id IS NOT NULL AND l.id IS NULL`),
    check('payments_exceed_current_deal_value','warning',`
      SELECT count(*) FROM (
        SELECT l.id,coalesce(sum(p.amount),0) paid,coalesce(ca.total,l.deal_value,0) total
        FROM leads l LEFT JOIN lead_payments p ON p.lead_id=l.id
        LEFT JOIN collection_accounts ca ON ca.lead_id=l.id
        GROUP BY l.id,ca.total,l.deal_value
        HAVING coalesce(sum(p.amount),0)>coalesce(ca.total,l.deal_value,0)
      ) x`),
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
    check('current_followup_missing_event','warning',`
      SELECT count(*) FROM leads l
      WHERE l.next_follow_up_date IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM lead_followup_events f WHERE f.lead_id=l.id)`),
  ]);

  const summary = checks.reduce((a,c)=>{
    a.total += c.count;
    if (!c.ok) a[c.severity] = (a[c.severity] || 0) + c.count;
    return a;
  }, { total:0, critical:0, warning:0 });
  res.json({ok:summary.critical===0,checkedAt:new Date().toISOString(),summary,checks});
});

module.exports = router;
