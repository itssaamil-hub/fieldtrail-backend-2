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
