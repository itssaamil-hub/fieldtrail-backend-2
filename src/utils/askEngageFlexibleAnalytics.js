// Ask Engage flexible analytics: bounded aggregates from an explicit schema allowlist.
// The model chooses enum values only; it never supplies SQL, identifiers or expressions.
const C = require("./collections");
const OPTIONS = Object.freeze({
  dataset:["deals","tasks","quotations","visits","attendance","payments"],
  measure:["count","sum","average","min","max"],
  groupBy:["none","employee","stage","category","priority","status","month","city","currency"],
  status:["all","cold","conversation","hot","demo","negotiation","won","lost","nurture",
    "pending","in_progress","completed","pending_approval","ready","sent","accepted",
    "rejected","changes_requested","overdue","partially_paid","unpaid","paid"]
});
const SPEC={
  deals:{
    from:"leads l LEFT JOIN users u ON u.id=l.salesman_id LEFT JOIN salesman_profiles sp ON sp.user_id=l.salesman_id",
    employee:"l.salesman_id",date:"l.created_at",timestamp:true,
    value:"l.deal_value",status:"l.status::text",
    groups:{employee:"u.full_name",stage:"l.status::text",category:"l.category",month:"to_char(l.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM')",city:"sp.city"}
  },
  tasks:{
    from:"crm_tasks t LEFT JOIN users u ON u.id=t.assigned_to",
    employee:"t.assigned_to",date:"t.due_at",timestamp:true,
    value:null,status:"t.status::text",
    groups:{employee:"u.full_name",status:"t.status::text",priority:"t.priority",month:"to_char(t.due_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM')"}
  },
  quotations:{
    from:"quotations q JOIN quotation_revisions qr ON qr.quote_id=q.id AND qr.revision=q.current_revision LEFT JOIN users u ON u.id=q.owner_id",
    employee:"q.owner_id",date:"q.created_at",timestamp:true,
    value:null,status:"qr.status",
    groups:{employee:"u.full_name",status:"qr.status",month:"to_char(q.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM')"}
  },
  visits:{
    from:"visits v LEFT JOIN users u ON u.id=v.salesman_id",
    employee:"v.salesman_id",date:"v.arrived_at",timestamp:true,value:null,status:null,
    groups:{employee:"u.full_name",month:"to_char(v.arrived_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM')"}
  },
  attendance:{
    from:"attendance a LEFT JOIN users u ON u.id=a.salesman_id",
    employee:"a.salesman_id",date:"a.day",timestamp:false,value:null,status:null,
    groups:{employee:"u.full_name",month:"to_char(a.day,'YYYY-MM')"}
  },
  payments:{
    from:"(WITH accounts AS ("+C.source+"), paid AS ("+
      "SELECT c.key,c.currency,c.due_date,c.assigned_to,c.total,"+
      "coalesce((SELECT sum(p.amount) FROM lead_payments p WHERE p.account_id=c.id OR p.lead_id=c.lead_id),0) AS paid "+
      "FROM accounts c) SELECT *,greatest(total-paid,0) AS balance FROM paid) p "+
      "LEFT JOIN users u ON u.id=p.assigned_to",
    employee:"p.assigned_to",date:"p.due_date",timestamp:false,
    value:"p.balance",status:null,
    groups:{employee:"u.full_name",currency:"p.currency",month:"to_char(p.due_date,'YYYY-MM')"}
  }
};
function invalid(message){return Object.assign(new Error(message),{status:422});}
function validateAnalysis(value){
  if(!value||typeof value!=="object"||Array.isArray(value))throw invalid("Choose a supported CRM analysis.");
  const out={};
  for(const field of ["dataset","measure","groupBy","status"]){
    if(typeof value[field]!=="string"||!OPTIONS[field].includes(value[field]))throw invalid("Unsupported analytics "+field+".");
    out[field]=value[field];
  }
  const spec=SPEC[out.dataset];
  if(out.groupBy!=="none"&&!Object.hasOwn(spec.groups,out.groupBy))
    throw invalid("This CRM module cannot be grouped by "+out.groupBy+".");
  if(out.measure!=="count"&&!spec.value)throw invalid("Recorded financial values are not available for "+out.dataset+".");
  if(out.dataset==="payments"&&out.measure!=="count"&&out.groupBy!=="currency")
    throw invalid("Group payment amounts by currency to avoid combining INR, AED and SAR.");
  if(out.status!=="all"){
    if(!spec.status && out.dataset!=="payments")throw invalid("Status filtering is not supported for "+out.dataset+".");
    const allowed={
      deals:["cold","conversation","hot","demo","negotiation","won","lost","nurture"],
      tasks:["pending","in_progress","completed"],
      quotations:["pending_approval","ready","sent","accepted","rejected","changes_requested"],
      payments:["overdue","partially_paid","unpaid","paid","pending"]
    };
    if(!allowed[out.dataset]?.includes(out.status))throw invalid("Invalid "+out.dataset+" status.");
  }
  return out;
}
const format=n=>Number(n).toLocaleString("en-IN",{maximumFractionDigits:2});
async function runAnalysis(plan,employee,query,dateFilter){
  const opts=validateAnalysis(plan.analysis);
  const spec=SPEC[opts.dataset];
  const group=opts.groupBy==="none"?"'All'::text":spec.groups[opts.groupBy];
  const clauses=["($1::uuid IS NULL OR "+spec.employee+"=$1)",
    dateFilter(plan.period,spec.date,spec.timestamp)];
  if(opts.status!=="all"){
    if(opts.dataset==="payments"){
      const map={
        pending:"p.balance > 0 AND p.paid=0 AND (p.due_date IS NULL OR p.due_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date)",
        overdue:"p.balance > 0 AND p.due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date",
        partially_paid:"p.balance > 0 AND p.paid>0",
        unpaid:"p.balance > 0 AND p.paid=0",
        paid:"p.balance=0"
      };
      clauses.push(map[opts.status]);
    } else clauses.push(spec.status+"=$2");
  }
  const args=[employee?.id||null];
  if(opts.status!=="all"&&opts.dataset!=="payments")args.push(opts.status);
  const value=spec.value;
  const aggregate=opts.measure==="count"?"count(*)::numeric":
    opts.measure==="sum"?"coalesce(sum("+value+"),0)::numeric":
    opts.measure==="average"?"avg("+value+")::numeric":
    opts.measure==="min"?"min("+value+")::numeric":
    "max("+value+")::numeric";
  const sql="SELECT "+group+" AS label,count(*)::int AS records,"+
    (value?"count("+value+")::int AS valued,":"count(*)::int AS valued,")+
    aggregate+" AS metric FROM "+spec.from+" WHERE "+clauses.join(" AND ")+
    " GROUP BY 1 ORDER BY metric DESC NULLS LAST,label ASC LIMIT 21";
  const {rows}=await query(sql,args);
  const records=rows.slice(0,20).map(r=>({
    name:String(r.label??"Unspecified").slice(0,120),
    records:Number(r.records||0),
    valued:Number(r.valued||0),
    metric:r.metric==null?null:Number(r.metric)
  }));
  const suffix=opts.measure==="count"?" records":" recorded value";
  const lines=records.map(r=>r.name+": "+(r.metric===null?"not available":format(r.metric)+suffix)+
    (opts.measure!=="count"?" ("+r.valued+" valued of "+r.records+" records)":""));
  const note=[
    "Read-only snapshot from Engage "+opts.dataset+".",
    "Date range: "+plan.period.replace(/_/g," ")+
    " (uses "+(opts.dataset==="payments"?"payment account due date":opts.dataset==="tasks"?"task due date":"record creation/date") +").",
    opts.status==="all"?"All statuses.":"Filtered status: "+opts.status+".",
    opts.dataset==="deals"?"Deal value is an untyped estimate; currency is not specified.":"",
    opts.dataset==="payments"?"Payment balances are separated by currency; historical period means due-date filter, not an as-of balance.":"",
    rows.length>20?"Showing top 20 groups; remaining groups were omitted.":""
  ].filter(Boolean).join(" ");
  return {
    metric:"flexible_analytics",count:records.reduce((n,r)=>n+r.records,0),
    answer:lines.length?"For "+opts.dataset+" ("+opts.measure+
      (opts.groupBy==="none"?"":", grouped by "+opts.groupBy)+"): "+lines.join("; ")+"."
      :"No matching "+opts.dataset+" records for the requested filters.",
    note,items:[],totals:[],source:"crm",analysis:opts
  };
}
module.exports={OPTIONS,validateAnalysis,runAnalysis};
