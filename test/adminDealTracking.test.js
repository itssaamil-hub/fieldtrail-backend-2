const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const db = require("../src/db");
const router = require("../src/routes/adminDealTracking.routes");

const handler = router.stack.find(layer => layer.route?.path === "/")
  .route.stack.at(-1).handle;

test("Admin Deal Tracker has admin-only role guard and isolated mount", () => {
  const src = fs.readFileSync(require.resolve("../src/routes/adminDealTracking.routes"), "utf8");
  const app = fs.readFileSync(require.resolve("../src/app"), "utf8");
  assert.match(src, /router\.use\(requireAuth, requireRole\("admin"\)\)/);
  assert.match(app, /app\.use\("\/admin\/deal-tracking", require\("\.\/routes\/adminDealTracking\.routes"\)\)/);
});

test("Tracked deals query includes older records and excludes reassigned deals", async () => {
  const original = db.query;
  let sql = "", params = [];
  db.query = async (query, values) => {
    sql = query; params = values;
    return { rows: [{ id: "old-lead", business_name: "Older tracked deal" }] };
  };
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
  try {
    await handler({ user: { role: "admin" }, query: { month: "2026-11" } }, res);
  } finally { db.query = original; }
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.month, "2026-11");
  assert.equal(res.body.deals.length, 1);
  assert.deepEqual(params, ["2026-11-01"]);
  assert.match(sql, /f\.month_start = \$1::date/);
  assert.match(sql, /l\.salesman_id = f\.salesman_id/);
  assert.doesNotMatch(sql, /\bLIMIT\b|\bUPDATE\b|\bDELETE\b|\bINSERT\b/);
});

test("Invalid tracking month cannot reach the database", async () => {
  const original = db.query;
  let called = false;
  db.query = async () => { called = true; return { rows: [] }; };
  try {
    for (const month of ["2026-13", "2026-1", "x' OR 1=1", [], {}]) {
      const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
      await handler({ user: { role: "admin" }, query: { month } }, res);
      assert.equal(res.statusCode, 400);
    }
  } finally { db.query = original; }
  assert.equal(called, false);
});

test("Tracking calendar respects the first instant of India's new month", () => {
  assert.equal(router._test.currentIndiaMonth(new Date("2026-10-31T18:29:59Z")), "2026-10");
  assert.equal(router._test.currentIndiaMonth(new Date("2026-10-31T18:30:00Z")), "2026-11");
});


const DEAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const getHandler = method => router.stack.find(layer =>
  layer.route?.path === "/:leadId" && layer.route.methods[method.toLowerCase()]
)?.route.stack.at(-1).handle;
function makeResponse() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}
async function invoke(method, { month, query, body, replies = [] } = {}) {
  const original = db.query, calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    return replies[calls.length - 1] || { rows: [], rowCount: 0 };
  };
  const res = makeResponse();
  try {
    await getHandler(method)({
      user: { id: "test-admin", role: "admin" },
      params: { leadId: DEAL },
      query: query || (month ? { month } : {}),
      body: body || {},
    }, res);
  } finally { db.query = original; }
  return { res, calls };
}

test("Admin tracking read checks the CURRENT assignee, not a client-selected employee", async () => {
  const result = await invoke("GET", {
    month: "2026-11",
    replies: [{ rows: [{ salesman_id: "anand-id", tracked: true }] }],
  });
  assert.deepEqual(result.res.body, { month: "2026-11", tracked: true });
  assert.deepEqual(result.calls[0].params, [DEAL, "2026-11-01"]);
  assert.match(result.calls[0].sql, /f\.salesman_id = l\.salesman_id/);
  assert.doesNotMatch(result.calls[0].sql, /UPDATE leads|attendance|lead_status_history/i);
});

test("Admin addition is idempotent, takes employee ID only from the deal, and never changes status", async () => {
  const month = router._test.currentIndiaMonth();
  const added = await invoke("POST", {
    body: { month, salesmanId: "malicious-client-override" },
    replies: [{ rows: [{ lead_id: DEAL }], rowCount: 1 }],
  });
  assert.deepEqual(added.res.body, { ok: true, tracked: true });
  assert.deepEqual(added.calls[0].params, [DEAL, month + "-01"]);
  assert.match(added.calls[0].sql, /SELECT l\.salesman_id, \$2::date, l\.id FROM leads l/);
  assert.match(added.calls[0].sql, /ON CONFLICT .* DO NOTHING/);
  assert.doesNotMatch(added.calls[0].sql, /UPDATE leads|lead_status_history|attendance/i);

  const duplicate = await invoke("POST", {
    body: { month },
    replies: [{ rows: [], rowCount: 0 }, { rows: [{ "?column?": 1 }] }],
  });
  assert.equal(duplicate.res.statusCode, 200);
  const missing = await invoke("POST", {
    body: { month }, replies: [{ rows: [] }, { rows: [] }],
  });
  assert.equal(missing.res.statusCode, 404);
});

test("Admin removal affects ONLY current month's assigned employee tracking", async () => {
  const month = router._test.currentIndiaMonth();
  const removed = await invoke("DELETE", {
    month, replies: [{ rowCount: 1, rows: [] }],
  });
  assert.deepEqual(removed.res.body, { ok: true, tracked: false });
  assert.deepEqual(removed.calls[0].params, [DEAL, month + "-01"]);
  assert.match(removed.calls[0].sql, /DELETE FROM salesman_monthly_focus/);
  assert.match(removed.calls[0].sql, /l\.salesman_id = f\.salesman_id/);
  assert.doesNotMatch(removed.calls[0].sql, /DELETE FROM leads|lead_status_history|attendance/i);
});

test("Admin tracking mutations reject old month and invalid deal IDs before any writes", async () => {
  const previous = new Date(router._test.currentIndiaMonth() + "-01T00:00:00Z");
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const last = previous.toISOString().slice(0, 7);
  for (const method of ["POST", "DELETE"]) {
    const result = await invoke(method, {
      body: { month: last }, query: { month: last },
    });
    assert.equal(result.res.statusCode, 409);
    assert.equal(result.calls.length, 0);
  }
  const before = db.query;
  let touched = false;
  db.query = async () => { touched = true; return { rows: [] }; };
  try {
    for (const method of ["get", "post", "delete"]) {
      const res = makeResponse();
      await getHandler(method)({
        user: { role: "admin" }, params: { leadId: "SQL-injection" },
        body: {}, query: {},
      }, res);
      assert.equal(res.statusCode, 400);
    }
  } finally { db.query = before; }
  assert.equal(touched, false);
});
