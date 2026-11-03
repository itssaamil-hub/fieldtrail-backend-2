const test=require("node:test");
const assert=require("node:assert/strict");
const analytics=require("../src/utils/askEngageFlexibleAnalytics");
const ask=require("../src/routes/askEngage.routes")._test;
const dateFilter=ask.dateFilter;
const employee={id:"11111111-1111-4111-8111-111111111111",full_name:"Anand"};
const opts=(dataset,measure="count",groupBy="none",status="all")=>({dataset,measure,groupBy,status});
function plan(analysis,period="this_month"){return {intent:"flexible_analytics",period,analysis};}
test("Flexible analytics validate strict schema and prevent unapproved dimensions and SQL",()=>{
  assert.deepEqual(analytics.validateAnalysis(opts("deals","sum","stage","negotiation")),opts("deals","sum","stage","negotiation"));
  assert.throws(()=>analytics.validateAnalysis(opts("tasks","sum","employee")) ,/financial values/);
  assert.throws(()=>analytics.validateAnalysis(opts("payments","sum","none")) ,/currency/);
  assert.throws(()=>analytics.validateAnalysis(opts("visits","count","city")) ,/cannot be grouped/);
  assert.throws(()=>analytics.validateAnalysis(opts("deals","count","none","DROP TABLE")) ,/status/);
  assert.throws(()=>analytics.validateAnalysis({dataset:"leads;DELETE",measure:"count",groupBy:"none",status:"all"}) ,/dataset/);
  assert.throws(()=>analytics.validateAnalysis(opts("attendance","count","none","won")),/Status filtering/);
});
test("Gemini plan validation accepts allowed flexible analytics without changing existing intents",()=>{
  const p=ask.validatePlan({intent:"flexible_analytics",employee:"Anand",period:"this_quarter",
    analysis:opts("deals","average","employee","negotiation")});
  assert.equal(p.employee,"Anand");
  assert.equal(p.analysis.groupBy,"employee");
  assert.deepEqual(ask.validatePlan({intent:"lead_summary",employee:"",period:"all"}),
    {intent:"lead_summary",employee:"",period:"all"});
  assert.throws(()=>ask.validatePlan({intent:"flexible_analytics",employee:"",period:"all"}),/supported CRM analysis/);
});
test("Deal value by stage uses parameterized status, filtered employee and period",async()=>{
  let seen;
  const out=await analytics.runAnalysis(plan(opts("deals","sum","stage","negotiation")),employee,
    async(sql,args)=>{seen={sql,args};return {rows:[{label:"negotiation",records:5,valued:4,metric:"150000"}]}},dateFilter);
  assert.match(out.answer,/1,50,000/);
  assert.match(out.answer,/4 valued of 5 records/);
  assert.deepEqual(seen.args,[employee.id,"negotiation"]);
  assert.match(seen.sql,/l.status::text=\$2/);
  assert.match(seen.sql,/l.salesman_id=\$1/);
  assert.match(seen.sql,/date_trunc\('month'/);
  assert.doesNotMatch(seen.sql,/INSERT|DELETE FROM|UPDATE leads/i);
  assert.deepEqual(out.items,[]);
});
test("Won deals by employee returns bounded text-only counts",async()=>{
  let seen;
  const out=await analytics.runAnalysis(plan(opts("deals","count","employee","won"),"last_quarter"),null,
    async(sql,args)=>{seen={sql,args};return {rows:[{label:"Anand",records:5,valued:5,metric:5},
      {label:"Rahul",records:2,valued:2,metric:2}]}},dateFilter);
  assert.match(out.answer,/Anand: 5 records/);
  assert.match(out.answer,/Rahul: 2 records/);
  assert.match(seen.sql,/LIMIT 21/);
  assert.match(seen.sql,/date_trunc\('quarter'/);
  assert.deepEqual(seen.args,[null,"won"]);
});
test("Payment totals are currency-separated and never mixed",async()=>{
  let sql;
  const out=await analytics.runAnalysis(plan(opts("payments","sum","currency","overdue"),"all"),null,
    async(query,args)=>{sql=query;assert.deepEqual(args,[null]);return {rows:[
      {label:"INR",records:3,valued:3,metric:"10000"},
      {label:"AED",records:1,valued:1,metric:"100"}
    ]}},dateFilter);
  assert.match(out.answer,/INR: 10,000/);
  assert.match(out.answer,/AED: 100/);
  assert.match(out.note,/separated by currency/);
  assert.match(sql,/collection_accounts/);
  assert.match(sql,/p.balance > 0/);
  assert.doesNotMatch(sql,/\b(?:INSERT|DELETE|UPDATE)\b/i);
});
test("Unsupplied valuation averages show unavailable rather than zero",async()=>{
  const out=await analytics.runAnalysis(plan(opts("deals","average","category","all")),null,
    async()=>({rows:[{label:"Cafe",records:2,valued:0,metric:null}]}),dateFilter);
  assert.match(out.answer,/Cafe: not available/);
});
test("Grouped output truncation says when other groups are excluded",async()=>{
  const rows=Array.from({length:21},(_,i)=>({label:"group"+i,records:1,valued:1,metric:1}));
  const out=await analytics.runAnalysis(plan(opts("tasks","count","priority","all")),null,
    async()=>({rows}),dateFilter);
  assert.match(out.note,/top 20 groups/);
  assert.doesNotMatch(out.answer,/group20:/);
});
