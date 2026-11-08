// Shared validation for Admin and Salesman Follow-up Log writes.
// The existing lead PATCH transaction saves the date and audit atomically.
const OUTCOMES = Object.freeze({
  interested: "Interested",
  callback_requested: "Callback requested",
  no_answer: "No answer",
  demo_requested: "Demo requested",
  pricing_concern: "Pricing concern",
  not_interested: "Not interested",
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function validDate(value) {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function parseFollowUpLog(body) {
  if (!has(body, "followUpLog")) return null;
  const raw = body.followUpLog;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("Invalid follow-up log.");
  if (!has(body, "nextFollowUpDate")) throw invalid("Select or clear the next follow-up date.");
  const date = body.nextFollowUpDate;
  if (date !== null && !validDate(date)) throw invalid("Select a valid next follow-up date.");
  const outcome = raw.outcome;
  if (!has(OUTCOMES, outcome)) throw invalid("Select a valid follow-up outcome.");
  const mode = raw.mode;
  if (mode !== "done" && mode !== "reschedule") throw invalid("Invalid follow-up action.");
  if (mode === "reschedule" && date === null) throw invalid("Choose the next follow-up date.");
  if (typeof raw.feedback !== "string") throw invalid("Enter customer feedback.");
  const feedback = raw.feedback.trim();
  if (feedback.length > 2000) throw invalid("Feedback cannot exceed 2000 characters.");
  if (outcome !== "no_answer" && !feedback) throw invalid("Record what the customer said.");
  if (typeof raw.requestId !== "string" || !UUID.test(raw.requestId)) throw invalid("Invalid follow-up request ID.");
  return { outcome, feedback, mode, requestId: raw.requestId };
}
module.exports = { parseFollowUpLog, OUTCOMES };
