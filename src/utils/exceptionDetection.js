const C = require('./collections');

const ACTIVE = new Set(['cold','conversation','hot','demo','negotiation','nurture']);
const slug = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'').slice(0,60);
const money = n => `₹${Number(n || 0).toLocaleString('en-IN',{maximumFractionDigits:0})}`;

function monthOnlyMatches(value, today) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const ym = today.slice(0,7);
  if (/^\d{4}-\d{2}(?:-\d{2})?$/.test(raw)) return raw.slice(0,7) === ym;
  const d = new Date(`${today}T12:00:00Z`);
  const long = new Intl.DateTimeFormat('en-US',{month:'long',timeZone:'UTC'}).format(d).toLowerCase();
  const short = new Intl.DateTimeFormat('en-US',{month:'short',timeZone:'UTC'}).format(d).toLowerCase();
  const lower = raw.toLowerCase();
  const yearMatch = lower.match(/\b(20\d{2})\b/);
  if (yearMatch && yearMatch[1] !== today.slice(0,4)) return false;
  return lower === long || lower === short || lower.includes(long) || lower.includes(short);
}

function makeCase(item) {
  return {
    ...item,
    fingerprint:`${item.type}:${item.entityType}:${item.entityId || item.entityName}:${slug(item.title)}`,
    metadata:{ status:item.status || null, value:item.value || 0, action:item.action || null, ...(item.metadata || {}) },
  };
}

function buildDetections({leads=[],tasks=[],collections=[],rules,today}) {
  const out=[];
  const add = item => out.push(makeCase(item));
  const addLead = (l,type,severity,title,reason,action='Open Lead',metadata={}) => add({
    type,severity,title,reason,action,entityType:'lead',entityId:l.id,entityName:l.business_name || 'Unnamed lead',
    owner:l.owner_name || 'Unassigned',status:l.status,value:Number(l.deal_value || 0),metadata,
  });

  for (const l of leads) {
    const status=String(l.status||'').toLowerCase();
    const age=Number(l.age_days||0);
    const followupOverdue=Number(l.followup_days_overdue||0);
    if (rules.followup_enabled && ACTIVE.has(status) && followupOverdue > 0) {
      addLead(l,'followup',followupOverdue>=3?'critical':'high','Follow-up overdue',`${followupOverdue} day${followupOverdue===1?'':'s'} overdue · scheduled ${l.next_follow_up_date}`);
    }
    if (rules.hot_enabled && status==='hot' && age>=Number(rules.hot_stale_days)) {
      addLead(l,'hot',age>=Number(rules.hot_critical_days)?'critical':'high','Hot lead going cold',`No recorded lead update for ${age} days`);
    }
    if (rules.negotiation_enabled && status==='negotiation' && age>=Number(rules.negotiation_stale_days)) {
      addLead(l,'negotiation',age>=Number(rules.negotiation_critical_days)?'critical':'high','Negotiation stalled',`No recorded lead update for ${age} days`);
    }
    if (rules.data_quality_enabled) {
      if (ACTIVE.has(status) && !l.phone) addLead(l,'data','medium','Contact number missing','Sales team cannot reliably follow up without a contact number');
      if (['conversation','hot','demo','negotiation'].includes(status) && !l.next_follow_up_date) addLead(l,'data',['hot','negotiation'].includes(status)?'high':'medium','Next follow-up not set',`${status.charAt(0).toUpperCase()+status.slice(1)} lead has no next follow-up date`);
      if (status==='negotiation' && Number(l.deal_value||0)<=0) addLead(l,'data','medium','Deal value missing','Negotiation is active but expected deal value is not recorded');
    }
    if (rules.renewal_enabled && ACTIVE.has(status)) {
      const renewalDays=Number(l.renewal_days_until);
      if (l.renewal_date && Number.isFinite(renewalDays)) {
        if (renewalDays < 0) addLead(l,'renewal','critical','Renewal overdue',`Renewal date passed ${Math.abs(renewalDays)} day${Math.abs(renewalDays)===1?'':'s'} ago`);
        else if (renewalDays <= Number(rules.renewal_warning_days)) addLead(l,'renewal',renewalDays<=2?'high':'medium','Renewal approaching',`Renewal due in ${renewalDays} day${renewalDays===1?'':'s'}`);
      } else if (!l.renewal_date && monthOnlyMatches(l.renewal_month,today)) {
        addLead(l,'renewal','medium','Renewal expected this month','Renewal is expected this month; an exact renewal date has not been set','Open Lead',{monthOnly:true,renewalMonth:l.renewal_month});
      }
    }
  }

  if (rules.tasks_enabled) for (const t of tasks) {
    const days=Number(t.days_overdue||0);
    if (String(t.status||'').toLowerCase()!=='completed' && days>0) add({
      type:'task',severity:days>=3?'high':'medium',title:'Task overdue',reason:`${days} day${days===1?'':'s'} overdue`,action:'Open Tasks',
      entityType:'task',entityId:t.id,entityName:t.title||'Task',owner:t.owner_name||'Team',
    });
  }

  if (rules.payments_enabled) for (const c of collections) {
    const outstanding=Number(c.pending||0),days=Number(c.days_overdue||0);
    if (outstanding>0 && days>0) add({
      type:'payment',severity:days>=7?'critical':'high',title:'Payment overdue',reason:`${money(outstanding)} outstanding · ${days} day${days===1?'':'s'} overdue`,action:'Open Collections',
      entityType:'payment',entityId:c.key,entityName:c.customer_name||'Customer',owner:c.owner_name||'Team',value:outstanding,
      metadata:{collectionKey:c.key,leadId:c.lead_id||null},
    });
  }
  return out;
}

