// Fixed, read-only CRM reporting queries for Ask Engage. No user-provided SQL.
const ACTIVE_TASKS = "t.status IN ('pending','in_progress')";
const IST_TODAY = "(now() AT TIME ZONE 'Asia/Kolkata')::date";
const summaries = {
  lead_summary: "lead records",
  lead_pipeline: "pipeline records",
  employee_leaderboard: "employee lead ranking",
  won_deals: "Won deals",
  conversion_summary: "deal conversion summary",
  won_deal_value: "Won deal value",
  followups_due: "follow-ups due",
  task_summary: "tasks",
  overdue_tasks: "overdue tasks",
  attendance_summary: "attendance sessions",
  quotation_summary: "quotations",
  visit_summary: "recorded visits",
  message_summary: "messages"
};
function result(metric, period, count, items, note = "") {
  const breakdown = items.length ? " Breakdown: " + items.map(row => row.name + ": " + row.count).join("; ") + "." : "";
  return { metric, count, items: [], totals: [],
    answer: count + " " + summaries[metric] + " (" + period.replace(/_/g, " ") + ")." + breakdown,
    note };
}
function toCount(row) { return Number(row?.count || 0); }
function asCounts(rows, key) {
  return rows.map(row => ({ name: String(row[key] ?? "Unknown"),
    count: toCount(row) }));
}
async function answerExtra(plan, employee, query, dateFilter) {
  const id = employee?.id || null;
  const args = [id];
  const when = (column, timestamp = true) => dateFilter(plan.period,column,timestamp);
  const who = "($1::uuid IS NULL OR ";
  switch (plan.intent) {
    case "lead_summary": {
      const sql = "SELECT count(*)::int AS count FROM leads l WHERE " +
        who + "l.salesman_id=$1) AND " + when("l.created_at");
      const {rows} = await query(sql,args);
      return result(plan.intent,plan.period,toCount(rows[0]),[],
        "Counts existing deals by creation date and current owner. Includes all stages.");
    }
    case "won_deals": {
      const {rows}=await query("SELECT count(*)::int AS count FROM leads l WHERE " +
        who+"l.salesman_id=$1) AND l.status='won' AND "+when("l.created_at"),args);
      return result(plan.intent,plan.period,toCount(rows[0]),[],
        "Current Won stage, filtered by original deal creation date, not conversion date.");
    }
    case "conversion_summary": {
      const {rows}=await query("SELECT count(*)::int AS count, " +
        "count(*) FILTER (WHERE l.status='won')::int AS won " +
        "FROM leads l WHERE "+who+"l.salesman_id=$1) AND "+when("l.created_at"),args);
      const total=toCount(rows[0]), won=Number(rows[0]?.won||0);
      const rate=total?Math.round(won/total*10000)/100:0;
      return { ...result(plan.intent,plan.period,total,[],
          "Current Won deals divided by currently assigned deals created in this period, not a cohort conversion audit."),
        answer: "Deal conversion ("+plan.period.replace(/_/g," ")+"): "+won+" Won out of "+total+
          " deals ("+rate+"%)." };
    }
    case "won_deal_value": {
      const {rows}=await query("SELECT count(*)::int AS count, " +
        "coalesce(sum(l.deal_value),0)::numeric AS total " +
        "FROM leads l WHERE "+who+"l.salesman_id=$1) AND l.status='won' AND "+when("l.created_at"),args);
      return { ...result(plan.intent,plan.period,toCount(rows[0]),[],
          "Sum of the deal_value field for current Won deals. Currency is unspecified, so no currency conversion is assumed."),
        answer: toCount(rows[0])+" Won deals with combined recorded deal value "+Number(rows[0]?.total||0).toLocaleString("en-IN")+
          " (currency not specified; filtered by deal creation date)." };
    }
    case "lead_pipeline": {
      const {rows} = await query("SELECT l.status::text AS stage, count(*)::int AS count FROM leads l WHERE " +
        who + "l.salesman_id=$1) AND " + when("l.created_at") +
        " GROUP BY l.status ORDER BY count DESC,l.status LIMIT 30", args);
      const count = rows.reduce((n,r)=>n+toCount(r),0);
      return result(plan.intent,plan.period,count,asCounts(rows,"stage"),
        "Stage breakdown based on current stage, filtered by deal creation date.");
    }
    case "employee_leaderboard": {
      if (employee) throw Object.assign(new Error("Employee ranking compares all employees; omit the individual employee filter."),{status:422});
      const {rows} = await query(
        "SELECT u.full_name AS name, count(l.id)::int AS count, " +
        "count(l.id) FILTER (WHERE l.status='won')::int AS won " +
        "FROM users u LEFT JOIN leads l ON l.salesman_id=u.id AND " + when("l.created_at") +
        " WHERE u.role='salesman' AND u.is_active=true GROUP BY u.id,u.full_name " +
        "ORDER BY count DESC,u.full_name LIMIT 20",[]);
      const standings = rows.map(r => r.name + ": " + toCount(r) + " assigned (" + Number(r.won||0) + " Won)");
      return { ...result(plan.intent,plan.period,rows.reduce((n,r)=>n+toCount(r),0),[],
        "Ranked by currently assigned deals created in this period; Won uses current stage." ),
        answer:"Top employees by currently assigned deals ("+plan.period.replace(/_/g," ")+"): " + (standings.join("; ") || "No active employees") + "." };
    }
    case "followups_due": {
      // next_follow_up_date is a lead field used throughout CRM.
      const {rows}=await query("SELECT count(*)::int AS count FROM leads l WHERE " +
        who+"l.salesman_id=$1) AND l.next_follow_up_date IS NOT NULL AND " +
        when("l.next_follow_up_date",false),args);
      return result(plan.intent,plan.period,toCount(rows[0]),[],
        "Follow-up dates scheduled in the selected period. This does not imply task completion.");
    }
    case "task_summary":
    case "overdue_tasks": {
      const state = plan.intent==="overdue_tasks" ? " AND "+ACTIVE_TASKS+" AND t.due_at<now()" : "";
      const {rows}=await query("SELECT t.status, count(*)::int AS count FROM crm_tasks t WHERE "+
        who+"t.assigned_to=$1) AND "+when("t.due_at")+state+
        " GROUP BY t.status ORDER BY count DESC LIMIT 10",args);
      return result(plan.intent,plan.period,rows.reduce((n,r)=>n+toCount(r),0),
        asCounts(rows,"status"),
        "Based on task due dates. Overdue excludes completed tasks.");
    }
    case "attendance_summary": {
      const {rows}=await query("SELECT count(*)::int AS count, "+
        "count(*) FILTER (WHERE a.start_day_at IS NOT NULL)::int AS started, "+
        "count(*) FILTER (WHERE a.end_day_at IS NOT NULL)::int AS ended "+
        "FROM attendance a WHERE "+who+"a.salesman_id=$1) AND "+when("a.day",false),args);
      return { ...result(plan.intent,plan.period,toCount(rows[0]),[],
        "Recorded attendance sessions only; this is not an absence or payroll calculation."),
        answer: toCount(rows[0]) + " attendance sessions (" + plan.period.replace(/_/g," ") + "); started: " + Number(rows[0]?.started||0) + "; ended: " + Number(rows[0]?.ended||0) + "." };
    }
    case "quotation_summary": {
      const {rows}=await query("SELECT qr.status,count(*)::int AS count "+
        "FROM quotations q JOIN quotation_revisions qr ON qr.quote_id=q.id AND qr.revision=q.current_revision "+
        "WHERE "+who+"q.owner_id=$1) AND "+when("q.created_at")+
        " GROUP BY qr.status ORDER BY count DESC LIMIT 10",args);
      return result(plan.intent,plan.period,rows.reduce((n,r)=>n+toCount(r),0),
        asCounts(rows,"status"),"Latest quotation revision only; filtered by quotation creation date.");
    }
    case "visit_summary": {
      const {rows}=await query("SELECT count(*)::int AS count FROM visits v WHERE "+
        who+"v.salesman_id=$1) AND "+when("v.arrived_at"),args);
      return result(plan.intent,plan.period,toCount(rows[0]),[],
        "Recorded visits by arrival date; not inferred from GPS pings.");
    }
    case "message_summary": {
      const {rows}=await query("SELECT count(*)::int AS count FROM messages m WHERE "+
        who+"(m.sender_id=$1 OR m.recipient_id=$1)) AND "+when("m.created_at"),args);
      return result(plan.intent,plan.period,toCount(rows[0]),[],
        "Message count only; private message bodies are never supplied to Gemini.");
    }
    default: return null;
  }
}
module.exports = { answerExtra, summaries };
