const test = require("node:test");
const assert = require("node:assert/strict");
const { PGlite } = require("@electric-sql/pglite");
const {
  parseWonListParams,
  getEmployeeWonDeals,
} = require("../src/routes/salesmanWonLeads.routes");
const { currentMonthWonMetrics } = require("../src/utils/dashboardComparisons");

const id = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const owner = id(100), other = id(200);
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"
}).formatToParts(new Date());
const part = type => today.find(p=>p.type===type).value;
const month = part("year") + "-" + part("month");
const thisMonthDate = month + "-01";
const oldMonthDate = String(Number(part("year"))-1) + "-" + part("month") + "-01";

test("parse employee Won list filters without accepting SQL or unbounded paging", () => {
  assert.deepEqual(parseWonListParams({}), {period:"month",page:1,limit:50,offset:0});
  assert.deepEqual(parseWonListParams({period:"all",page:"2",limit:"25"}),{period:"all",page:2,limit:25,offset:25});
  for (const input of [{period:"current"}, {period:"month'; DROP TABLE leads;--"},
    {page:"0"}, {limit:"101"}, {page:"1.0"}, {page:"10001"}, {limit:"Infinity"}]) {
    assert.throws(() => parseWonListParams(input),{status:400});
  }
});

test("employee Won API uses saved Won Date and CURRENT deal owner; no cross-employee leak", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec([
    "CREATE TABLE leads (id uuid PRIMARY KEY,salesman_id uuid,status text,deal_value numeric,",
    " business_name text,created_at timestamptz);",
    "CREATE TABLE lead_stage_milestones (lead_id uuid, salesman_id uuid, stage text, occurred_at timestamptz);"
  ].join(""));
  const scenarios = [
    // old restaurant created last year, but date changed to this month
    {n:1,assigned:owner,milestoneOwner:owner,status:"won",date:thisMonthDate,value:100},
    // another current-month win belonging to the same current employee
    {n:2,assigned:owner,milestoneOwner:other,status:"won",date:thisMonthDate,value:200},
    // old win should not be in this month's report
    {n:3,assigned:owner,milestoneOwner:owner,status:"won",date:oldMonthDate,value:300},
    // a different owner's deal must be invisible, even if milestone points to this employee
    {n:4,assigned:other,milestoneOwner:owner,status:"won",date:thisMonthDate,value:400},
    // historical milestone stays, but status is no longer Won
    {n:5,assigned:owner,milestoneOwner:owner,status:"negotiation",date:thisMonthDate,value:500},
    // legacy Won without milestone belongs in All Time only
    {n:6,assigned:owner,milestoneOwner:null,status:"won",date:null,value:600},
  ];
  for (const s of scenarios) {
    await db.query(
      "INSERT INTO leads VALUES ($1,$2,$3,$4,$5,$6)",
      [id(s.n),s.assigned,s.status,s.value,"Restaurant "+s.n,"2025-01-01T06:00:00Z"]
    );
    if (s.date) {
      await db.query(
        "INSERT INTO lead_stage_milestones VALUES ($1,$2,'won',($3::date::timestamp AT TIME ZONE 'Asia/Kolkata'))",
        [id(s.n),s.milestoneOwner,s.date]
      );
    }
  }
  const run=(employeeId,period,page=1,limit=50)=>getEmployeeWonDeals(
    {employeeId,period,page,limit,offset:(page-1)*limit},db.query.bind(db)
  );
  const current=await run(owner,"month");
  assert.equal(current.total,2);
  assert.equal(current.wonValue,300);
  assert.equal(current.leads.length,2);
  assert.deepEqual(current.leads.map(x=>x.id).sort(),[id(1),id(2)]);
  assert.ok(current.leads.every(x=>x.won_date===thisMonthDate));
  assert.equal(current.hasNext,false);
  const first=await run(owner,"month",1,1);
  assert.equal(first.total,2);
  assert.equal(first.hasNext,true);
  assert.equal(first.wonValue,300,"Revenue is full filtered total, not first page");
  const second=await run(owner,"month",2,1);
  assert.equal(second.leads.length,1);
  assert.equal(second.hasNext,false);
  assert.notEqual(first.leads[0].id,second.leads[0].id);
  const all=await run(owner,"all");
  assert.equal(all.total,4);
  assert.equal(all.wonValue,1200);
  assert.ok(all.leads.some(x=>x.id===id(3)));
  assert.ok(all.leads.some(x=>x.id===id(6) && x.won_date===null));
  const someoneElse=await run(other,"month");
  assert.equal(someoneElse.total,1);
  assert.deepEqual(someoneElse.leads.map(x=>x.id),[id(4)]);
  // The summary card must count on the same current ownership scope.
  const kpi=await currentMonthWonMetrics({salesmanId:owner,query:db.query.bind(db)});
  assert.equal(kpi.monthWonCount,current.total);
  assert.equal(kpi.monthWonValue,current.wonValue);
});
