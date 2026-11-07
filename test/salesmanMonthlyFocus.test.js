const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const db = require("../src/db");
const router = require("../src/routes/salesmanMonthlyFocus.routes");
const { istCurrentMonth, checkedMonth, checkedLeadId } = router._test;

const EMPLOYEE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const handlers = Object.fromEntries(
  router.stack.filter(layer => layer.route).flatMap(layer =>
    Object.keys(layer.route.methods).map(method =>
      [method.toUpperCase() + " " + layer.route.path, layer.route.stack.at(-1).handle]))
);
function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}
async function call(method, path, { month, body, query, params, results = [] } = {}) {
  const original = db.query;
  const calls = [];
  db.query = async (sql, args) => {
    calls.push({ sql, args });
    return results[calls.length - 1] || { rows: [], rowCount: 0 };
  };
  const res = response();
  const req = {
    user: { id: EMPLOYEE, role: "salesman" },
    query: query || (month ? { month } : {}),
    body: body || {},
    params: params || {},
  };
  try { await handlers[method + " " + path](req, res); }
  finally { db.query = original; }
  return { res, calls };
}

test("Monthly date helpers use Kolkata calendar month and reject malformed inputs", () => {
  assert.equal(istCurrentMonth(new Date("2026-10-31T18:29:59Z")), "2026-10");
  assert.equal(istCurrentMonth(new Date("2026-10-31T18:30:00Z")), "2026-11");
  assert.equal(istCurrentMonth(new Date("2026-11-30T18:30:00Z")), "2026-12");
  assert.equal(checkedMonth("2026-11"), "2026-11");
  for (const value of ["2026-00","2026-13","2026-1","november","2026-11-01",{},[]]) {
    assert.throws(() => checkedMonth(value), /valid month/);
  }
  assert.equal(checkedLeadId(DEAL), DEAL);
  assert.throws(() => checkedLeadId("sql-injection'"), /Invalid deal ID/);
});

test("List and search always select deals owned by the signed-in employee", async () => {
  const list = await call("GET", "/", {
    month:"2026-11",
    results:[{ rows:[{id:DEAL,business_name:"Sample",status:"hot",completed_at:null}] }],
  });
  assert.equal(list.res.body.month,"2026-11");
  assert.equal(list.res.body.items[0].id,DEAL);
  assert.match(list.calls[0].sql, /l\.salesman_id = \$1/);
  assert.match(list.calls[0].sql, /f\.salesman_id = \$1/);
  assert.deepEqual(list.calls[0].args,[EMPLOYEE,"2026-11-01"]);

  const search = await call("GET", "/search",{
    query:{q:"Cafe"}, results:[{rows:[{id:DEAL,business_name:"Sample"}]}],
  });
  assert.deepEqual(search.calls[0].args,[EMPLOYEE,"Cafe"]);
  assert.match(search.calls[0].sql,/WHERE salesman_id = \$1/);
  assert.match(search.calls[0].sql,/LIMIT 25/);
});

test("Adding own deal uses ownership-scoped INSERT and is idempotent", async () => {
  const month = istCurrentMonth();
  const added = await call("POST","/",{
    body:{month,leadId:DEAL},
    results:[{rows:[{lead_id:DEAL}],rowCount:1}],
  });
  assert.deepEqual(added.res.body,{ok:true});
  assert.match(added.calls[0].sql,/FROM leads l/);
  assert.match(added.calls[0].sql,/l\.salesman_id = \$1/);
  assert.match(added.calls[0].sql,/ON CONFLICT .* DO NOTHING/);
  assert.deepEqual(added.calls[0].args,[EMPLOYEE,month+"-01",DEAL]);

  const duplicate = await call("POST","/",{
    body:{month,leadId:DEAL},
    results:[{rows:[]},{rows:[{"?column?":1}]}],
  });
  assert.equal(duplicate.res.statusCode,200);

  const foreign = await call("POST","/",{
    body:{month,leadId:DEAL},
    results:[{rows:[]},{rows:[]}],
  });
  assert.equal(foreign.res.statusCode,404);
  assert.match(foreign.res.body.error,/not assigned/);
});

test("Mark done and reopen only update focus membership; not CRM lead status", async () => {
  const month = istCurrentMonth();
  const done = await call("PATCH","/:leadId",{
    params:{leadId:DEAL},body:{month,completed:true},
    results:[{rows:[{lead_id:DEAL,completed_at:"2026-11-07T10:00:00Z"}]}],
  });
  assert.equal(done.res.body.ok,true);
  assert.match(done.calls[0].sql,/SET completed_at = CASE/);
  assert.match(done.calls[0].sql,/l\.salesman_id = \$1/);
  assert.doesNotMatch(done.calls[0].sql,/UPDATE leads|lead_status_history|attendance/i);
  assert.deepEqual(done.calls[0].args,[EMPLOYEE,month+"-01",DEAL,true]);

  const invalid = await call("PATCH","/:leadId",{
    params:{leadId:DEAL},body:{month,completed:"true"},
  });
  assert.equal(invalid.res.statusCode,400);
  assert.equal(invalid.calls.length,0);

  const remove = await call("DELETE","/:leadId",{
    query:{month},params:{leadId:DEAL},results:[{rowCount:1,rows:[]}],
  });
  assert.equal(remove.res.body.ok,true);
  assert.match(remove.calls[0].sql,/DELETE FROM salesman_monthly_focus/);
  assert.doesNotMatch(remove.calls[0].sql,/DELETE FROM leads/);
  assert.match(remove.calls[0].sql,/l\.salesman_id = \$1/);
});

test("Past months are readable but cannot be modified", async () => {
  const today = istCurrentMonth();
  const prevDate = new Date(today+"-01T00:00:00Z");
  prevDate.setUTCMonth(prevDate.getUTCMonth()-1);
  const previous = prevDate.toISOString().slice(0,7);
  const read = await call("GET","/",{month:previous,results:[{rows:[]}]});
  assert.equal(read.res.statusCode,200);
  for(const [method,path,kwargs] of [
    ["POST","/",{body:{month:previous,leadId:DEAL}}],
    ["PATCH","/:leadId",{params:{leadId:DEAL},body:{month:previous,completed:true}}],
    ["DELETE","/:leadId",{query:{month:previous},params:{leadId:DEAL}}],
  ]) {
    await assert.rejects(() => call(method,path,kwargs),/Past months are read-only/);
  }
});

test("Only the new monthly-focus routes are mounted; existing sales/attendance routes are untouched", () => {
  const app = fs.readFileSync(require.resolve("../src/app"),"utf8");
  const sql = fs.readFileSync(require("node:path").join(__dirname,"../src/migrations/125_salesman_monthly_focus.sql"),"utf8");
  assert.match(app,/app\.use\("\/salesman\/monthly-focus", require\("\.\/routes\/salesmanMonthlyFocus\.routes"\)\)/);
  assert.match(sql,/ENABLE ROW LEVEL SECURITY/);
  assert.match(sql,/PRIMARY KEY \(salesman_id, month_start, lead_id\)/);
  assert.match(sql,/REFERENCES leads\(id\) ON DELETE CASCADE/);
  assert.match(require("node:fs").readFileSync(require.resolve("../src/routes/salesmanMonthlyFocus.routes"),"utf8"), /router\.use\(requireAuth, requireRole\("salesman"\)\)/);
});
