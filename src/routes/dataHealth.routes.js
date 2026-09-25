const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});

const CATALOG = {
  leads_assigned_to_inactive_employee:{category:'Leads',title:'Lead assigned to inactive employee',severity:'warning',why:'A lead is still assigned to a salesman account that is inactive or no longer a salesman.'},
  multiple_open_attendance_sessions:{category:'Attendance',title:'Multiple open attendance sessions',severity:'critical',why:'A salesman has more than one active Start Day session.'},
  attendance_end_before_start:{category:'Attendance',title:'Attendance end before start',severity:'critical',why:'An attendance row has an End Day timestamp earlier than its Start Day timestamp.'},
  attendance_open_over_24h:{category:'Attendance',title:'Attendance open over 24 hours',severity:'warning',why:'A Start Day session has remained open for more than 24 hours.'},
  attendance_invalid_coordinates:{category:'Location',title:'Invalid attendance coordinates',severity:'critical',why:'Start/End Day GPS coordinates are outside valid latitude or longitude ranges.'},
  invalid_location_pings:{category:'Location',title:'Invalid location pings',severity:'critical',why:'Continuous location tracking contains impossible GPS, accuracy or battery values.'},
  invalid_visits:{category:'Visits',title:'Invalid visits',severity:'critical',why:'A visit has impossible GPS data or an end time before its arrival time.'},
  won_without_deal_value:{category:'Performance',title:'Won without deal value',severity:'warning',why:'A Won lead has no deal value, so sales value reports can be incomplete.'},
  negative_deal_value:{category:'Performance',title:'Negative deal value',severity:'critical',why:'A lead contains a negative deal value.'},
  won_missing_milestone:{category:'Performance',title:'Won missing milestone',severity:'warning',why:'A lead is currently Won but has no Won milestone in the performance ledger.'},
  owner_history_current_owner_mismatch:{category:'Performance',title:'Owner history mismatch',severity:'warning',why:'The open owner-history row does not match the lead’s current salesman.'},
  duplicate_open_owner_history:{category:'Performance',title:'Duplicate open owner history',severity:'critical',why:'A lead has more than one current owner-history row.'},
  lead_missing_owner_history:{category:'Performance',title:'Lead missing owner history',severity:'warning',why:'A lead has no ownership-history record.'},
  current_followup_missing_event:{category:'Follow-ups',title:'Follow-up missing history event',severity:'warning',why:'A lead has a current follow-up date but no follow-up event ledger.'},
  task_assignee_lead_owner_mismatch:{category:'Tasks',title:'Task assignee / lead owner mismatch',severity:'warning',why:'An open lead-linked task is assigned to someone other than the lead owner.'},
  completed_task_missing_timestamp:{category:'Tasks',title:'Completed task missing completion time',severity:'warning',why:'A task is marked completed without a completion timestamp.'},
  open_task_inactive_assignee:{category:'Tasks',title:'Open task assigned to inactive employee',severity:'warning',why:'An unfinished task is assigned to an inactive user.'},
  payments_without_lead:{category:'Payments',title:'Payment references missing lead',severity:'critical',why:'A payment points to a lead that no longer exists.'},
  nonpositive_payments:{category:'Payments',title:'Non-positive payments',severity:'critical',why:'A payment has a zero or negative amount.'},
  payments_exceed_current_deal_value:{category:'Payments',title:'Payments exceed account value',severity:'warning',why:'Recorded payments are greater than the current deal/account total.'},
  nonpositive_expenses:{category:'Payments',title:'Non-positive expenses',severity:'critical',why:'An expense has a zero or negative amount.'},
  onboarding_without_lead:{category:'Onboarding',title:'Onboarding missing lead',severity:'critical',why:'An onboarding record references a lead that no longer exists.'},
  quotation_current_revision_missing:{category:'Quotations',title:'Quotation current revision missing',severity:'critical',why:'A quotation points to a current revision that does not exist.'},
  quotation_events_missing_revision:{category:'Quotations',title:'Quotation event missing revision',severity:'warning',why:'A quotation event references a revision that no longer exists.'},
  quotation_accepted_without_sent_at:{category:'Quotations',title:'Accepted quotation missing sent time',severity:'warning',why:'An accepted quotation has no recorded sent timestamp.'},
  quotation_owner_lead_owner_mismatch:{category:'Quotations',title:'Quotation owner / lead owner mismatch',severity:'warning',why:'A lead-linked quotation owner differs from the lead’s current owner.'},
  message_blank_body:{category:'Messages',title:'Blank message body',severity:'critical',why:'A stored message has no visible content.'},
  message_parent_missing:{category:'Messages',title:'Message parent missing',severity:'warning',why:'A reply references a parent message that no longer exists.'},
  message_thread_root_missing:{category:'Messages',title:'Message thread root missing',severity:'warning',why:'A threaded message references a missing conversation root.'},
  push_subscription_for_inactive_user:{category:'Notifications',title:'Inactive user has push subscription',severity:'warning',why:'An inactive account still has a browser push subscription.'},
  scheduled_job_failed_recently:{category:'System',title:'Scheduled job failed recently',severity:'warning',why:'A scheduled notification job failed during the last 7 days.'},
  scheduled_job_stuck_running:{category:'System',title:'Scheduled job appears stuck',severity:'warning',why:'A scheduled job has remained in running state for more than 30 minutes.'},
};

