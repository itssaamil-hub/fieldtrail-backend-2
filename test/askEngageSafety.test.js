const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const safety = require("../src/utils/askEngageSafety");

function mockDatabase(reply = { rows: [{ count: 1 }] }) {
  const statements = [];
  const releases = [];
  let results = reply;
  const client = {
    query: async (sql, parameters) => {
      statements.push({ sql, parameters });
      if (sql.startsWith("SELECT * FROM (")) {
        if (results instanceof Error) throw results;
        return results;
      }
      return { rows: [] };
    },
    release: (discard) => releases.push(discard)
  };
  return { statements, releases, pool: { connect: async () => client },
    setResult: value => { results = value; } };
}

test("Ask Engage safety allows one request, releases lock even on repeated cleanup", () => {
  const was = process.env.ASK_ENGAGE_ENABLED;
  delete process.env.ASK_ENGAGE_ENABLED;
  safety.setEnabled(true);
  try {
    const release = safety.reserve();
    assert.equal(safety.status().busy, true);
    assert.throws(() => safety.reserve(), error => error.status === 429);
    release();
    release();
    assert.equal(safety.status().busy, false);
    const next = safety.reserve();
    next();
  } finally {
    safety.setEnabled(true);
    if (was === undefined) delete process.env.ASK_ENGAGE_ENABLED;
    else process.env.ASK_ENGAGE_ENABLED = was;
  }
});

test("Feature flag and emergency switch disable Ask Engage independently", () => {
  const was = process.env.ASK_ENGAGE_ENABLED;
  delete process.env.ASK_ENGAGE_ENABLED;
  try {
    safety.setEnabled(false);
    assert.equal(safety.status().enabled, false);
    assert.throws(() => safety.reserve(), error => error.status === 503);
    safety.setEnabled(true);
    process.env.ASK_ENGAGE_ENABLED = "false";
    assert.equal(safety.status().enabled, false);
    assert.throws(() => safety.reserve(), /disabled/);
    assert.throws(() => safety.setEnabled("yes"), error => error.status === 400);
  } finally {
    safety.setEnabled(true);
    if (was === undefined) delete process.env.ASK_ENGAGE_ENABLED;
    else process.env.ASK_ENGAGE_ENABLED = was;
  }
});

test("Read-only analytics uses a separate connection, statement limits and rollback", async () => {
  const db = mockDatabase({ rows: [{ count: 5 }] });
  const result = await safety.readOnlyTransaction(async query => {
    const first = await query("SELECT count(*) AS count FROM leads WHERE status=$1", ["won"]);
    assert.equal(first.rows[0].count, 5);
    return { done: true };
  }, { pool: db.pool, clock: () => 100 });
  assert.deepEqual(result, { done: true });
  assert.equal(db.statements[0].sql, "BEGIN TRANSACTION READ ONLY");
  assert.ok(db.statements.some(s => /SET LOCAL statement_timeout = '3000ms'/.test(s.sql)));
  assert.ok(db.statements.some(s => /SET LOCAL lock_timeout = '250ms'/.test(s.sql)));
  assert.ok(db.statements.some(s => /AS ask_engage_bounded LIMIT 101/.test(s.sql)));
  assert.ok(db.statements.some(s => s.sql === "ROLLBACK"));
  assert.deepEqual(db.statements.find(s => s.sql.startsWith("SELECT * FROM (")).parameters, ["won"]);
  assert.deepEqual(db.releases, [false]);
});

test("SQL writes and multiple statements are rejected before reaching PostgreSQL", async () => {
  const db = mockDatabase();
  await assert.rejects(safety.readOnlyTransaction(async query => {
    await query("UPDATE leads SET status='won'");
  }, { pool: db.pool }), error => error.status === 422);
  assert.equal(db.statements.filter(s => s.sql.startsWith("SELECT * FROM (")).length, 0);
  assert.equal(db.statements.at(-1).sql, "ROLLBACK");
  const another = mockDatabase();
  await assert.rejects(safety.readOnlyTransaction(async query => {
    await query("SELECT 1; DELETE FROM leads");
  }, { pool: another.pool }), error => error.status === 422);
  assert.equal(another.statements.at(-1).sql, "ROLLBACK");
});

test("Excess results fail closed at 100 rows", async () => {
  const db = mockDatabase({ rows: Array.from({ length: 101 }, (_, i) => ({ index: i })) });
  await assert.rejects(safety.readOnlyTransaction(async query => {
    await query("SELECT id FROM leads");
  }, { pool: db.pool }), error => error.status === 422 && /100-row/.test(error.message));
  assert.equal(db.statements.at(-1).sql, "ROLLBACK");
});