async function loadDetectionSources(query) {
  const settingsResult = await query('SELECT * FROM exception_settings WHERE id=1');
  if (!settingsResult.rows[0]) throw new Error('Exception settings are not configured.');
  const rules=settingsResult.rows[0];
  const todayResult=await query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS today");
  const today=todayResult.rows[0].today;
  const [leadResult,taskResult,collectionResult]=await Promise.all([
    query(`SELECT l.id,l.business_name,l.status::text,l.phone,l.next_follow_up_date::text,l.renewal_date::text,l.renewal_month,l.deal_value,u.full_name AS owner_name,
      GREATEST(0,((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date-(l.updated_at AT TIME ZONE 'Asia/Kolkata')::date))::int AS age_days,
      CASE WHEN l.next_follow_up_date IS NULL THEN 0 ELSE ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date-l.next_follow_up_date)::int END AS followup_days_overdue,
      CASE WHEN l.renewal_date IS NULL THEN NULL ELSE (l.renewal_date-(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date)::int END AS renewal_days_until
      FROM leads l LEFT JOIN users u ON u.id=l.salesman_id`),
    query(`SELECT t.id,t.title,t.status,u.full_name AS owner_name,
      ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date-(t.due_at AT TIME ZONE 'Asia/Kolkata')::date)::int AS days_overdue
      FROM crm_tasks t LEFT JOIN users u ON u.id=t.assigned_to WHERE t.status IN ('pending','in_progress')`),
    query(`WITH accounts AS (${C.source}), totals AS (
      SELECT c.key,c.lead_id,c.customer->>'name' AS customer_name,c.assigned_to,u.full_name AS owner_name,c.total,c.due_date,
      GREATEST(c.total-COALESCE(p.paid,0),0) AS pending,
      CASE WHEN c.due_date IS NULL THEN 0 ELSE ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date-c.due_date)::int END AS days_overdue
      FROM accounts c LEFT JOIN users u ON u.id=c.assigned_to LEFT JOIN LATERAL(
        SELECT COALESCE(sum(amount),0) AS paid FROM lead_payments WHERE account_id=c.id OR lead_id=c.lead_id
      ) p ON true)
      SELECT * FROM totals WHERE pending>0 AND due_date IS NOT NULL`),
  ]);
  return {rules,today,leads:leadResult.rows,tasks:taskResult.rows,collections:collectionResult.rows};
}

module.exports={ACTIVE,monthOnlyMatches,buildDetections,loadDetectionSources};
