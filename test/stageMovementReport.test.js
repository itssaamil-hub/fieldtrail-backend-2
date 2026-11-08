const test = require("node:test");
const assert = require("node:assert/strict");
const {
  STAGES, parseFilters, parsePage, getSummary, getEvents
} = require("../src/utils/stageMovementReport");

const EMPLOYEE = "11111111-1111-4111-8111-111111111111";

test("stage movement uses exact IST calendar month and optional current owner", () => {
  const f = parseFilters({ month: "2026-10", salesmanId: EMPLOYEE });
  assert.equal(f.start.toISOString(), "2026-09-30T18:30:00.000Z");
  assert.equal(f.end.toISOString(), "2026-10-31T18:30:00.000Z");
  assert.equal(f.salesmanId, EMPLOYEE);
  const november = parseFilters({ month: "2026-11", salesmanId: "all" });
  assert.equal(november.start.toISOString(), "2026-10-31T18:30:00.000Z");
  assert.equal(november.end.toISOString(), "2026-11-30T18:30:00.000Z");
  assert.equal(november.salesmanId, null);
  assert.deepEqual(STAGES, ["hot", "conversation", "negotiation", "won"]);
});

test("reject malformed, injection and unbounded report filters before SQL", () => {
  for (const month of [undefined, "", "2026-00", "2026-13", "2026-1", "2026-11;DROP TABLE leads", "1990-11"]) {
    assert.throws(() => parseFilters({month}), {status:400});
  }
  assert.throws(() => parseFilters({month:"2026-11",salesmanId:"fake"}), {status:400});
  for (const stage of ["lost", "cold", undefined, "won;DROP TABLE users"]) {
    assert.throws(() => parsePage({stage}), {status:400});
  }
  for (const input of [
    {stage:"won",page:"0"}, {stage:"won",page:"1e3"},
    {stage:"hot",limit:"200"}, {stage:"hot",page:"1001"},
    {stage:"won",limit:"50;--"}
  ]) {
    assert.throws(() => parsePage(input), {status:400});
  }
  assert.deepEqual(parsePage({stage:"negotiation",page:"2",limit:"25"}),
    {stage:"negotiation",page:2,limit:25,offset:25});
});

test("summary counts movement into each stage for current owner, even after moving out", async () => {
  const f = parseFilters({month:"2026-10"});
  const captured = [];
  const data = await getSummary(f, async (sql,params) => {
    captured.push({sql,params});
    return {rows:[
      {salesman_id:EMPLOYEE,employee_name:"Sales One",hot:4,conversation:5,negotiation:8,won:2},
      {salesman_id:"22222222-2222-4222-8222-222222222222",employee_name:"Sales Two",hot:1,conversation:2,negotiation:3,won:0}
    ]};
  });
  assert.deepEqual(data.totals,{hot:5,conversation:7,negotiation:11,won:2});
  assert.equal(data.movements,25);
  assert.equal(data.employees[0].employeeName,"Sales One");
  assert.deepEqual(captured[0].params,[f.start,f.end,null]);
  assert.match(captured[0].sql,/FROM lead_status_history h/);
  assert.match(captured[0].sql,/DISTINCT ON \(h\.lead_id, h\.new_status\)/);
  assert.match(captured[0].sql,/JOIN leads l ON l\.id = h\.lead_id/);
  assert.match(captured[0].sql,/ORDER BY h\.lead_id, h\.new_status, h\.changed_at DESC, h\.id DESC/);
  assert.doesNotMatch(captured[0].sql,/l\.status\s*=\s*'negotiation'/);
  assert.match(captured[0].sql,/l\.salesman_id = \$3::uuid/);
});

test("events show real changed-by actor, stage date and current status with pagination", async () => {
  const f = parseFilters({month:"2026-11",salesmanId:EMPLOYEE});
  const p = parsePage({stage:"negotiation",page:"2",limit:"50"});
  let captured;
  const data = await getEvents(f,p,async(sql,params)=>{
    captured={sql,params};
    return {rows:[{
      id:"history-1",lead_id:"lead-1",stage:"negotiation",previous_stage:"conversation",
      changed_at:"2026-11-05T06:30:00Z",changed_by:"admin-uuid",
      business_name:"Sample restaurant",current_status:"won",salesman_id:EMPLOYEE,
      owner_name:"Sales One",actor_name:"Admin",total:53
    }]};
  });
  assert.equal(data.events.length,1);
  assert.equal(data.events[0].currentStatus,"won");
  assert.equal(data.events[0].changedByName,"Admin");
  assert.equal(data.events[0].employeeName,"Sales One");
  assert.equal(data.total,53);
  assert.equal(data.hasNext,true);
  assert.deepEqual(captured.params,[f.start,f.end,EMPLOYEE,"negotiation",50,50]);
  assert.match(captured.sql,/changed_by/);
  assert.match(captured.sql,/COUNT\(\*\) OVER\(\)::int AS total/);
  assert.match(captured.sql,/ORDER BY changed_at DESC, id DESC/);
});

test("empty report returns true zeros without placeholder deal rows", async () => {
  const f = parseFilters({month:"2025-02"});
  const data = await getSummary(f,async()=>({rows:[]}));
  assert.deepEqual(data.totals,{hot:0,conversation:0,negotiation:0,won:0});
  assert.equal(data.movements,0);
  const events = await getEvents(f,parsePage({stage:"won"}),async()=>({rows:[]}));
  assert.deepEqual(events.events,[]);
  assert.equal(events.total,0);
  assert.equal(events.hasNext,false);
});