test("Entire multi-part analysis has a shared 3-second deadline", async () => {
  const db = mockDatabase();
  let clock = 1000;
  await assert.rejects(safety.readOnlyTransaction(async query => {
    await query("SELECT count(*) FROM leads");
    clock = 4001;
    await query("SELECT count(*) FROM crm_tasks");
  }, { pool: db.pool, clock: () => clock }), error => error.status === 503 && /time limit/.test(error.message));
  assert.equal(db.statements.filter(s => s.sql.startsWith("SELECT * FROM (")).length, 1);
  assert.equal(db.statements.at(-1).sql, "ROLLBACK");
});

test("Postgres statement timeout cancels Ask Engage but does not touch the CRM writer", async () => {
  const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  const db = mockDatabase(timeout);
  await assert.rejects(safety.readOnlyTransaction(async query => {
    await query("SELECT count(*) FROM leads");
  }, { pool: db.pool }), error => error.status === 503 && /stopped/.test(error.message));
  assert.equal(db.statements.at(-1).sql, "ROLLBACK");
  const regular = fs.readFileSync(require.resolve("../src/db"), "utf8");
  const askSafety = fs.readFileSync(require.resolve("../src/utils/askEngageSafety"), "utf8");
  const app = fs.readFileSync(require.resolve("../src/app"), "utf8");
  assert.match(askSafety, /new Pool\(/);
  assert.match(askSafety, /max: 1/);
  assert.doesNotMatch(regular, /askEngageSafety|ASK_ENGAGE/);
  assert.match(app, /app\.use\("\/admin\/ask-engage"/);
});

test("Connection errors discard the AI connection and propagate no sensitive details", async () => {
  const err = Object.assign(new Error("connection timeout"), { code: "ETIMEDOUT" });
  const db = mockDatabase(err);
  await assert.rejects(safety.readOnlyTransaction(async query => {
    await query("SELECT count(*) FROM leads");
  }, { pool: db.pool }), error => error.status === 503 && /connection timed out/.test(error.message));
  assert.deepEqual(db.releases, [true]);
});

test("Ask Engage endpoints retain admin authorization and support independent control", () => {
  const src = fs.readFileSync(require.resolve("../src/routes/askEngage.routes"), "utf8");
  assert.match(src, /router\.use\(requireAuth, requireRole\("admin"\)\)/);
  assert.match(src, /router\.post\("\/ask"/);
  assert.match(src, /router\.post\("\/control"/);
  assert.match(src, /safety\.readOnlyTransaction\(query => executePlans\(requests, query\)\)/);
  assert.match(src, /finally\s*\{\s*release\(\)/);
});

test("Emergency disable prevents a pending Gemini request from issuing any database queries",async()=>{
  const before=process.env.ASK_ENGAGE_ENABLED;
  delete process.env.ASK_ENGAGE_ENABLED;
  const db=mockDatabase();
  try {
    safety.setEnabled(false);
    await assert.rejects(safety.readOnlyTransaction(async()=>{throw Error("unexpected");},
      {pool:db.pool}), /disabled/);
    assert.equal(db.statements.length,0);
    safety.setEnabled(true);
    await safety.readOnlyTransaction(async query=>{
      safety.setEnabled(false);
      await assert.rejects(query("SELECT 1"),/disabled before its analytics query/);
    },{pool:db.pool});
    assert.equal(db.statements.filter(x=>x.sql.startsWith("SELECT * FROM (")).length,0);
  } finally {
    safety.setEnabled(true);
    if(before===undefined)delete process.env.ASK_ENGAGE_ENABLED;else process.env.ASK_ENGAGE_ENABLED=before;
  }
});

test("Read-only transaction executes real bounded CTE SQL in PostgreSQL",async t=>{
  const {PGlite}=require("@electric-sql/pglite");
  const pg=new PGlite();
  t.after(()=>pg.close());
  await pg.exec("CREATE TABLE ai_test(id integer PRIMARY KEY,amount integer); INSERT INTO ai_test VALUES(1,10),(2,20);");
  const mockPool={connect:async()=>({query:pg.query.bind(pg),release:()=>{}})};
  const value=await safety.readOnlyTransaction(async query=>{
    const {rows}=await query("WITH totals AS (SELECT sum(amount) AS total FROM ai_test) SELECT total FROM totals");
    return Number(rows[0].total);
  },{pool:mockPool});
  assert.equal(value,30);
  assert.equal((await pg.query("SELECT count(*)::int AS count FROM ai_test")).rows[0].count,2);
});
