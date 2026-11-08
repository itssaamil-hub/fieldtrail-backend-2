const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFollowUpNoteEdit, editFollowUpNote } = require("../src/utils/followUpNoteEdit");

const LEAD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const REQUEST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function client({ owned = true, originalActor = USER, corrections = [], outcome = "interested" } = {}) {
  const queries = [], revisions = [...corrections];
  return {
    queries, revisions,
    async query(sql, args) {
      queries.push({ sql, args });
      if (sql.startsWith("SELECT id, business_name FROM leads")) {
        return { rows: owned ? [{ id: LEAD, business_name: "Test cafe" }] : [] };
      }
      if (sql.includes("action='lead.follow_up_logged' FOR UPDATE"))
        return { rows: [{ id: LOG, actor_id: originalActor, metadata: { outcome, feedback: "Customer wants demo" } }] };
      if (sql.includes("metadata->>'requestId'=$3"))
        return { rows: revisions.filter(r => r.requestId === args[2]).map(r => ({ metadata: r })) };
      if (sql.includes("ORDER BY created_at DESC"))
        return { rows: revisions.length ? [{ metadata: revisions.at(-1) }] : [] };
      if (sql.includes("INSERT INTO activity_logs")) {
        revisions.push(JSON.parse(args[2]));
        return { rows: [] };
      }
      throw Error("Unexpected SQL " + sql);
    }
  };
}

const input = (feedback = "Customer wants another demo") => ({ feedback, requestId: REQUEST });

test("Follow-up note edits require a valid note, bounded text, and idempotency ID", () => {
  assert.equal(parseFollowUpNoteEdit(input(), LEAD, LOG).feedback, input().feedback);
  assert.throws(() => parseFollowUpNoteEdit({ feedback: "x".repeat(2001), requestId: REQUEST }, LEAD, LOG), { status: 400 });
  assert.throws(() => parseFollowUpNoteEdit({ feedback: 123, requestId: REQUEST }, LEAD, LOG), { status: 400 });
  assert.throws(() => parseFollowUpNoteEdit({ feedback: "hi", requestId: "bad" }, LEAD, LOG), { status: 400 });
  assert.throws(() => parseFollowUpNoteEdit(input(), "invalid", LOG), { status: 400 });
});

test("Salesman may edit their own feedback, and edits append audit only", async () => {
  const c = client();
  const result = await editFollowUpNote(c, { leadId: LEAD, logId: LOG, userId: USER, isAdmin: false, body: input() });
  assert.deepEqual(result, { edited: true, feedback: input().feedback });
  assert.equal(c.revisions.length, 1);
  assert.equal(c.revisions[0].from, "Customer wants demo");
  assert.equal(c.revisions[0].to, input().feedback);
  assert.equal(c.revisions[0].followUpLogId, LOG);
  assert(!c.queries.some(q => /UPDATE|DELETE|next_follow_up_date|attendance/i.test(q.sql)));
  assert(c.queries.find(q => q.sql.includes("FOR UPDATE")));
  assert(c.queries.find(q => q.sql.includes("salesman_id=$2")));
});

test("Salesman cannot edit other employee's note, including on an owned deal", async () => {
  const c = client({ originalActor: OTHER });
  await assert.rejects(editFollowUpNote(c, { leadId: LEAD, logId: LOG, userId: USER, isAdmin: false, body: input() }), { status: 404 });
  assert.equal(c.revisions.length, 0);
});

test("Salesman cannot edit another employee's deal", async () => {
  const c = client({ owned: false });
  await assert.rejects(editFollowUpNote(c, { leadId: LEAD, logId: LOG, userId: USER, isAdmin: false, body: input() }), { status: 404 });
  assert.equal(c.revisions.length, 0);
});

test("Admin can correct another employee's note without altering original activity", async () => {
  const c = client({ originalActor: OTHER });
  await editFollowUpNote(c, { leadId: LEAD, logId: LOG, userId: USER, isAdmin: true, body: input() });
  assert.equal(c.revisions.length, 1);
  assert.equal(c.queries[0].args.length, 1);
});

test("A repeated request is idempotent and does not create duplicate edits", async () => {
  const c = client();
  const args = { leadId: LEAD, logId: LOG, userId: USER, isAdmin: false, body: input() };
  await editFollowUpNote(c, args);
  const retried = await editFollowUpNote(c, args);
  assert.deepEqual(retried, { edited: false, feedback: input().feedback, retry: true });
  assert.equal(c.revisions.length, 1);
});

test("Subsequent edit retains previous correction as audit history", async () => {
  const c = client();
  await editFollowUpNote(c, { leadId: LEAD, logId: LOG, userId: USER, isAdmin: false, body: input("First correction") });
  const nextRequest = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  await editFollowUpNote(c, { leadId: LEAD, logId: LOG, userId: USER, isAdmin: false, body: { feedback: "Second correction", requestId: nextRequest } });
  assert.equal(c.revisions.length, 2);
  assert.equal(c.revisions[1].from, "First correction");
  assert.equal(c.revisions[1].to, "Second correction");
});

test("Non No-Answer follow-up keeps feedback mandatory; No-Answer permits blank correction", async () => {
  const invalid = client();
  await assert.rejects(editFollowUpNote(invalid, { leadId: LEAD, logId: LOG, userId: USER, isAdmin: false, body: input("") }), { status: 400 });
  const c = client({ outcome: "no_answer" });
  await editFollowUpNote(c, { leadId: LEAD, logId: LOG, userId: USER, isAdmin: false, body: input("") });
  assert.equal(c.revisions[0].to, "");
});
