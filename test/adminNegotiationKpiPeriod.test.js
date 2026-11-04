const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/db");
const router = require("../src/routes/adminLeadPagination.routes");
const handler = router.stack.find(layer => layer.route?.path === "/leads" && layer.route.methods.get).route.stack[0].handle;
function res() {
  return { statusCode:200, body:null, status(code){this.statusCode=code;return this},
    json(body){this.body=body;return this} };
}
async function run(query) {
  const calls=[];
  const old=db.query;
  db.query=async(sql,params)=> {
    calls.push({sql,params});
    if (/SELECT count\(\*\)::int AS total/.test(sql)) return {rows:[{total:2}]};
    return {rows:[{id:"fake-id",business_name:"Sample"}]};
  };
  const response=res();
  try {await handler({query},response)}finally{db.query=old}
  return {calls,response};
}
test("Negotiation KPI month uses last transition into negotiation, not lead creation",async()=>{
  const {calls,response}=await run({status:"negotiation",negotiationPeriod:"month",page:"1",limit:"100"});
  assert.equal(response.statusCode,200);
  assert.equal(response.body.total,2);
  assert.equal(calls.length,2);
  for(const {sql} of calls) {
    assert.match(sql,/l\.status = \$1/);
    assert.match(sql,/FROM lead_status_history h/);
    assert.match(sql,/h\.new_status = 'negotiation'/);
    assert.match(sql,/h\.changed_at DESC/);
    assert.match(sql,/COALESCE\(\(/);
    assert.match(sql,/l\.created_at\)/);
    assert.match(sql,/date_trunc\('month', now\(\) AT TIME ZONE 'Asia\/Kolkata'\)/);
    assert.match(sql,/AT TIME ZONE 'Asia\/Kolkata'/);
  }
  assert.deepEqual(calls[0].params,["negotiation"]);
  assert.deepEqual(calls[1].params,["negotiation",100,0]);
  assert.equal(response.body.hasNext,false);
});
test("Default admin lead listing and all-time Negotiation queries remain unchanged",async()=>{
  for(const query of [{}, {status:"negotiation",page:"1",limit:"100"}, {status:"won",page:"1"}]) {
    const {calls,response}=await run(query);
    assert.equal(response.statusCode,200);
    assert.equal(calls.length,2);
    assert.ok(calls.every(x=>!x.sql.includes("lead_status_history")), "unrelated query changed");
  }
});
test("Month filter cannot change any other lead status or be passed invalid values",async()=>{
  for(const query of [
    {status:"won",negotiationPeriod:"month"},
    {status:"negotiation",negotiationPeriod:"last_year"},
    {negotiationPeriod:"month"},
    {status:"negotiation",negotiationPeriod:"all"},
    {status:"negotiation",negotiationPeriod:"month;DROP TABLE leads"}
  ]) {
    const {calls,response}=await run(query);
    assert.equal(response.statusCode,400);
    assert.equal(calls.length,0);
  }
});
