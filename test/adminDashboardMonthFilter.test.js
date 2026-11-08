const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/db");
const { getAdminDashboardMonthMetrics } = require("../src/utils/dashboardComparisons");
const leadRouter = require("../src/routes/adminLeadPagination.routes");
const monthRouter = require("../src/routes/dashboardComparisons.routes");

function response() {
  return { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; } };
}
const leadHandler = leadRouter.stack.find(x => x.route?.path === "/leads" && x.route.methods.get).route.stack[0].handle;
const monthHandler = monthRouter.stack.find(x => x.route?.path === "/month" && x.route.methods.get).route.stack[0].handle;
const USER = "11111111-1111-4111-8111-111111111111";
const exampleMetrics = { total: 19, hot: 4, conversation: 5, negotiation: 3,
  negotiation_value: "45000", won: 2, won_value: "28000" };

test("IST month boundaries, employee scope, stage-entry and canonical Won dates", async () => {
  const calls = [];
  const result = await getAdminDashboardMonthMetrics({
    salesmanId: USER, month: "2026-10",
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [exampleMetrics] }; }
  });
  assert.equal(result.month, "2026-10");
  assert.deepEqual(result.metrics, { total: 19, hot: 4, conversation: 5,
    negotiation: 3, negotiationValue: 45000, won: 2, wonValue: 28000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], USER);
  assert.equal(calls[0].params[1].toISOString(), "2026-09-30T18:30:00.000Z");
  assert.equal(calls[0].params[2].toISOString(), "2026-10-31T18:30:00.000Z");
  assert.match(calls[0].sql, /h\.new_status = l\.status/);
  assert.match(calls[0].sql, /ORDER BY h\.changed_at DESC, h\.id DESC/);
  assert.match(calls[0].sql, /won\.occurred_at AS first_won_at/);
  assert.match(calls[0].sql, /status = 'won' AND first_won_at/);
  assert.match(calls[0].sql, /status = 'hot' AND last_stage_entry/);
  assert.match(calls[0].sql, /status = 'conversation' AND last_stage_entry/);
  assert.match(calls[0].sql, /status = 'negotiation' AND last_stage_entry/);
});

test("invalid months are rejected before any SQL query", async () => {
  for (const month of [undefined, "", "all", "2026-00", "2026-13", "2026-1", "2026-10;DROP TABLE leads", "1999-01"]) {
    let called = false;
    await assert.rejects(() => getAdminDashboardMonthMetrics({ month,
      query: async () => { called = true; return { rows: [] }; } }), /Invalid dashboard month/);
    assert.equal(called, false);
  }
});

test("Admin dashboard month endpoint preserves employee scope and validates input", async () => {
  const old = db.query;
  const calls = [];
  db.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [exampleMetrics] }; };
  try {
    const res = response();
    await monthHandler({ query: { month: "2026-11", salesmanId: USER } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.month, "2026-11");
    assert.equal(res.body.metrics.won, 2);
    assert.equal(calls[0].params[0], USER);
    const invalid = response();
    await monthHandler({ query: { month: "2026-11", salesmanId: "invalid-id" } }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.equal(calls.length, 1);
  } finally {
    db.query = old;
  }
});

test("monthly drill-down uses exactly the same month and stage definitions", async () => {
  const old = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT count\(\*\)::int AS total/.test(sql)) return { rows: [{ total: 1 }] };
    return { rows: [{ id: "1" }] };
  };
  try {
    for (const status of [undefined, "hot", "conversation", "negotiation", "won"]) {
      const r = response();
      await leadHandler({ query: { dashboardMonth: "2026-10", ...(status ? { status } : {}), salesmanId: USER, page: "1", limit: "100" } }, r);
      assert.equal(r.statusCode, 200);
      assert.equal(r.body.total, 1);
      const queries = calls.splice(0);
      assert.equal(queries.length, 2);
      for (const { sql, params } of queries) {
        assert.equal(params[0], USER);
        assert.equal(params[status ? 2 : 1], "2026-10");
        if (status === "won") assert.match(sql, /lead_stage_milestones m/);
        else if (status) assert.match(sql, /h\.new_status = l\.status/);
        else assert.ok(!sql.includes("lead_status_history"));
        assert.match(sql, /AT TIME ZONE 'Asia\/Kolkata'/);
      }
    }
    for (const bad of [
      {dashboardMonth:"all"}, {dashboardMonth:"2026-13"},
      {dashboardMonth:"2026-11",status:"cold"},
      {dashboardMonth:"2026-11",negotiationPeriod:"month",status:"negotiation"},
    ]) {
      const r=response();
      await leadHandler({query:bad},r);
      assert.equal(r.statusCode,400);
    }
    assert.equal(calls.length, 0);
  } finally {
    db.query = old;
  }
});
