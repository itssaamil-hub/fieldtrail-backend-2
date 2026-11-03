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
