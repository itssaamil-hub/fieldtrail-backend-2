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


test("AI Writer V2 defaults to English and prioritizes natural, human messaging", () => {
  const options = w.parseOptions({ notes: "Owner asked about inventory and recipe costing." });
  assert.equal(options.language, "english");
  const prompt = w.buildGeminiPrompt(options, sample, {
    writingInstructions: "Use a friendly one-to-one sales style.",
    companyKnowledge: "Verified POS: menu and billing.",
    examples: ["Hi [[OWNER]], happy to walk you through the setup."]
  });
  assert.match(prompt, /Write the natural draft FIRST/);
  assert.match(prompt, /short \(briefer\) and professional/);
  assert.match(prompt, /friendly one-to-one sales style/);
  assert.match(prompt, /Verified POS: menu and billing/);
  assert.match(prompt, /happy to walk you through/);
  assert.match(prompt, /Never invent product capabilities/);
  assert.match(prompt, /never pad to reach a word count/);
  assert.doesNotMatch(prompt, /Each 30-85 words|Sign off with \[\[SENDER\]\]/);
  assert.doesNotMatch(prompt, /Brew & Bun Café|Rahul/);
});

test("AI Writer V2 uses only non-identifying lead status/date and redacts known names in notes", () => {
  const lead = {
    ...sample, writer_name: "Anand Singh", status: "hot",
    next_follow_up_date: new Date("2026-11-05T00:00:00Z")
  };
  const options = w.parseOptions({
    useGemini: true,
    notes: "Rahul at Brew & Bun Café asked Anand Singh about inventory. Call +91 9899121234 or hi@brand.com."
  });
  const prompt = w.buildGeminiPrompt(options, lead, null);
  assert.match(prompt, /Current CRM stage .*hot/);
  assert.match(prompt, /Internal next follow-up date .*2026-11-05/);
  assert.match(prompt, /\[\[OWNER\]\]/);
  assert.match(prompt, /\[\[BUSINESS\]\]/);
  assert.match(prompt, /\[\[SENDER\]\]/);
  assert.doesNotMatch(prompt, /Rahul|Brew & Bun Café|Anand Singh|9899121234|hi@brand.com/);
  assert.deepEqual(w.safeLeadContext({status:"not_a_real_stage",next_follow_up_date:"abc"}), []);
  assert.doesNotMatch(w.buildGeminiPrompt(w.parseOptions({}), lead).split("What the salesperson")[1], /Rahul|Brew & Bun Café/);
});

test("AI Writer V2 prompt contract handles twelve realistic restaurant sales situations", () => {
  const situations = [
    { type: "first", goal: "demo", language: "english", tone: "respectful", notes: "Opening a new cafe and exploring billing workflow." },
    { type: "after", goal: "demo", language: "english", tone: "friendly", notes: "Owner asked to see inventory and recipe costing in a demo." },
    { type: "followup", goal: "decision", language: "english", tone: "respectful", notes: "Customer wants to discuss with their business partner." },
    { type: "after", goal: "pricing", language: "english", tone: "respectful", notes: "Budget is a concern. Requested verified pricing details." },
    { type: "followup", goal: "stay", language: "english", tone: "friendly", notes: "Owner is busy with festival season; avoid pushing." },
    { type: "after", goal: "trial", language: "english", tone: "respectful", notes: "Customer wants a trial only if available." },
    { type: "first", goal: "demo", language: "english", tone: "casual", notes: "New QSR exploring speed of service." },
    { type: "after", goal: "demo", language: "hinglish", tone: "respectful", notes: "Owner prefers Hinglish and asked about kitchen display." },
    { type: "followup", goal: "decision", language: "hinglish", tone: "friendly", notes: "Owner comparing with Petpooja and wants time." },
    { type: "after", goal: "pricing", language: "hindi", tone: "respectful", notes: "ग्राहक ने बिलिंग और कीमत के बारे में पूछा।" },
    { type: "followup", goal: "demo", language: "english", tone: "friendly", notes: "Owner missed a previous demo slot; don't assume a reschedule." },
    { type: "first", goal: "stay", language: "english", tone: "respectful", notes: "No prior conversation, just a polite introduction." }
  ];
  for (const situation of situations) {
    const options = w.parseOptions(situation);
    const prompt = w.buildGeminiPrompt(options, {
      business_name: "Brew & Bun Café", contact_name: "Rahul",
      status: "conversation", next_follow_up_date: "2026-11-06"
    });
    assert.ok(prompt.includes(situation.notes));
    assert.ok(prompt.includes("desired next step=" + situation.goal));
    assert.ok(prompt.includes("language=" + situation.language));
    assert.ok(prompt.includes("message type=" + situation.type));
    assert.match(prompt, /Never invent product capabilities/);
    assert.match(prompt, /Return ONLY a JSON object/);
    assert.doesNotMatch(prompt, /Brew & Bun Café|Rahul/);
  }
  assert.equal(situations.length, 12);
});
