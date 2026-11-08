// Defaults to the existing required follow-up feedback workflow for all employees.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
async function requireCustomerFeedback(query, employeeId) {
  const { rows } = await query(
    "SELECT require_customer_feedback FROM employee_follow_up_settings WHERE user_id=$1",
    [employeeId]
  );
  return rows[0]?.require_customer_feedback !== false;
}
module.exports = { UUID, bad, requireCustomerFeedback };
