const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ask = require("../src/routes/askEngage.routes")._test;
const reports = require("../src/utils/askEngageReports");

const plan = (intent, employee = "", period = "all") => ({ intent, employee, period });

test("How is Anand performance is a single-person report, not an all-employee leaderboard", () => {
  const p = ask.classifyEmployeePerformanceQuestion("how is anand performance");
  assert.deepEqual(p, plan("employee_performance", "anand"));
  assert.deepEqual(ask.classifyEmployeePerformanceQuestion("How is Anand's performance this month?"),
    plan("employee_performance", "anand", "this_month"));
  assert.deepEqual(ask.classifyEmployeePerformanceQuestion("How is Anand doing last week?"),
    plan("employee_performance", "anand", "last_week"));
  assert.deepEqual(ask.classifyEmployeePerformanceQuestion("Show Rahul Verma's sales performance"),
    plan("employee_performance", "rahul verma"));
  assert.deepEqual(ask.classifyEmployeePerformanceQuestion("How did Anand perform last month?"),
    plan("employee_performance", "anand", "last_month"));
});

test("Generic team rankings and unrelated questions keep their existing path", () => {
  for (const question of ["How is team performance?", "Show all employee performance",
    "How is overall performance?", "What is the total value of negotiations?",
    "How many deals did Anand add?", "Show pending payments",
    "Delete all leads", "Hiii"]) {
    assert.equal(ask.classifyEmployeePerformanceQuestion(question), null, question);
  }
  assert.deepEqual(ask.validatePlan(plan("employee_leaderboard")), plan("employee_leaderboard"));
  assert.deepEqual(ask.validatePlan(plan("employee_leaderboard", "Anand")),
    plan("employee_performance", "Anand"));
});

test("Named performance queries execute three fixed bounded read-only metrics", async () => {
  const seen = [];
  const read = async (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes("FROM users")) {
      return { rows: [{ id: "11111111-1111-4111-8111-111111111111", full_name: "Anand Kumar" }] };
    }
    if (sql.includes("FROM leads")) {
      return { rows: [{ count: 10, won: 3, negotiation: 4, valued_count: 8,
        total_value: "120000", avg_value: "15000" }] };
    }
    if (sql.includes("FROM crm_tasks")) return { rows: [{ open_tasks: 5, overdue: 2 }] };
    if (sql.includes("FROM visits")) return { rows: [{ count: 7 }] };
    throw Error("Unexpected query");
  };
  const output = await ask.executePlan(plan("employee_performance", "Anand", "this_month"), read);
  assert.equal(output.metric, "employee_performance");
  assert.equal(output.count, 10);
  assert.equal(output.conversion, 30);
  assert.match(output.answer, /Anand Kumar/);
  assert.match(output.answer, /3 currently Won \(30%/);
  assert.match(output.answer, /Negotiation/);
  assert.match(output.answer, /1,20,000/);
  assert.match(output.answer, /2 overdue/);
  assert.match(output.answer, /7/);
  assert.match(output.note, /not a historical cohort conversion/);
  assert.equal(seen.length, 4);
  assert.equal(seen[0].params[0], "Anand");
  for (const entry of seen.slice(1)) {
    assert.deepEqual(entry.params, ["11111111-1111-4111-8111-111111111111"]);
    assert.match(entry.sql, /date_trunc\('month'/);
    assert.match(entry.sql, /\$1/);
    assert.doesNotMatch(entry.sql, /\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
  }
});

test("No employee is never treated as an all-staff individual performance report", async () => {
  await assert.rejects(reports.answerExtra(plan("employee_performance"), null,
    async () => { throw Error("Database must not be called without a named employee"); },
    () => "TRUE"), error => error.status === 422 && /Specify an employee/.test(error.message));
});

test("Zero deals and missing values are not portrayed as positive performance", async () => {
  const result = await reports.answerExtra(plan("employee_performance", "Anand"), {
    id: "11111111-1111-4111-8111-111111111111", full_name: "Anand"
  }, async sql => {
    if (sql.includes("FROM leads")) return { rows: [{ count: 0, won: 0, negotiation: 0,
      valued_count: 0, total_value: "0", avg_value: null }] };
    if (sql.includes("FROM crm_tasks")) return { rows: [{ open_tasks: 0, overdue: 0 }] };
    if (sql.includes("FROM visits")) return { rows: [{ count: 0 }] };
    throw Error("Unexpected SQL");
  }, () => "TRUE");
  assert.equal(result.count, 0);
  assert.equal(result.conversion, 0);
  assert.match(result.answer, /not available/);
  assert.match(result.answer, /0 overdue/);
});

test("Existing admin-only Ask Engage route uses the local interpretation before Gemini", () => {
  const route = fs.readFileSync(require.resolve("../src/routes/askEngage.routes"), "utf8");
  assert.match(route, /router\.use\(requireAuth, requireRole\("admin"\)\)/);
  assert.match(route, /classifyEmployeePerformanceQuestion\(input.question\)/);
  assert.match(route, /const matchedPerformance = local\?\.kind === "plans"/);
  assert.match(route, /\? \{ requests: \[matchedPerformance\], localRule: true \}/);
  assert.match(route, /safety\.readOnlyTransaction\(query => executePlans\(requests, query\)\)/);
});
