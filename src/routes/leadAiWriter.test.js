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

test("Gemini error reasons are safe and actionable without exposing credentials", () => {
  assert.match(w.describeGeminiFailure(401), /API key/);
  assert.match(w.describeGeminiFailure(403), /project/i);
  assert.match(w.describeGeminiFailure(404), /model/);
  assert.match(w.describeGeminiFailure(429), /quota/);
  assert.match(w.describeGeminiFailure(503), /temporarily unavailable/);
  assert.doesNotMatch(w.describeGeminiFailure(403), /x-goog-api-key|sk-\w+/i);
});


function aiResponse(text, finishReason = "STOP") {
  return { candidates: [{ finishReason, content: { parts: [{ text }] } }] };
}
const validAiDrafts = {
  short: "Hi [[OWNER]], can we arrange a quick demo for [[BUSINESS]]? Regards, [[SENDER]] at Swirl.cx.",
  natural: "Hi [[OWNER]], I enjoyed our discussion about [[BUSINESS]]. Would a quick demo suit you? Regards, [[SENDER]] at Swirl.cx.",
  professional: "Hello [[OWNER]], thank you for discussing [[BUSINESS]]. Please let me know whether a brief demo would be convenient. Regards, [[SENDER]], Swirl.cx."
};

test("Gemini parser accepts three complete drafts and flags incomplete output", () => {
  assert.deepEqual(w.readGeminiResponse(aiResponse(JSON.stringify(validAiDrafts))).drafts, validAiDrafts);
  const incomplete = w.readGeminiResponse(aiResponse(JSON.stringify({ short: validAiDrafts.short })));
  assert.equal(incomplete.retryable, true);
  assert.equal(incomplete.drafts, null);
  const cutOff = w.readGeminiResponse(aiResponse("{", "MAX_TOKENS"));
  assert.equal(cutOff.retryable, true);
  assert.match(cutOff.failure, /token/i);
  const blocked = w.readGeminiResponse(aiResponse("", "SAFETY"));
  assert.equal(blocked.retryable, false);
});

test("Gemini uses a required JSON schema and retries truncated responses just once", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  const previousModel = process.env.GEMINI_MODEL;
  process.env.GEMINI_API_KEY = "test-only-not-a-real-key";
  process.env.GEMINI_MODEL = "gemini-test";
  const requests = [];
  global.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const result = requests.length === 1
      ? aiResponse('{"short":', "MAX_TOKENS")
      : aiResponse(JSON.stringify(validAiDrafts));
    return { ok: true, json: async () => result };
  };
  try {
    const result = await w.geminiDrafts(w.parseOptions({ useGemini: true, notes: "Inventory" }), {
      ...sample, writer_name: "Sales Agent"
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].generationConfig.maxOutputTokens, 2048);
    assert.equal(requests[1].generationConfig.maxOutputTokens, 3072);
    assert.equal(requests[0].generationConfig.responseMimeType, "application/json");
    assert.deepEqual(requests[0].generationConfig.responseSchema.required, ["short", "natural", "professional"]);
    assert.equal(result.failure, null);
    assert.match(result.drafts.natural, /Brew & Bun Café/);
    assert.match(result.drafts.natural, /Sales Agent/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previousModel;
  }
});

test("Gemini does not retry safety stops or API quota errors", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-only-not-a-real-key";
  let calls = 0;
  try {
    global.fetch = async () => {
      calls++;
      return { ok: true, json: async () => aiResponse("", "SAFETY") };
    };
    const safety = await w.geminiDrafts(w.parseOptions({}), sample);
    assert.equal(calls, 1);
    assert.equal(safety.drafts, null);
    global.fetch = async () => {
      calls++;
      return { ok: false, status: 429 };
    };
    const quota = await w.geminiDrafts(w.parseOptions({}), sample);
    assert.equal(calls, 2);
    assert.match(quota.failure, /quota|limit/i);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});
