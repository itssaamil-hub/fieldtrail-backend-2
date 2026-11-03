const test = require("node:test");
const assert = require("node:assert/strict");
const reports = require("../src/utils/askEngageReports");
const ask = require("../src/routes/askEngage.routes")._test;
const dateFilter = ask.dateFilter;
const employee = {id:"11111111-1111-4111-8111-111111111111",full_name:"Anand"};
test("Ask Engage supports broad read-only CRM reporting intents",()=>{
  for(const intent of Object.keys(reports.summaries)){
    assert.equal(ask.validatePlan({intent,employee:"",period:"today"}).intent,intent);
  }
  assert.throws(()=>ask.validatePlan({intent:"custom_sql",employee:"",period:"all"}),/rephrase/);
});
test("Pipeline reports use actual status counts without returning sensitive rows",async()=>{
  let called;
  const result=await reports.answerExtra({intent:"lead_pipeline",period:"this_month"},employee,
    async(sql,args)=>{called={sql,args};return {rows:[{stage:"hot",count:5},{stage:"won",count:3}]}},dateFilter);
  assert.equal(result.count,8);
  assert.match(result.answer,/hot: 5/);
  assert.match(result.answer,/won: 3/);
  assert.deepEqual(result.items,[]);
  assert.deepEqual(called.args,[employee.id]);
  assert.match(called.sql,/l.salesman_id=\$1/);
  assert.match(called.sql,/GROUP BY l.status/);
  assert.doesNotMatch(called.sql,/\b(?:INSERT|UPDATE|DELETE)\b/i);
});
test("Task overdue is restricted to incomplete tasks and past due times",async()=>{
  let seen;
  const result=await reports.answerExtra({intent:"overdue_tasks",period:"all"},null,
    async(sql,args)=>{seen={sql,args};return {rows:[{status:"pending",count:2},{status:"in_progress",count:1}]}},dateFilter);
  assert.equal(result.count,3);
  assert.match(result.answer,/pending: 2/);
  assert.match(seen.sql,/t.due_at<now\(\)/);
  assert.match(seen.sql,/t.status IN \('pending','in_progress'\)/);
  assert.deepEqual(seen.args,[null]);
});
test("Attendance is session-based and never treated as absences",async()=>{
  const result=await reports.answerExtra({intent:"attendance_summary",period:"today"},employee,
    async(sql,args)=>{assert.match(sql,/FROM attendance a/);assert.deepEqual(args,[employee.id]);
      return {rows:[{count:2,started:2,ended:1}]}},dateFilter);
  assert.match(result.answer,/started: 2; ended: 1/);
  assert.match(result.note,/not an absence/i);
  assert.deepEqual(result.totals,[]);
});
test("Employee rankings and quotations use bounded aggregated reads",async()=>{
  const seen=[];
  const query=async(sql,args)=>{seen.push({sql,args});
    if(sql.includes("FROM users u"))return {rows:[{name:"Anand",count:6,won:2},{name:"Rahul",count:4,won:1}]};
    return {rows:[{status:"sent",count:4},{status:"accepted",count:1}]};};
  const ranked=await reports.answerExtra({intent:"employee_leaderboard",period:"this_week"},null,query,dateFilter);
  assert.match(ranked.answer,/Anand: 6 assigned \(2 Won\)/);
  assert.match(seen[0].sql,/LIMIT 20/);
  assert.deepEqual(seen[0].args,[]);
  const quotes=await reports.answerExtra({intent:"quotation_summary",period:"last_month"},null,query,dateFilter);
  assert.equal(quotes.count,5);
  assert.match(quotes.answer,/accepted: 1/);
  assert.match(seen[1].sql,/q.current_revision/);
});
test("Unknown metric cannot be executed via report selector",async()=>{
  const result=await reports.answerExtra({intent:"run_sql",period:"all"},null,
    async()=>{throw Error("must not query")},dateFilter);
  assert.equal(result,null);
});

