// Fixed, read-only CRM reporting queries for Ask Engage. No user-provided SQL.
const ACTIVE_TASKS = "t.status IN ('pending','in_progress')";
const IST_TODAY = "(now() AT TIME ZONE 'Asia/Kolkata')::date";
const summaries = {
  lead_summary: "lead records",
  lead_pipeline: "pipeline records",
  employee_leaderboard: "employee lead ranking",
  employee_performance: "employee performance summary",
  won_deals: "Won deals",
  conversion_summary: "deal conversion summary",
  won_deal_value: "Won deal value",
  negotiation_summary: "Negotiation deal summary",
  average_deal_value: "Average recorded deal value",
  stale_deals: "Stale active deals",
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
    case "negotiation_summary": {
      const {rows}=await query(
        "SELECT count(*)::int AS count, count(l.deal_value)::int AS valued_count, "+
        "coalesce(sum(l.deal_value),0)::numeric AS total, avg(l.deal_value)::numeric AS average "+
        "FROM leads l WHERE "+who+"l.salesman_id=$1) AND l.status='negotiation' AND "+when("l.created_at"),args);
      const r=rows[0]||{}, count=toCount(r), valued=Number(r.valued_count||0);
      const total=Number(r.total||0);
      const average=r.average==null?null:Number(r.average);
      return {
        ...result(plan.intent,plan.period,count,[],
          "Only current Negotiation-stage deals. Values are summed and averaged only where deal_value is recorded; currency is not specified. Period refers to deal creation date."),
        answer:"There are "+count+" deals in Negotiation ("+plan.period.replace(/_/g," ")+
          "). Their recorded deal value totals "+total.toLocaleString("en-IN")+
          " across "+valued+" valued deals. "+(average==null?"No average is available because no deal values are recorded.":
            "Average recorded negotiation deal value is "+average.toLocaleString("en-IN",{maximumFractionDigits:2})+".")+
          (count>valued?" "+(count-valued)+" deals have no recorded value.":"")+
          " Currency is not specified.",
        value:total, average, valuedCount:valued
      };
    }
    case "average_deal_value": {
      const {rows}=await query(
        "SELECT count(*)::int AS count, count(l.deal_value)::int AS valued_count, "+
        "coalesce(sum(l.deal_value),0)::numeric AS total, avg(l.deal_value)::numeric AS average "+
        "FROM leads l WHERE "+who+"l.salesman_id=$1) AND "+when("l.created_at"),args);
      const r=rows[0]||{}, count=toCount(r), valued=Number(r.valued_count||0);
      const average=r.average==null?null:Number(r.average);
      return {
        ...result(plan.intent,plan.period,count,[],
          "Average uses the deal_value field on existing deals in any stage with a recorded value; missing values are excluded, while recorded zero values are included. No currency is assumed."),
        answer: average==null
          ? "There is no average deal value to calculate: none of the "+count+" deals has a recorded deal value."
          : "The average recorded deal value is "+average.toLocaleString("en-IN",{maximumFractionDigits:2})+
            " across "+valued+" valued deals ("+plan.period.replace(/_/g," ")+"). "+
            "All "+count+" deals were considered; "+(count-valued)+" have no recorded value. "+
            "Combined recorded deal value: "+Number(r.total||0).toLocaleString("en-IN")+
            ". Currency is not specified.",
        average, valuedCount:valued, value:Number(r.total||0)
      };
    }
    case "stale_deals": {
      // Match Exception Centre's stage-specific, enabled warning thresholds and updated_at age calculation.
      const settings=await query(
        "SELECT cold_enabled,cold_stale_days,conversation_enabled,conversation_stale_days,"+
        "hot_enabled,hot_stale_days,negotiation_enabled,negotiation_stale_days "+
        "FROM exception_settings WHERE id=1");
      const rules=settings.rows[0];
      if(!rules)throw new Error("Stale-deal rules are not configured.");
      const stages=["cold","conversation","hot","negotiation"];
      const enabled=stages.filter(stage=>rules[stage+"_enabled"]===true);
      if(!enabled.length){
        return {...result(plan.intent,plan.period,0,[],
          "All tracked stale-deal detection rules are disabled in Exception Centre."),
          answer:"There are no active stale-deal detection rules enabled in Exception Centre; no stale count can be reported."};
      }
      const {rows}=await query(
        "WITH stale AS (SELECT l.id,l.business_name,l.status::text AS stage,l.deal_value,"+
        "GREATEST(0,(("+IST_TODAY+")-(l.updated_at AT TIME ZONE 'Asia/Kolkata')::date))::int AS days_idle "+
        "FROM leads l WHERE "+who+"l.salesman_id=$1) AND "+when("l.created_at")+
        ") SELECT count(*)::int AS count, count(deal_value)::int AS valued_count,"+
        "coalesce(sum(deal_value),0)::numeric AS total,avg(deal_value)::numeric AS average "+
        "FROM stale WHERE "+
        stages.map((stage,i)=>"(stage=$"+(i*2+2)+" AND days_idle >= $"+(i*2+3)+")").join(" OR "),
        [id,...stages.flatMap(stage=>[stage,enabled.includes(stage)?Number(rules[stage+"_stale_days"]):2147483647])]);
      const r=rows[0]||{}, count=toCount(r), valued=Number(r.valued_count||0);
      const thresholdText=enabled.map(stage=>stage+" "+Number(rules[stage+"_stale_days"])+"d").join(", ");
      return {...result(plan.intent,plan.period,count,[],
        "Same enabled stage thresholds and updated_at inactivity calculation as Exception Centre ("+thresholdText+
        "). Period filters original creation date; current stage and last update determine whether a deal is stale. "+
        "Deal values are not currency-normalized."),
        answer:"There are "+count+" stale deals ("+plan.period.replace(/_/g," ")+
          ") under the enabled Exception Centre thresholds ("+thresholdText+"). "+
          "Combined recorded value: "+Number(r.total||0).toLocaleString("en-IN")+
          " across "+valued+" valued deals. "+
          (r.average==null?"No average recorded value is available.":"Average recorded stale-deal value: "+
            Number(r.average).toLocaleString("en-IN",{maximumFractionDigits:2})+".")+
          " "+(count-valued)+" deals have no recorded value. Currency is not specified.",
        value:Number(r.total||0),average:r.average==null?null:Number(r.average),valuedCount:valued};
    }
    case "lead_pipeline": {
      const {rows} = await query("SELECT l.status::text AS stage, count(*)::int AS count FROM leads l WHERE " +
        who + "l.salesman_id=$1) AND " + when("l.created_at") +
        " GROUP BY l.status ORDER BY count DESC,l.status LIMIT 30", args);
      const count = rows.reduce((n,r)=>n+toCount(r),0);
      return result(plan.intent,plan.period,count,asCounts(rows,"stage"),
        "Stage breakdown based on current stage, filtered by deal creation date.");
    }
    case "employee_performance": {
      if (!employee) throw Object.assign(new Error("Specify an employee name for an individual performance summary."), { status: 422 });
      // Current owner and creation date, consistent with existing Lead KPIs.
      const deals = await query(
        "SELECT count(*)::int AS count, " +
        "count(*) FILTER (WHERE l.status='won')::int AS won, " +
        "count(*) FILTER (WHERE l.status='negotiation')::int AS negotiation, " +
        "count(l.deal_value)::int AS valued_count, " +
        "coalesce(sum(l.deal_value),0)::numeric AS total_value, " +
        "avg(l.deal_value)::numeric AS avg_value " +
        "FROM leads l WHERE l.salesman_id=$1 AND " + when("l.created_at"), args);
      const tasks = await query(
        "SELECT count(*) FILTER (WHERE t.status IN ('pending','in_progress'))::int AS open_tasks, " +
        "count(*) FILTER (WHERE t.status IN ('pending','in_progress') AND t.due_at<now())::int AS overdue " +
        "FROM crm_tasks t WHERE t.assigned_to=$1 AND " + when("t.due_at"), args);
      const visits = await query(
        "SELECT count(*)::int AS count FROM visits v WHERE v.salesman_id=$1 AND " +
        when("v.arrived_at"), args);
      const row = deals.rows[0] || {};
      const count = toCount(row);
      const won = Number(row.won || 0);
      const negotiation = Number(row.negotiation || 0);
      const valued = Number(row.valued_count || 0);
      const conversion = count ? Number((won / count * 100).toFixed(2)) : 0;
      const money = n => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
      const openTasks = Number(tasks.rows[0]?.open_tasks || 0);
      const overdue = Number(tasks.rows[0]?.overdue || 0);
      const visitCount = toCount(visits.rows[0]);
      return {
        metric: plan.intent, count, items: [], totals: [], conversion,
        won, negotiation, valuedCount: valued, value: Number(row.total_value || 0),
        average: row.avg_value == null ? null : Number(row.avg_value),
        openTasks, overdueTasks: overdue, visits: visitCount,
        answer: employee.full_name + " — performance (" + plan.period.replace(/_/g, " ") + "): " +
          count + " currently assigned deals created in this period; " +
          won + " currently Won (" + conversion + "% of those deals); " +
          negotiation + " in Negotiation. " +
          "Recorded deal value: " + money(row.total_value || 0) + " across " + valued +
          " valued deals (currency not specified). " +
          "Average recorded deal value: " +
          (row.avg_value == null ? "not available" : money(row.avg_value)) + ". " +
          "Tasks due in this period: " + openTasks + " open, including " + overdue +
          " overdue. Recorded visits in this period: " + visitCount + ".",
        note: "Deal figures use current ownership and stage, filtered by deal creation date. " +
          "Won percentage is not a historical cohort conversion rate. Task figures use due dates; visits use arrival dates. " +
          "Only recorded values count toward the average; currencies are not identified in deal values."
      };
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
