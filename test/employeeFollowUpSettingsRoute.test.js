const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/db");
const fs = require("node:fs");
const locationRouter = require("../src/routes/employeeLocationPolicy.routes");

const EMPLOYEE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMPLOYEE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function settingsHandler() {
  const route = locationRouter.stack.find(layer =>
    layer.route?.path === "/settings" && layer.route.methods.get);
  assert(route, "Authoritative /salesman/settings handler is missing");
  return route.route.stack.at(-1).handle;
}

async function fetchSettings(employeeId, configured = {}) {
  const originalQuery = db.query;
  const queries = [];
  db.query = async (sql, args = []) => {
    queries.push({ sql, args });
    if (sql.includes("FROM crm_settings ORDER BY")) return {
      rows: [{ lead_settings: { requireBusinessName: true },
        location_settings: { gpsLocation: false },
        message_settings: { employeeRepliesEnabled: true } }],
    };
    if (sql.includes("INSERT INTO employee_day_closing_permissions")) return { rows: [] };
    if (sql.includes("FROM employee_day_closing_permissions WHERE")) return {
      rows: [{ allow_lead_without_start_day: true }],
    };
    if (sql.includes("INSERT INTO employee_location_settings")) return { rows: [] };
    if (sql.includes("FROM employee_location_settings")) return {
      rows: [{ gps_location: false, location_mandatory_for_new_lead: true,
        continuous_gps_tracking: true, require_location_to_start_day: true,
        require_location_to_end_day: true, version: 3 }],
    };
    if (sql.includes("FROM employee_follow_up_settings WHERE")) return {
      rows: Object.prototype.hasOwnProperty.call(configured, employeeId)
        ? [{ require_customer_feedback: configured[employeeId] }] : [],
    };
    throw Error("Unexpected query: " + sql);
  };
  const res = { json(payload) { this.body = payload; return this; } };
  try {
    await settingsHandler()({ user: { id: employeeId, role: "salesman" } }, res);
    return { payload: res.body, queries };
  } finally {
    db.query = originalQuery;
  }
}

test("The actual first-mounted salesman/settings route exposes employee-specific feedback OFF", async () => {
  // The legacy salesman router also declares GET /settings but it is not reached:
  // the employee-specific Location Policy route is mounted ahead of it.
  const appSource = fs.readFileSync(require.resolve("../src/app"), "utf8");
  const policyMount = appSource.indexOf('app.use("/salesman", require("./routes/employeeLocationPolicy.routes"));');
  const legacyMount = appSource.indexOf('app.use("/salesman", salesmanRoutes);');
  assert(policyMount >= 0 && legacyMount > policyMount, "Employee-specific settings must mount before the legacy salesman router");

  const { payload, queries } = await fetchSettings(EMPLOYEE_A, { [EMPLOYEE_A]: false });
  assert.equal(payload.employeePermissions.requireCustomerFeedback, false);
  assert.equal(payload.employeePermissions.allowLeadWithoutStartDay, true);
  assert.equal(payload.locationSettings.gpsLocation, false);
  assert.equal(payload.locationSettings.requireLocationToStartDay, false);
  assert.equal(payload.locationSettings.requireLocationToEndDay, false);
  assert.equal(payload.messageSettings.employeeRepliesEnabled, true);
  const prefs = queries.find(q => q.sql.includes("FROM employee_follow_up_settings WHERE"));
  assert.deepEqual(prefs.args, [EMPLOYEE_A]);
  assert(queries.every(q => !/UPDATE leads|UPDATE attendance/i.test(q.sql)));
});

test("Same settings endpoint defaults to ON for other employees and missing policy rows", async () => {
  const configured = { [EMPLOYEE_A]: false, [EMPLOYEE_B]: true };
  const { payload: enabled } = await fetchSettings(EMPLOYEE_B, configured);
  assert.equal(enabled.employeePermissions.requireCustomerFeedback, true);
  const { payload: defaultOn } = await fetchSettings(EMPLOYEE_B);
  assert.equal(defaultOn.employeePermissions.requireCustomerFeedback, true);
});
