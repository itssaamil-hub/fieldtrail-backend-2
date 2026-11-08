// Follow-up note corrections are append-only: original log and every revision remain intact.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });

function parseFollowUpNoteEdit(body, leadId, logId) {
  if (!UUID.test(String(leadId || "")) || !UUID.test(String(logId || ""))) throw invalid("Invalid follow-up entry.");
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.feedback !== "string")
    throw invalid("Enter valid customer feedback.");
  if (body.feedback.length > 2000) throw invalid("Feedback cannot exceed 2000 characters.");
  if (typeof body.requestId !== "string" || !UUID.test(body.requestId)) throw invalid("Invalid edit request ID.");
  return { feedback: body.feedback.trim(), requestId: body.requestId };
}

async function editFollowUpNote(client, { leadId, logId, userId, isAdmin, body }) {
  const { feedback, requestId } = parseFollowUpNoteEdit(body, leadId, logId);
  const { rows: leads } = await client.query(
    isAdmin ? "SELECT id, business_name FROM leads WHERE id=$1" :
      "SELECT id, business_name FROM leads WHERE id=$1 AND salesman_id=$2",
    isAdmin ? [leadId] : [leadId, userId]
  );
  if (!leads.length) throw invalid("Lead not found.", 404);
  // Lock the original entry to serialize revisions/retries for this single note.
  const { rows: logs } = await client.query(`
    SELECT id, actor_id, metadata FROM activity_logs
    WHERE id=$1 AND entity_id=$2 AND entity_type='lead' AND action='lead.follow_up_logged' FOR UPDATE
  `, [logId, leadId]);
  const original = logs[0];
  if (!original || (!isAdmin && String(original.actor_id) !== String(userId)))
    throw invalid("Follow-up entry not found.", 404);

  const outcome = original.metadata?.outcome;
  if (outcome !== "no_answer" && !feedback) throw invalid("Record what the customer said.");
  const { rows: retries } = await client.query(`
    SELECT metadata FROM activity_logs WHERE entity_type='lead' AND entity_id=$1
      AND action='lead.follow_up_feedback_edited'
      AND metadata->>'followUpLogId'=$2 AND metadata->>'requestId'=$3 LIMIT 1
  `, [leadId, logId, requestId]);
  if (retries.length) return { edited: false, feedback: retries[0].metadata.to, retry: true };
  const { rows: corrections } = await client.query(`
    SELECT metadata FROM activity_logs WHERE entity_type='lead' AND entity_id=$1
      AND action='lead.follow_up_feedback_edited' AND metadata->>'followUpLogId'=$2
    ORDER BY created_at DESC, id DESC LIMIT 1
  `, [leadId, logId]);
  const before = String(corrections[0]?.metadata?.to ?? original.metadata?.feedback ?? "");
  if (before === feedback) return { edited: false, feedback, unchanged: true };
  await client.query(`
    INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
    VALUES($1,'lead.follow_up_feedback_edited','lead',$2,$3::jsonb)
  `, [userId, leadId, JSON.stringify({
    followUpLogId: logId, from: before, to: feedback, requestId,
    businessName: leads[0].business_name
  })]);
  return { edited: true, feedback };
}
module.exports = { parseFollowUpNoteEdit, editFollowUpNote };