const CHECKS = {
  leads_assigned_to_inactive_employee:`SELECT count(*) FROM leads l JOIN users u ON u.id=l.salesman_id WHERE u.role<>'salesman' OR u.is_active=false`,
  multiple_open_attendance_sessions:`SELECT count(*) FROM (SELECT salesman_id FROM attendance WHERE start_day_at IS NOT NULL AND end_day_at IS NULL GROUP BY salesman_id HAVING count(*)>1) x`,
  attendance_end_before_start:`SELECT count(*) FROM attendance WHERE end_day_at IS NOT NULL AND start_day_at IS NOT NULL AND end_day_at < start_day_at`,
  attendance_open_over_24h:`SELECT count(*) FROM attendance WHERE start_day_at IS NOT NULL AND end_day_at IS NULL AND start_day_at < now()-interval '24 hours'`,
  attendance_invalid_coordinates:`SELECT count(*) FROM attendance WHERE (start_lat IS NOT NULL AND (start_lat < -90 OR start_lat > 90)) OR (start_lng IS NOT NULL AND (start_lng < -180 OR start_lng > 180)) OR (end_lat IS NOT NULL AND (end_lat < -90 OR end_lat > 90)) OR (end_lng IS NOT NULL AND (end_lng < -180 OR end_lng > 180))`,
  invalid_location_pings:`SELECT count(*) FROM location_pings WHERE latitude < -90 OR latitude > 90 OR longitude < -180 OR longitude > 180 OR (accuracy_m IS NOT NULL AND accuracy_m < 0) OR (battery_pct IS NOT NULL AND (battery_pct < 0 OR battery_pct > 100))`,
  invalid_visits:`SELECT count(*) FROM visits WHERE latitude < -90 OR latitude > 90 OR longitude < -180 OR longitude > 180 OR (accuracy_m IS NOT NULL AND accuracy_m < 0) OR (left_at IS NOT NULL AND left_at < arrived_at)`,
  won_without_deal_value:`SELECT count(*) FROM leads WHERE status='won' AND deal_value IS NULL`,
  negative_deal_value:`SELECT count(*) FROM leads WHERE deal_value < 0`,
  task_assignee_lead_owner_mismatch:`SELECT count(*) FROM crm_tasks t JOIN leads l ON l.id=t.lead_id WHERE t.lead_id IS NOT NULL AND t.assigned_to<>l.salesman_id AND t.status<>'completed'`,
  completed_task_missing_timestamp:`SELECT count(*) FROM crm_tasks WHERE status='completed' AND completed_at IS NULL`,
  open_task_inactive_assignee:`SELECT count(*) FROM crm_tasks t JOIN users u ON u.id=t.assigned_to WHERE t.status<>'completed' AND u.is_active=false`,
  payments_without_lead:`SELECT count(*) FROM lead_payments p LEFT JOIN leads l ON l.id=p.lead_id WHERE p.lead_id IS NOT NULL AND l.id IS NULL`,
  nonpositive_payments:`SELECT count(*) FROM lead_payments WHERE amount <= 0`,
  payments_exceed_current_deal_value:`SELECT count(*) FROM (SELECT l.id,coalesce(sum(p.amount),0) paid,coalesce(ca.total,l.deal_value,0) total FROM leads l LEFT JOIN lead_payments p ON p.lead_id=l.id LEFT JOIN collection_accounts ca ON ca.lead_id=l.id GROUP BY l.id,ca.total,l.deal_value HAVING coalesce(sum(p.amount),0)>coalesce(ca.total,l.deal_value,0)) x`,
  nonpositive_expenses:`SELECT count(*) FROM expenses WHERE amount <= 0`,
  onboarding_without_lead:`SELECT count(*) FROM customer_onboarding c LEFT JOIN leads l ON l.id=c.lead_id WHERE l.id IS NULL`,
  push_subscription_for_inactive_user:`SELECT count(*) FROM push_subscriptions p JOIN users u ON u.id=p.user_id WHERE u.is_active=false`,
  duplicate_open_owner_history:`SELECT count(*) FROM (SELECT lead_id FROM lead_owner_history WHERE unassigned_at IS NULL GROUP BY lead_id HAVING count(*)>1) x`,
  lead_missing_owner_history:`SELECT count(*) FROM leads l LEFT JOIN lead_owner_history h ON h.lead_id=l.id WHERE h.id IS NULL`,
  owner_history_current_owner_mismatch:`SELECT count(*) FROM leads l LEFT JOIN lead_owner_history h ON h.lead_id=l.id AND h.unassigned_at IS NULL WHERE h.salesman_id IS DISTINCT FROM l.salesman_id`,
  current_followup_missing_event:`SELECT count(*) FROM leads l WHERE l.next_follow_up_date IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lead_followup_events f WHERE f.lead_id=l.id)`,
  won_missing_milestone:`SELECT count(*) FROM leads l WHERE l.status='won' AND NOT EXISTS(SELECT 1 FROM lead_stage_milestones m WHERE m.lead_id=l.id AND m.stage='won')`,
  quotation_current_revision_missing:`SELECT count(*) FROM quotations q LEFT JOIN quotation_revisions r ON r.quote_id=q.id AND r.revision=q.current_revision WHERE r.quote_id IS NULL`,
  quotation_events_missing_revision:`SELECT count(*) FROM quotation_events e LEFT JOIN quotation_revisions r ON r.quote_id=e.quote_id AND r.revision=e.revision WHERE r.quote_id IS NULL`,
  quotation_accepted_without_sent_at:`SELECT count(*) FROM quotation_revisions WHERE status='accepted' AND sent_at IS NULL`,
  quotation_owner_lead_owner_mismatch:`SELECT count(*) FROM quotations q JOIN leads l ON l.id=q.lead_id WHERE q.lead_id IS NOT NULL AND q.owner_id IS DISTINCT FROM l.salesman_id`,
  message_blank_body:`SELECT count(*) FROM messages WHERE length(btrim(coalesce(body,'')))=0`,
  message_parent_missing:`SELECT count(*) FROM messages m LEFT JOIN messages p ON p.id=m.parent_message_id WHERE m.parent_message_id IS NOT NULL AND p.id IS NULL`,
  message_thread_root_missing:`SELECT count(*) FROM messages m LEFT JOIN messages r ON r.id=m.thread_root_id WHERE m.thread_root_id IS NOT NULL AND r.id IS NULL`,
  scheduled_job_failed_recently:`SELECT count(*) FROM scheduled_job_runs WHERE status='failed' AND started_at >= now() - interval '7 days'`,
  scheduled_job_stuck_running:`SELECT count(*) FROM scheduled_job_runs WHERE status='running' AND started_at < now() - interval '30 minutes'`,
};

