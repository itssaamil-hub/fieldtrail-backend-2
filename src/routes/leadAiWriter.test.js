const test = require("node:test");
const assert = require("node:assert/strict");
const { _test: w } = require("./leadAiWriter.routes");
const sample = { business_name: "Brew & Bun Café", contact_name: "Rahul" };
test("template drafts are personalized, in requested language, and request the goal", () => {
  const r = w.fallbackDrafts(w.parseOptions({ language: "hinglish", type: "after", goal: "demo", notes: "Interested in inventory." }), sample);
  for (const key of ["short", "natural", "professional"]) {
    assert.match(r[key], /Rahul/); assert.match(r[key], /inventory/);
    assert.match(r[key], /demo/); assert.match(r[key], /Swirl.cx/);
  }
});
test("other language, goal and missing owner work", () => {
  const r = w.fallbackDrafts(w.parseOptions({ language: "hindi", type: "followup", goal: "pricing" }), { business_name: "Cafe", contact_name: null });
  assert.match(r.natural, /प्राइसिंग/); assert.match(r.natural, /Cafe/);
});
test("validation rejects unsupported options and oversized notes", () => {
  assert.throws(() => w.parseOptions({ goal: "free money" }), /Unsupported/);
  assert.throws(() => w.parseOptions({ notes: "a".repeat(1201) }), /too long/);
});
test("Gemini notes anonymize phone, email and URL; names never enter the prompt", () => {
  const s = w.anonymize("Contact +91 9899121234 at hi@brand.com see https://example.com and @rahul");
  assert.doesNotMatch(s, /9899121234|hi@brand|example.com|@rahul/);
});

test("uses logged-in salesman sign-off rather than another employee's name", () => {
  const r = w.fallbackDrafts(w.parseOptions({ language: "english" }), { ...sample, writer_name: "Anand Singh" });
  assert.match(r.natural, /Anand Singh/);
  assert.doesNotMatch(r.natural, /Aamil/);
  assert.notEqual(r.natural, r.professional);
});

test("valid UUID lead IDs pass AI Writer route validation", () => {
  // Reproduces a real production lead UUID structure.
  assert.equal(w.isValidLeadId("053ed41d-90f4-4da8-93ac-7f755c982b24"), true);
  assert.equal(w.isValidLeadId("12345678-ABCD-4abc-8DEF-1234567890ab"), true);
});
test("malformed lead IDs are rejected without querying leads", () => {
  assert.equal(w.isValidLeadId("12345678-1234-1234-123456789012"), false);
  assert.equal(w.isValidLeadId("not-a-lead"), false);
  assert.equal(w.isValidLeadId(""), false);
  assert.equal(w.isValidLeadId(undefined), false);
});
