// Resource boundary for admin-only Ask Engage. Never use the regular CRM pool here.
// The AI may only run prebuilt SELECT/CTE reports inside a read-only transaction.
// A separate, minimally-privileged ASK_ENGAGE_READONLY_DATABASE_URL can be added
// later without changing the rest of the application's database credentials.
const { Pool } = require("pg");

const MAX_ROWS = 100;
const TIME_BUDGET_MS = 3000;
const POOL_CONNECT_MS = 1000;

const pool = new Pool({
  connectionString: process.env.ASK_ENGAGE_READONLY_DATABASE_URL || process.env.DATABASE_URL,
  max: 1,
  idleTimeoutMillis: 1000,
  connectionTimeoutMillis: POOL_CONNECT_MS,
  query_timeout: 3500,
  application_name: "engage-ask-ai",
});
pool.on("error", () => console.warn("Ask Engage analytics database connection reset."));

let active = false;
let runtimeDisabled = false;

const failure = (message, status = 503) => Object.assign(new Error(message), { status });
const enabled = () => process.env.ASK_ENGAGE_ENABLED !== "false" &&
  process.env.ASK_ENGAGE_ENABLED !== "0" && !runtimeDisabled;

function status() {
  return { enabled: enabled(), busy: active, maxRows: MAX_ROWS,
    queryBudgetMs: TIME_BUDGET_MS, concurrencyLimit: 1 };
}

function setEnabled(shouldEnable) {
  if (typeof shouldEnable !== "boolean") throw failure("enabled must be a boolean.", 400);
  runtimeDisabled = !shouldEnable;
  return status();
}

function reserve() {
  if (!enabled()) throw failure("Ask Engage is disabled. All other CRM features are unaffected.");
  if (active) throw failure("Ask Engage is processing a question. Retry shortly.", 429);
  active = true;
  let released = false;
  return () => {
    if (!released) {
      active = false;
      released = true;
    }
  };
}

// Called ONLY after Gemini has classified a question and the request is reserved.
// Uses 1 connection outside the normal CRM pool and a cumulative 3-second DB
// budget across the whole question (including up to four report parts).
async function readOnlyTransaction(work, options = {}) {
  if (!enabled()) throw failure("Ask Engage is disabled. All other CRM features are unaffected.");
  const database = options.pool || pool;
  const clock = options.clock || Date.now;
  let client, transactionOpen = false, discard = false;
  try {
    client = await database.connect();
    await client.query("BEGIN TRANSACTION READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    await client.query("SET LOCAL lock_timeout = '250ms'");
    const deadline = clock() + TIME_BUDGET_MS;

    const query = async (text, parameters = []) => {
      if (!enabled()) throw failure("Ask Engage was disabled before its analytics query could execute.");
      if (typeof text !== "string" ||
        !/^\s*(?:SELECT|WITH)\b/i.test(text) || text.includes(";") ||
        !Array.isArray(parameters)) {
        throw failure("Ask Engage only permits approved read-only reporting queries.", 422);
      }
      const remaining = Math.floor(deadline - clock());
      if (remaining <= 0) throw failure("Ask Engage database time limit reached; CRM operations are unaffected.");
      await client.query("SET LOCAL statement_timeout = '" + remaining + "ms'");
      // All report queries are server-authored, never generated SQL from Gemini.
      // LIMIT 101 detects any report that exceeds the 100-row response cap.
      const boundedSql = "SELECT * FROM (" + text.trim() + ") AS ask_engage_bounded LIMIT 101";
      const result = await client.query(boundedSql, parameters);
      if (!Array.isArray(result.rows) || result.rows.length > MAX_ROWS) {
        throw failure("Ask Engage report exceeded its 100-row limit; narrow the question.", 422);
      }
      return result;
    };

    const output = await work(query);
    await client.query("ROLLBACK"); // discard transaction even on successful reads
    transactionOpen = false;
    return output;
  } catch (error) {
    if (transactionOpen && client) {
      try { await client.query("ROLLBACK"); }
      catch { discard = true; }
    }
    if (error.code === "57014" || error.code === "55P03") {
      throw failure("Ask Engage query was stopped to protect CRM performance.");
    }
    if (error.code?.startsWith?.("08") || /timeout/i.test(error.message || "")) {
      discard = true;
      throw failure("Ask Engage database connection timed out. Normal CRM operations remain available.");
    }
    throw error;
  } finally {
    if (client) client.release(discard);
  }
}

module.exports = { status, setEnabled, reserve, readOnlyTransaction, MAX_ROWS, TIME_BUDGET_MS };