const DETAIL = {
  attendance_end_before_start:`SELECT a.id,a.day,a.start_day_at,a.end_day_at,u.full_name AS employee FROM attendance a LEFT JOIN users u ON u.id=a.salesman_id WHERE a.end_day_at IS NOT NULL AND a.start_day_at IS NOT NULL AND a.end_day_at<a.start_day_at ORDER BY a.day DESC LIMIT 50`,
  attendance_open_over_24h:`SELECT a.id,a.day,a.start_day_at,u.full_name AS employee FROM attendance a LEFT JOIN users u ON u.id=a.salesman_id WHERE a.start_day_at IS NOT NULL AND a.end_day_at IS NULL AND a.start_day_at<now()-interval '24 hours' ORDER BY a.start_day_at LIMIT 50`,
  won_missing_milestone:`SELECT l.id,l.business_name,l.status,l.deal_value,u.full_name AS employee,l.updated_at FROM leads l LEFT JOIN users u ON u.id=l.salesman_id WHERE l.status='won' AND NOT EXISTS(SELECT 1 FROM lead_stage_milestones m WHERE m.lead_id=l.id AND m.stage='won') ORDER BY l.updated_at DESC LIMIT 50`,
  won_without_deal_value:`SELECT l.id,l.business_name,u.full_name AS employee,l.updated_at FROM leads l LEFT JOIN users u ON u.id=l.salesman_id WHERE l.status='won' AND l.deal_value IS NULL ORDER BY l.updated_at DESC LIMIT 50`,
  leads_assigned_to_inactive_employee:`SELECT l.id,l.business_name,u.full_name AS employee,u.is_active,u.role FROM leads l JOIN users u ON u.id=l.salesman_id WHERE u.role<>'salesman' OR u.is_active=false ORDER BY l.created_at DESC LIMIT 50`,
  owner_history_current_owner_mismatch:`SELECT l.id,l.business_name,cu.full_name AS current_employee,hu.full_name AS history_employee FROM leads l LEFT JOIN users cu ON cu.id=l.salesman_id LEFT JOIN lead_owner_history h ON h.lead_id=l.id AND h.unassigned_at IS NULL LEFT JOIN users hu ON hu.id=h.salesman_id WHERE h.salesman_id IS DISTINCT FROM l.salesman_id LIMIT 50`,
  current_followup_missing_event:`SELECT l.id,l.business_name,l.next_follow_up_date,u.full_name AS employee FROM leads l LEFT JOIN users u ON u.id=l.salesman_id WHERE l.next_follow_up_date IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lead_followup_events f WHERE f.lead_id=l.id) ORDER BY l.next_follow_up_date LIMIT 50`,
  task_assignee_lead_owner_mismatch:`SELECT t.id,t.title,l.business_name,tu.full_name AS task_employee,lu.full_name AS lead_employee,t.due_at FROM crm_tasks t JOIN leads l ON l.id=t.lead_id LEFT JOIN users tu ON tu.id=t.assigned_to LEFT JOIN users lu ON lu.id=l.salesman_id WHERE t.assigned_to<>l.salesman_id AND t.status<>'completed' ORDER BY t.due_at LIMIT 50`,
  payments_exceed_current_deal_value:`SELECT l.id,l.business_name,coalesce(sum(p.amount),0) AS paid,coalesce(ca.total,l.deal_value,0) AS total FROM leads l LEFT JOIN lead_payments p ON p.lead_id=l.id LEFT JOIN collection_accounts ca ON ca.lead_id=l.id GROUP BY l.id,l.business_name,ca.total,l.deal_value HAVING coalesce(sum(p.amount),0)>coalesce(ca.total,l.deal_value,0) LIMIT 50`,
  scheduled_job_failed_recently:`SELECT job_key,run_day,status,started_at,finished_at,error FROM scheduled_job_runs WHERE status='failed' AND started_at>=now()-interval '7 days' ORDER BY started_at DESC LIMIT 50`,
  scheduled_job_stuck_running:`SELECT job_key,run_day,status,started_at FROM scheduled_job_runs WHERE status='running' AND started_at<now()-interval '30 minutes' ORDER BY started_at LIMIT 50`,
};