test("Won and conversion metrics derive from current lead stages without invented currency",async()=>{
  const seen=[];
  const query=async(sql,args)=>{
    seen.push({sql,args});
    if(sql.includes("sum(l.deal_value)")) return {rows:[{count:4,total:"40000.00"}]};
    return {rows:[{count:10,won:4}]};
  };
  const conversion=await reports.answerExtra({intent:"conversion_summary",period:"this_quarter"},employee,query,dateFilter);
  assert.match(conversion.answer,/4 Won out of 10 deals \(40%\)/);
  assert.match(seen[0].sql,/date_trunc\('quarter'/);
  assert.deepEqual(seen[0].args,[employee.id]);
  const value=await reports.answerExtra({intent:"won_deal_value",period:"all"},employee,query,dateFilter);
  assert.match(value.answer,/40,000/);
  assert.match(value.answer,/currency not specified/i);
  assert.equal(value.count,4);
});

test("Negotiation totals and average exclude missing deal values while preserving zero", async()=>{
  let seen;
  const query=async(sql,args)=>{seen={sql,args};return {rows:[{count:7,valued_count:5,total:"125000",average:"25000"}]};};
  const result=await reports.answerExtra({intent:"negotiation_summary",period:"this_month"},employee,query,dateFilter);
  assert.equal(result.count,7);
  assert.equal(result.value,125000);
  assert.equal(result.average,25000);
  assert.equal(result.valuedCount,5);
  assert.match(result.answer,/Negotiation/);
  assert.match(result.answer,/1,25,000/);
  assert.match(result.answer,/25,000/);
  assert.match(result.answer,/2 deals have no recorded value/);
  assert.match(result.answer,/Currency is not specified/);
  assert.match(seen.sql,/l.status='negotiation'/);
  assert.match(seen.sql,/count\(l.deal_value\)/);
  assert.deepEqual(seen.args,[employee.id]);
});
test("Average deal value reports unavailable when all recorded values are missing",async()=>{
  const none=await reports.answerExtra({intent:"average_deal_value",period:"all"},null,
    async()=>({rows:[{count:4,valued_count:0,total:"0",average:null}]}),dateFilter);
  assert.equal(none.average,null);
  assert.match(none.answer,/no average deal value/);
  const populated=await reports.answerExtra({intent:"average_deal_value",period:"this_quarter"},employee,
    async(sql,args)=>{assert.match(sql,/date_trunc\('quarter'/);assert.deepEqual(args,[employee.id]);
      return {rows:[{count:4,valued_count:3,total:"90000",average:"30000"}]}},dateFilter);
  assert.equal(populated.average,30000);
  assert.match(populated.answer,/30,000/);
  assert.match(populated.answer,/1 have no recorded value/);
});
test("Stale deals use configurable enabled Exception Centre thresholds and lead updated_at", async()=>{
  const queries=[];
  const query=async(sql,args)=>{
    queries.push({sql,args});
    if(sql.includes("FROM exception_settings"))return {rows:[{
      cold_enabled:true,cold_stale_days:10,
      conversation_enabled:false,conversation_stale_days:7,
      hot_enabled:true,hot_stale_days:3,
      negotiation_enabled:true,negotiation_stale_days:2
    }]};
    return {rows:[{count:6,valued_count:4,total:"80000",average:"20000"}]};
  };
  const r=await reports.answerExtra({intent:"stale_deals",period:"this_month"},employee,query,dateFilter);
  assert.equal(r.count,6);
  assert.equal(r.value,80000);
  assert.equal(r.average,20000);
  assert.match(r.answer,/cold 10d, hot 3d, negotiation 2d/);
  assert.match(r.answer,/80,000/);
  assert.match(r.answer,/2 deals have no recorded value/);
  assert.match(queries[1].sql,/l.updated_at/);
  assert.match(queries[1].sql,/l.created_at/);
  assert.deepEqual(queries[1].args.slice(0,3),[employee.id,"cold",10]);
  assert.deepEqual(queries[1].args.slice(3,5),["conversation",2147483647]);
});
test("Stale deal report explains when all stage rules are disabled",async()=>{
  let called=0;
  const q=async()=>{called++;return {rows:[{
    cold_enabled:false,conversation_enabled:false,hot_enabled:false,negotiation_enabled:false
  }]}};
  const r=await reports.answerExtra({intent:"stale_deals",period:"all"},null,q,dateFilter);
  assert.equal(called,1);
  assert.match(r.answer,/no active stale-deal detection rules enabled/i);
});
