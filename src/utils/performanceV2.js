const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function validDay(value) {
  if (!DAY_RE.test(value || '')) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function validateRange(from, to, salesmanId) {
  if (!validDay(from) || !validDay(to)) throw fail('Choose a valid from and to date.');
  if (from > to) throw fail('From date must be before through date.');
  const days = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > 366) throw fail('Performance reports are limited to 366 days per request.');
  if (salesmanId && !UUID.test(salesmanId)) throw fail('Invalid employee.');
  return { from, to, salesmanId: salesmanId || null, days };
}

function workingDays(from, to) {
  let count = 0;
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

function num(v) { return Number(v || 0); }
function pct(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 : 0; }

async function getPerformanceReport(query, input) {
  const { from, to, salesmanId } = validateRange(input.from, input.to, input.salesmanId);

  const { rows } = await query(`
    WITH bounds AS (
      SELECT $1::date AS from_day,
             $2::date AS to_day,
             LEAST($2::date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date) AS effective_to
    ), people AS (
      SELECT id, full_name
      FROM users
      WHERE role='salesman' AND ($3::uuid IS NULL OR id=$3)
        AND (is_active OR $3::uuid=id)
    ), creation_owner AS (
      SELECT DISTINCT ON (h.lead_id) h.lead_id, h.salesman_id
      FROM lead_owner_history h
      ORDER BY h.lead_id, h.assigned_at, h.id
    ), lead_activity AS (
      SELECT co.salesman_id,
             count(*) FILTER (WHERE (l.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN b.from_day AND b.to_day)::int AS leads_added
      FROM leads l
      JOIN creation_owner co ON co.lead_id=l.id
      CROSS JOIN bounds b
      GROUP BY co.salesman_id
    ), milestone_activity AS (
      SELECT m.salesman_id,
        count(*) FILTER (WHERE m.stage='demo')::int AS demos_reached,
        count(*) FILTER (WHERE m.stage='negotiation')::int AS negotiations_reached,
        count(*) FILTER (WHERE m.stage='won')::int AS won,
        count(*) FILTER (WHERE m.stage='lost')::int AS lost,
        coalesce(sum(m.deal_value_snapshot) FILTER (WHERE m.stage='won'),0)::numeric AS sales_value
      FROM lead_stage_milestones m CROSS JOIN bounds b
      WHERE (m.occurred_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN b.from_day AND b.to_day
      GROUP BY m.salesman_id
    ), cohort AS (
      SELECT co.salesman_id,
        count(*)::int AS cohort_leads,
        count(*) FILTER (WHERE dm.id IS NOT NULL)::int AS cohort_demo,
        count(*) FILTER (WHERE nm.id IS NOT NULL)::int AS cohort_negotiation,
        count(*) FILTER (WHERE wm.id IS NOT NULL)::int AS cohort_won
      FROM leads l
      JOIN creation_owner co ON co.lead_id=l.id
      CROSS JOIN bounds b
      LEFT JOIN lead_stage_milestones dm ON dm.lead_id=l.id AND dm.stage='demo'
        AND (dm.occurred_at AT TIME ZONE 'Asia/Kolkata')::date <= b.to_day
      LEFT JOIN lead_stage_milestones nm ON nm.lead_id=l.id AND nm.stage='negotiation'
        AND (nm.occurred_at AT TIME ZONE 'Asia/Kolkata')::date <= b.to_day
      LEFT JOIN lead_stage_milestones wm ON wm.lead_id=l.id AND wm.stage='won'
        AND (wm.occurred_at AT TIME ZONE 'Asia/Kolkata')::date <= b.to_day
      WHERE (l.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN b.from_day AND b.to_day
      GROUP BY co.salesman_id
    ), followup_completed AS (
      SELECT f.salesman_id, count(*)::int AS completed
      FROM lead_followup_events f CROSS JOIN bounds b
      WHERE f.event_type='completed'
        AND (f.occurred_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN b.from_day AND b.to_day
      GROUP BY f.salesman_id
    ), followup_due AS (
      SELECT e.salesman_id, count(*)::int AS due
      FROM lead_followup_events e CROSS JOIN bounds b
      WHERE e.event_type IN ('scheduled','rescheduled')
        AND e.due_to BETWEEN b.from_day AND b.to_day
        AND NOT EXISTS (
          SELECT 1 FROM lead_followup_events x
          WHERE x.lead_id=e.lead_id AND x.event_type='rescheduled'
            AND x.due_from=e.due_to AND x.occurred_at>e.occurred_at
            AND (x.occurred_at AT TIME ZONE 'Asia/Kolkata')::date <= e.due_to
        )
      GROUP BY e.salesman_id
    ), latest_followup AS (
      SELECT DISTINCT ON (f.lead_id) f.lead_id, f.salesman_id, f.event_type, f.due_to
      FROM lead_followup_events f CROSS JOIN bounds b
      WHERE (f.occurred_at AT TIME ZONE 'Asia/Kolkata')::date <= b.effective_to
      ORDER BY f.lead_id, f.occurred_at DESC, f.id DESC
    ), followup_overdue AS (
      SELECT lf.salesman_id, count(*)::int AS overdue
      FROM latest_followup lf CROSS JOIN bounds b
      WHERE lf.event_type IN ('scheduled','rescheduled') AND lf.due_to < b.effective_to
      GROUP BY lf.salesman_id
    ), task_completed AS (
      SELECT t.assigned_to salesman_id,
             count(*) FILTER (WHERE t.completed_at IS NOT NULL AND (t.completed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN b.from_day AND b.to_day)::int AS completed
      FROM crm_tasks t CROSS JOIN bounds b GROUP BY t.assigned_to
    ), task_asof AS (
      SELECT t.id, t.assigned_to,
        COALESCE((
          SELECT NULLIF(e.old_value,'')::timestamptz
          FROM task_events e CROSS JOIN bounds bx
          WHERE e.task_id=t.id AND e.action='rescheduled'
            AND (e.created_at AT TIME ZONE 'Asia/Kolkata')::date > bx.effective_to
          ORDER BY e.created_at ASC, e.id ASC LIMIT 1
        ), t.due_at) AS due_asof,
        t.completed_at
      FROM crm_tasks t
    ), task_overdue AS (
      SELECT ta.assigned_to salesman_id, count(*)::int AS overdue
      FROM task_asof ta CROSS JOIN bounds b
      WHERE (ta.due_asof AT TIME ZONE 'Asia/Kolkata')::date < b.effective_to
        AND (ta.completed_at IS NULL OR (ta.completed_at AT TIME ZONE 'Asia/Kolkata')::date > b.effective_to)
      GROUP BY ta.assigned_to
    ), attendance_stats AS (
      SELECT a.salesman_id, count(DISTINCT a.day)::int AS active_days
      FROM attendance a CROSS JOIN bounds b
      WHERE a.start_day_at IS NOT NULL AND a.day BETWEEN b.from_day AND b.effective_to
      GROUP BY a.salesman_id
    ), closing_stats AS (
      SELECT r.user_id salesman_id, count(DISTINCT r.day)::int AS closing_days
      FROM day_closing_reports r CROSS JOIN bounds b
      WHERE r.status<>'draft' AND r.day BETWEEN b.from_day AND b.effective_to
      GROUP BY r.user_id
    ), visit_stats AS (
      SELECT v.salesman_id, count(*)::int AS visits
      FROM visits v CROSS JOIN bounds b
      WHERE (v.arrived_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN b.from_day AND b.to_day
      GROUP BY v.salesman_id
    ), collection_stats AS (
      SELECT oh.salesman_id, coalesce(sum(p.amount),0)::numeric AS collected
      FROM lead_payments p
      CROSS JOIN bounds b
      JOIN LATERAL (
        SELECT h.salesman_id
        FROM lead_owner_history h
        WHERE h.lead_id=p.lead_id AND h.assigned_at<=p.paid_at
          AND (h.unassigned_at IS NULL OR p.paid_at<h.unassigned_at)
        ORDER BY h.assigned_at DESC, h.id DESC LIMIT 1
      ) oh ON true
      WHERE (p.paid_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN b.from_day AND b.to_day
      GROUP BY oh.salesman_id
    ), outstanding_stats AS (
      SELECT l.salesman_id,
        coalesce(sum(greatest(coalesce(ca.total,l.deal_value,0)-coalesce(pp.paid,0),0)),0)::numeric AS outstanding
      FROM leads l
      LEFT JOIN collection_accounts ca ON ca.lead_id=l.id
      LEFT JOIN (SELECT lead_id,sum(amount) paid FROM lead_payments GROUP BY lead_id) pp ON pp.lead_id=l.id
      WHERE l.status='won'
      GROUP BY l.salesman_id
    )
    SELECT p.id, p.full_name,
      coalesce(la.leads_added,0) leads_added,
      coalesce(ma.demos_reached,0) demos_reached,
      coalesce(ma.negotiations_reached,0) negotiations_reached,
      coalesce(ma.won,0) won,
      coalesce(ma.lost,0) lost,
      coalesce(ma.sales_value,0) sales_value,
      coalesce(c.cohort_leads,0) cohort_leads,
      coalesce(c.cohort_demo,0) cohort_demo,
      coalesce(c.cohort_negotiation,0) cohort_negotiation,
      coalesce(c.cohort_won,0) cohort_won,
      coalesce(fc.completed,0) followups_completed,
      coalesce(fd.due,0) followups_due,
      coalesce(fo.overdue,0) overdue_followups,
      coalesce(tc.completed,0) tasks_completed,
      coalesce(tod.overdue,0) tasks_overdue,
      coalesce(att.active_days,0) active_days,
      coalesce(cl.closing_days,0) closing_days,
      coalesce(vs.visits,0) visits,
      coalesce(cs.collected,0) collected,
      coalesce(os.outstanding,0) outstanding,
      b.effective_to
    FROM people p CROSS JOIN bounds b
    LEFT JOIN lead_activity la ON la.salesman_id=p.id
    LEFT JOIN milestone_activity ma ON ma.salesman_id=p.id
    LEFT JOIN cohort c ON c.salesman_id=p.id
    LEFT JOIN followup_completed fc ON fc.salesman_id=p.id
    LEFT JOIN followup_due fd ON fd.salesman_id=p.id
    LEFT JOIN followup_overdue fo ON fo.salesman_id=p.id
    LEFT JOIN task_completed tc ON tc.salesman_id=p.id
    LEFT JOIN task_overdue tod ON tod.salesman_id=p.id
    LEFT JOIN attendance_stats att ON att.salesman_id=p.id
    LEFT JOIN closing_stats cl ON cl.salesman_id=p.id
    LEFT JOIN visit_stats vs ON vs.salesman_id=p.id
    LEFT JOIN collection_stats cs ON cs.salesman_id=p.id
    LEFT JOIN outstanding_stats os ON os.salesman_id=p.id
    ORDER BY p.full_name
  `, [from, to, salesmanId]);

  const effectiveTo = rows[0] ? String(rows[0].effective_to).slice(0, 10) : to;
  const workDays = effectiveTo >= from ? workingDays(from, effectiveTo) : 0;

  const employees = rows.map(r => {
    const leads = num(r.leads_added), demos = num(r.demos_reached), won = num(r.won), sales = num(r.sales_value);
    const cohortLeads = num(r.cohort_leads), cohortDemo = num(r.cohort_demo), cohortNeg = num(r.cohort_negotiation), cohortWon = num(r.cohort_won);
    const active = num(r.active_days);
    return {
      id: r.id,
      name: r.full_name,
      activity: {
        leadsAdded: leads,
        visits: num(r.visits),
        followUpsCompleted: num(r.followups_completed),
        followUpsDue: num(r.followups_due),
        overdueFollowUps: num(r.overdue_followups),
        demosReached: demos,
        negotiationsReached: num(r.negotiations_reached),
        tasksCompleted: num(r.tasks_completed),
        tasksOverdue: num(r.tasks_overdue),
        activeDays: active,
        workingDays: workDays,
        dayClosingSubmitted: num(r.closing_days),
      },
      results: {
        won,
        lost: num(r.lost),
        salesValue: sales,
        collected: num(r.collected),
        currentOutstanding: num(r.outstanding),
        averageWonDealValue: won ? Math.round(sales / won) : 0,
      },
      conversion: {
        cohortLeads,
        cohortDemo,
        cohortNegotiation: cohortNeg,
        cohortWon,
        leadToDemoPct: pct(cohortDemo, cohortLeads),
        leadToNegotiationPct: pct(cohortNeg, cohortLeads),
        leadToWonPct: pct(cohortWon, cohortLeads),
        demoToWonPct: pct(cohortWon, cohortDemo),
      },
      averages: {
        leadsPerActiveDay: active ? Math.round((leads / active) * 10) / 10 : 0,
        followUpsPerActiveDay: active ? Math.round((num(r.followups_completed) / active) * 10) / 10 : 0,
      },
    };
  });

  const totals = employees.reduce((a, e) => {
    for (const [k,v] of Object.entries(e.activity)) if (k !== 'workingDays') a.activity[k] = (a.activity[k] || 0) + num(v);
    for (const [k,v] of Object.entries(e.results)) if (k !== 'averageWonDealValue') a.results[k] = (a.results[k] || 0) + num(v);
    a.conversion.cohortLeads += e.conversion.cohortLeads;
    a.conversion.cohortDemo += e.conversion.cohortDemo;
    a.conversion.cohortNegotiation += e.conversion.cohortNegotiation;
    a.conversion.cohortWon += e.conversion.cohortWon;
    return a;
  }, { activity: { workingDays: workDays }, results: {}, conversion: { cohortLeads:0, cohortDemo:0, cohortNegotiation:0, cohortWon:0 } });

  totals.results.averageWonDealValue = totals.results.won ? Math.round(totals.results.salesValue / totals.results.won) : 0;
  totals.conversion.leadToDemoPct = pct(totals.conversion.cohortDemo, totals.conversion.cohortLeads);
  totals.conversion.leadToNegotiationPct = pct(totals.conversion.cohortNegotiation, totals.conversion.cohortLeads);
  totals.conversion.leadToWonPct = pct(totals.conversion.cohortWon, totals.conversion.cohortLeads);
  totals.conversion.demoToWonPct = pct(totals.conversion.cohortWon, totals.conversion.cohortDemo);

  return {
    version: 2,
    range: { from, to, effectiveTo, timezone: 'Asia/Kolkata' },
    definitions: {
      won: 'Unique lead first reaching Won in the selected range. A Won→Lost→Won cycle is not counted twice.',
      salesValue: 'Deal value snapshotted when the lead first reached Won; later edits do not change historical sales value.',
      ownership: 'Performance is credited to the salesman assigned when the immutable milestone/event was recorded.',
      conversion: 'Cohort conversion uses only leads created in the selected range and milestones reached by the range end.',
      overdue: 'Overdue means strictly before the effective report end date; items due on that date are not overdue.',
      currentOutstanding: 'Current outstanding balance is a present-state metric, not a historical snapshot.',
    },
    totals,
    employees,
  };
}

async function getDataHealth(query) {
  const { rows } = await query(`
    SELECT
      (SELECT count(*)::int FROM leads l WHERE l.status='won' AND NOT EXISTS (
        SELECT 1 FROM lead_stage_milestones m WHERE m.lead_id=l.id AND m.stage='won')) AS won_missing_snapshot,
      (SELECT count(*)::int FROM leads l WHERE NOT EXISTS (
        SELECT 1 FROM lead_owner_history h WHERE h.lead_id=l.id AND h.unassigned_at IS NULL)) AS leads_missing_current_owner_history,
      (SELECT count(*)::int FROM lead_stage_milestones WHERE source='backfill_current_owner') AS legacy_stage_snapshots,
      (SELECT count(*)::int FROM lead_owner_history WHERE source='backfill_current_owner') AS legacy_owner_rows,
      (SELECT count(*)::int FROM leads l WHERE l.next_follow_up_date IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM lead_followup_events f WHERE f.lead_id=l.id)) AS followups_missing_ledger,
      (SELECT count(*)::int FROM lead_stage_milestones m WHERE m.stage='won' AND m.deal_value_snapshot IS NULL) AS won_without_value
  `);
  const r = rows[0] || {};
  const blocking = num(r.won_missing_snapshot) + num(r.leads_missing_current_owner_history) + num(r.followups_missing_ledger);
  return {
    healthy: blocking === 0,
    blockingIssues: blocking,
    checks: {
      wonMissingSnapshot: num(r.won_missing_snapshot),
      leadsMissingCurrentOwnerHistory: num(r.leads_missing_current_owner_history),
      followUpsMissingLedger: num(r.followups_missing_ledger),
      wonWithoutValue: num(r.won_without_value),
      legacyStageSnapshots: num(r.legacy_stage_snapshots),
      legacyOwnerRows: num(r.legacy_owner_rows),
    },
    note: 'Legacy backfilled rows are marked because old ownership/value-at-event cannot be reconstructed perfectly. New events are captured immutably by database triggers.',
  };
}

module.exports = { getPerformanceReport, getDataHealth, validateRange };
