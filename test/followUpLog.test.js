const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFollowUpLog } = require("../src/utils/followUpLog");
const db = require("../src/db");
const salesman = require("../src/routes/salesmanSafeWrites.routes");
const admin = require("../src/routes/adminLeadSafeWrites.routes");

const DEAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const log = (extra = {}) => ({ mode: "reschedule", outcome: "callback_requested",
  feedback: "Owner requested a call after checking pricing.", requestId: REQUEST_ID, ...extra });
const body = (extra = {}) => ({
  nextFollowUpDate: "2026-11-12", followUpLog: log(), ...extra,
});
const response = () => ({ json(value) { this.body = value; return this; } });

test("Follow-up Log requires a valid outcome, notes except for No Answer, and a date for rescheduling", () => {
  assert.deepEqual(parseFollowUpLog(body()), log());
  assert.equal(parseFollowUpLog({ nextFollowUpDate: null }), null);
  assert.equal(parseFollowUpLog(body({ followUpLog: log({ outcome: "no_answer", feedback: "" }) })).feedback, "");
  assert.deepEqual(parseFollowUpLog(body({
    nextFollowUpDate: null, followUpLog: log({ mode: "done" }),
  })), log({ mode: "done" }));
  const invalid = [
    body({ followUpLog: log({ outcome: "made_up" }) }),
    body({ followUpLog: log({ outcome: "interested", feedback: "" }) }),
    body({ followUpLog: log({ requestId: "invalid" }) }),
    body({ followUpLog: log({ feedback: "x".repeat(2001) }) }),
    body({ followUpLog: log({ mode: "reschedule" }), nextFollowUpDate: null }),
    body({ nextFollowUpDate: "2026-02-30" }),
    { followUpLog: log() },
  ];
  for (const item of invalid) assert.throws(() => parseFollowUpLog(item), { status: 400 });
});

const handler = router => router.stack.find(layer =>
  layer.route?.path === "/leads/:id" && layer.route.methods.patch
).route.stack.at(-1).handle;

function simulateDb({ duplicate = false, throwOnLog = false } = {}) {
  const original = db.pool.connect;
  const calls = [];
  const before = { id: DEAL, business_name: "Demo Cafe", salesman_id: USER,
    next_follow_up_date: "2026-11-10T00:00:00.000Z", notes: "Keep existing comments",
    status: "conversation" };
  const after = { ...before, next_follow_up_date: "2026-11-12T00:00:00.000Z" };
  db.pool.connect = async () => ({
    release() {},
    async query(sql, args) {
      calls.push({ sql, args });
      if (/^SELECT \* FROM leads/.test(sql)) return { rows: [before] };
      if (/^SELECT 1 FROM activity_logs/.test(sql)) return { rows: duplicate ? [{ "?column?": 1 }] : [] };
      if (/^UPDATE leads SET/.test(sql)) return { rows: [after] };
      if (throwOnLog && sql.includes("'lead.follow_up_logged'")) throw Error("Simulated write failure");
      return { rows: [] };
    },
  });
  return { calls, restore: () => { db.pool.connect = original; } };
}

for (const [role, router] of [["salesman", salesman], ["admin", admin]]) {
  test(role + " writes feedback atomically and preserves CRM stage and Comments", async () => {
    const fake = simulateDb();
    const res = response();
    try {
      await handler(router)({ user: { id: USER, role }, params: { id: DEAL }, body: body() }, res);
    } finally { fake.restore(); }
    assert.equal(res.body.lead.status, "conversation");
    assert.equal(res.body.lead.notes, "Keep existing comments");
    assert(fake.calls.some(x => x.sql === "COMMIT"));
    const write = fake.calls.find(x => x.sql.includes("'lead.follow_up_logged'"));
    assert(write, "Missing new append-only customer feedback audit");
    assert.equal(write.args[0], USER);
    const saved = JSON.parse(write.args[2]);
    assert.equal(saved.feedback, log().feedback);
    assert.equal(saved.outcome, "callback_requested");
    assert.equal(saved.mode, "reschedule");
    assert.equal(saved.from, "2026-11-10");
    assert.equal(saved.to, "2026-11-12");
    assert(!fake.calls.some(x => /UPDATE.*status\s*=|UPDATE.*notes\s*=|attendance/i.test(x.sql) && !x.sql.includes("UPDATE leads SET")));
    assert(fake.calls.find(x => x.sql.includes("UPDATE leads SET")), "Missing date update");
  });

  test(role + " rollback when feedback log insert fails", async () => {
    const fake = simulateDb({ throwOnLog: true });
    try {
      await assert.rejects(handler(router)({
        user: { id: USER, role }, params: { id: DEAL }, body: body(),
      }, response()), /Simulated write failure/);
    } finally { fake.restore(); }
    assert(fake.calls.some(x => x.sql === "ROLLBACK"));
    assert(!fake.calls.some(x => x.sql === "COMMIT"));
  });

  test(role + " does not repeat date update or log when same request is retried", async () => {
    const fake = simulateDb({ duplicate: true });
    try {
      const res = response();
      await handler(router)({ user: { id: USER, role }, params: { id: DEAL }, body: body() }, res);
    } finally { fake.restore(); }
    assert(!fake.calls.some(x => x.sql.startsWith("UPDATE leads SET")));
    assert(!fake.calls.some(x => x.sql.includes("INSERT INTO activity_logs")));
  });
}