async function runCheck(key){
  const meta=CATALOG[key];
  const {rows}=await db.query(CHECKS[key]);
  const count=Number(rows[0]?.count||0);
  return {key,...meta,count,ok:count===0,detailsAvailable:Boolean(DETAIL[key])};
}

router.get('/', async (req,res)=>{
  const checks=await Promise.all(Object.keys(CHECKS).map(runCheck));
  const summary=checks.reduce((a,c)=>{a.records+=c.count;a.checks++;if(!c.ok){a.issues++;a[c.severity]=(a[c.severity]||0)+c.count;}return a;},{records:0,checks:0,issues:0,critical:0,warning:0});
  const migration=await db.query(`SELECT filename,applied_at FROM schema_migrations ORDER BY filename DESC LIMIT 1`);
  const jobs=await db.query(`SELECT job_key,max(finished_at) FILTER (WHERE status='completed') AS last_success,max(started_at) AS last_attempt FROM scheduled_job_runs GROUP BY job_key ORDER BY job_key`);
  res.json({ok:summary.critical===0,checkedAt:new Date().toISOString(),summary,checks,system:{database:'connected',latestMigration:migration.rows[0]||null,jobs:jobs.rows}});
});

router.get('/details/:key',async(req,res)=>{
  const key=String(req.params.key||'');
  if(!DETAIL[key]||!CATALOG[key]) return res.status(404).json({error:'Details are not available for this check.'});
  const {rows}=await db.query(DETAIL[key]);
  res.json({key,title:CATALOG[key].title,severity:CATALOG[key].severity,rows,limited:rows.length>=50});
});

module.exports=router;
