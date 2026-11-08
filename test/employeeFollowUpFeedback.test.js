const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/db");
const router = require("../src/routes/employeeFollowUpFeedback.routes");
const { requireCustomerFeedback } = require("../src/utils/employeeFollowUpFeedback");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const handler = method => router.stack.find(layer =>
  layer.route?.path === "/employees/:id/follow-up-feedback" && layer.route.methods[method]
).route.stack.at(-1).handle;

function mockStore() {
  const initialQuery = db.query, initialConnect = db.pool.connect;
  const saved = new Map(), calls = [];
  const query = async (sql, args = []) => {
    calls.push({ sql, args });
    if (/SELECT id FROM users WHERE/.test(sql)) return { rows: [A, B].includes(args[0]) ? [{ id: args[0] }] : [] };
    if (/SELECT require_customer_feedback/.test(sql))
      return { rows: saved.has(args[0]) ? [{ require_customer_feedback: saved.get(args[0]) }] : [] };
    if (/INSERT INTO employee_follow_up_settings/.test(sql)) {
      saved.set(args[0], args[1]);
      return { rows: [] };
    }
    if (/INSERT INTO activity_logs/.test(sql)) return { rows: [] };
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    throw Error("Unexpected SQL: " + sql);
  };
  db.query = query;
  db.pool.connect = async () => ({ query, release() {} });
  return {
    saved, calls,
    restore() { db.query = initialQuery; db.pool.connect = initialConnect; },
  };
}
const res = () => ({
  headers: {},
  set(k,v) { this.headers[k] = v; return this; },
  json(data) { this.body = data; return this; },
});
const request = (id, requireCustomerFeedbackValue) => ({
  params: { id }, user: { id: ADMIN, role: "admin" },
  body: { requireCustomerFeedback: requireCustomerFeedbackValue },
});

test("Absent employee policy is ON by default", async () => {
  let calls = [];
  const read = async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
  assert.equal(await requireCustomerFeedback(read, A), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], A);
});

test("Admin can disable feedback for employee A without affecting B or attendance", async () => {
  const fake = mockStore();
  try {
    const put = res();
    await handler("put")(request(A, false), put);
    assert.deepEqual(put.body, { requireCustomerFeedback: false });
    assert.equal(put.headers["Cache-Control"], "no-store");
    const getA = res(), getB = res();
    await handler("get")(request(A), getA);
    await handler("get")(request(B), getB);
    assert.deepEqual(getA.body, { requireCustomerFeedback: false });
    assert.deepEqual(getB.body, { requireCustomerFeedback: true });
    assert.equal(fake.saved.size, 1);
    assert(fake.calls.some(x => x.sql.includes("INSERT INTO activity_logs")));
    assert(!fake.calls.some(x => /attendance|day_closing_permissions|UPDATE leads/i.test(x.sql)));
    const restore = res();
    await handler("put")(request(A, true), restore);
    assert.deepEqual(restore.body, { requireCustomerFeedback: true });
    assert.equal(fake.saved.get(A), true);
  } finally { fake.restore(); }
});

test("Admin toggle rejects malformed values or nonexistent employees without modifying data", async () => {
  const fake = mockStore();
  try {
    await assert.rejects(handler("put")(request(A, "false"), res()), { status: 400 });
    await assert.rejects(handler("put")(request("not-an-id", false), res()), { status: 400 });
    await assert.rejects(handler("put")(request(ADMIN, false), res()), { status: 404 });
    assert.equal(fake.saved.size, 0);
  } finally { fake.restore(); }
});
