// Read-only activity feed. The existing dashboard overview is deliberately unchanged.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = message => Object.assign(new Error(message), { status: 400 });
function parseFilters(q, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  function day(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw fail('Choose a valid date');
    return value;
  }
  const from = day(q.from || today), through = day(q.through || today);
  if (from > through || Date.parse(through)-Date.parse(from)>366*86400000) throw fail('Choose a date range of up to 367 days');
  const employee = q.employee && q.employee !== 'all' ? q.employee : null;
  if (employee && (typeof employee !== 'string' || !UUID.test(employee))) throw fail('Invalid employee');
  const category = q.category || 'all';
  if (!['all','sales','payments','team','system'].includes(category)) throw fail('Invalid activity category');
  const action = q.action || '';
  if (typeof action !== 'string' || action.length > 100 || (action && !/^[a-z_]+\.[a-z_]+$/.test(action))) throw fail('Invalid action');
  const search = q.search || '';
  if (typeof search !== 'string' || search.length > 120) throw fail('Search must be at most 120 characters');
  const offset = Number(q.offset || 0), limit = Number(q.limit || 30);
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw fail('Invalid activity page');
  return {from,through,employee,category,action,search:search.trim(),offset,limit};
}

// Only known display fields leave this endpoint; arbitrary audit metadata never does.
const SOURCE = `WITH events AS (
 SELECT 'audit:'||a.id::text AS id, a.created_at, a.action, a.actor_id,
  COALESCE(u.full_name, CASE WHEN a.actor_id IS NULL THEN 'System' ELSE 'Former user' END) AS actor_name,
  a.entity_type, a.entity_id, COALESCE(l.id, cl.id, tl.id) AS lead_id,
  COALESCE(a.metadata->>'businessName', l.business_name, cl.business_name, ca.customer->>'name', tl.business_name, a.metadata->>'taskTitle', t.title, subject.full_name) AS record_label,
  a.metadata->>'from' AS from_value, a.metadata->>'to' AS to_value,
  COALESCE(a.metadata->>'taskTitle',t.title) AS task_title,
  CASE WHEN a.action='payment.recorded' AND (a.metadata->>'amount') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (a.metadata->>'amount')::numeric ELSE NULL END AS amount,
  CASE WHEN a.action LIKE 'payment.%' THEN COALESCE(a.metadata->>'currency',ca.currency) END AS currency
 FROM activity_logs a
 LEFT JOIN users u ON u.id=a.actor_id
 LEFT JOIN leads l ON a.entity_type='lead' AND l.id=a.entity_id
 LEFT JOIN crm_tasks t ON a.entity_type='task' AND t.id=a.entity_id
 LEFT JOIN leads tl ON tl.id=t.lead_id
 LEFT JOIN collection_accounts ca ON ca.id::text=a.metadata->>'accountId'
 LEFT JOIN leads cl ON cl.id=ca.lead_id
 LEFT JOIN users subject ON a.entity_type='user' AND subject.id=a.entity_id
 WHERE a.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Kolkata')
  AND a.created_at < (($2::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata')
  AND a.action <> 'location.ping'
  AND ($3::uuid IS NULL OR a.actor_id=$3)
 UNION ALL
 SELECT 'quotation:'||e.id::text,e.created_at,'quotation.'||e.action,e.actor_id,
  COALESCE(u.full_name,CASE WHEN e.actor_id IS NULL THEN 'System' ELSE 'Former user' END),
  'quotation',q.id,l.id,COALESCE(r.snapshot->'customer'->>'name',l.business_name,q.number::text),
  NULL,NULL,NULL,
  CASE WHEN (r.snapshot->>'totalMinor') ~ '^[0-9]+$' THEN (r.snapshot->>'totalMinor')::numeric/100 END,
  r.snapshot->>'currency'
 FROM quotation_events e JOIN quotations q ON q.id=e.quote_id
 LEFT JOIN quotation_revisions r ON r.quote_id=e.quote_id AND r.revision=e.revision
 LEFT JOIN leads l ON l.id=q.lead_id LEFT JOIN users u ON u.id=e.actor_id
 WHERE e.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Kolkata')
  AND e.created_at < (($2::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata')
  AND ($3::uuid IS NULL OR e.actor_id=$3)
 UNION ALL
 -- Older payments may have no audit event. Avoid double-counting modern payments.
 SELECT 'payment:'||p.id::text,p.paid_at,'payment.recorded',p.recorded_by,
  COALESCE(u.full_name,'Former user'),'payment',p.id,l.id,
  COALESCE(l.business_name,ca.customer->>'name'),NULL,NULL,NULL,p.amount,COALESCE(ca.currency,'INR')
 FROM lead_payments p LEFT JOIN collection_accounts ca ON ca.id=p.account_id
 LEFT JOIN leads l ON l.id=COALESCE(p.lead_id,ca.lead_id) LEFT JOIN users u ON u.id=p.recorded_by
 WHERE p.paid_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Kolkata')
  AND p.paid_at < (($2::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata')
  AND ($3::uuid IS NULL OR p.recorded_by=$3)
  AND NOT EXISTS (SELECT 1 FROM activity_logs a WHERE a.entity_type='payment' AND a.entity_id=p.id AND a.action='payment.recorded')
), categorized AS (
 SELECT *, CASE WHEN action LIKE 'payment.%' THEN 'payments'
 WHEN action LIKE 'lead.%' OR action LIKE 'quotation.%' OR action LIKE 'onboarding.%' THEN 'sales'
 WHEN action LIKE 'task.%' OR action LIKE 'attendance.%' OR action LIKE 'salesman.%' OR action LIKE 'message.%' THEN 'team'
 ELSE 'system' END AS category FROM events
), filtered AS (
 SELECT * FROM categorized WHERE ($4='all' OR category=$4) AND ($5='' OR action=$5)
 AND ($6='' OR strpos(lower(concat_ws(' ',actor_name,record_label,task_title,replace(action,'.',' '))),lower($6))>0)
)`;
function feedQuery(f) {
 return { text: `${SOURCE}
 SELECT
 (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.created_at DESC,p.id DESC),'[]'::jsonb) FROM
  (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT $7 OFFSET $8) p) AS activities,
 (SELECT jsonb_build_object('total',count(*),'leadsAdded',count(*) FILTER(WHERE action IN ('lead.created','lead.created_by_admin')),
 'statusChanges',count(*) FILTER(WHERE action='lead.status_changed'),
 'quotesSent',count(*) FILTER(WHERE action='quotation.sent'),
 'tasksCompleted',count(*) FILTER(WHERE action='task.completed')) FROM filtered) AS summary,
 (SELECT COALESCE(jsonb_agg(to_jsonb(m)),'[]'::jsonb) FROM
  (SELECT currency,sum(amount) AS amount FROM filtered WHERE action='payment.recorded' AND amount IS NOT NULL AND currency IS NOT NULL GROUP BY currency ORDER BY currency) m) AS payments`,
 values: [f.from,f.through,f.employee,f.category,f.action,f.search,f.limit,f.offset] };
}
module.exports = { parseFilters, feedQuery, UUID };
