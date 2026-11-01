const express = require("express");
const crypto = require("node:crypto");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const training = require("../utils/aiWriterTraining");
const writer = require("./leadAiWriter.routes")._training;
const conversation = require("./aiWriterConversation.routes")._test;

const router = express.Router();
router.use(requireAuth);
const admin = requireRole("admin");

router.get("/config", admin, async (_req, res) => {
  const { rows } = await db.query(
    "SELECT company_knowledge,writing_instructions,updated_at FROM ai_writer_training_config WHERE id=1"
  );
  res.json({ settings: rows[0] || { company_knowledge: "", writing_instructions: "", updated_at: null } });
});

router.put("/config", admin, async (req, res) => {
  const settings = training.validateSettings(req.body);
  const { rows } = await db.query(
    `UPDATE ai_writer_training_config
     SET company_knowledge=$1,writing_instructions=$2,updated_by=$3,updated_at=now()
     WHERE id=1 RETURNING company_knowledge,writing_instructions,updated_at`,
    [settings.company_knowledge, settings.writing_instructions, req.user.id]
  );
  if (!rows[0]) throw training.bad("AI training settings are not initialized.", 503);
  res.json({ settings: rows[0] });
});

router.get("/examples", admin, async (req, res) => {
  const status = req.query.status || "all";
  const offset = Number(req.query.offset || 0);
  if (!["all", "pending", "approved", "rejected"].includes(status) ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) {
    throw training.bad("Invalid example filter.");
  }
  const { rows } = await db.query(
    `SELECT e.id,e.message,e.language,e.message_type,e.goal,e.tone,e.status,
            e.created_at,e.reviewed_at,u.full_name AS submitted_by_name
     FROM ai_writer_training_examples e
     JOIN users u ON u.id=e.submitted_by
     WHERE ($1::text='all' OR e.status=$1)
     ORDER BY e.created_at DESC,e.id DESC LIMIT 51 OFFSET $2`,
    [status, offset]
  );
  res.json({ examples: rows.slice(0, 50), hasMore: rows.length > 50 });
});

// An employee can submit a sample ONLY from one of their own leads.
// All CRM-derived examples require admin review, even when submitted by admin.
router.post("/examples", async (req, res) => {
  const values = training.validateExample(req.body);
  const leadId = req.body?.leadId;
  let lead = {};
  let status = "approved";
  if (leadId != null) {
    if (!training.UUID.test(leadId)) throw training.bad("Invalid lead ID.");
    const { rows } = await db.query(
      "SELECT business_name,contact_name,salesman_id FROM leads WHERE id=$1", [leadId]
    );
    if (!rows[0] || (req.user.role === "salesman" && rows[0].salesman_id !== req.user.id)) {
      throw training.bad("Lead not found.", 404);
    }
    lead = rows[0];
    status = "pending";
  } else if (req.user.role !== "admin") {
    throw training.bad("A lead ID is required.", 400);
  }
  if (!["admin", "salesman"].includes(req.user.role)) throw training.bad("Access denied.", 403);
  const user = await db.query("SELECT full_name FROM users WHERE id=$1", [req.user.id]);
  const message = training.anonymizeExample(values.message, lead, user.rows[0]?.full_name);
  const { rows } = await db.query(
    `INSERT INTO ai_writer_training_examples
      (id,message,language,message_type,goal,tone,status,submitted_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id,status,message`,
    [crypto.randomUUID(), message, values.language, values.type, values.goal,
      values.tone, status, req.user.id]
  );
  res.status(201).json({ example: rows[0] });
});

router.patch("/examples/:id", admin, async (req, res) => {
  if (!training.UUID.test(req.params.id)) throw training.bad("Invalid example ID.");
  if (!["approved", "rejected"].includes(req.body?.status)) throw training.bad("Invalid review decision.");
  const { rows } = await db.query(
    `UPDATE ai_writer_training_examples
     SET status=$2,reviewed_by=$3,reviewed_at=now()
     WHERE id=$1 RETURNING id,status`,
    [req.params.id, req.body.status, req.user.id]
  );
  if (!rows[0]) throw training.bad("Example not found.", 404);
  res.json({ example: rows[0] });
});

router.delete("/examples/:id", admin, async (req, res) => {
  if (!training.UUID.test(req.params.id)) throw training.bad("Invalid example ID.");
  const { rowCount } = await db.query(
    "DELETE FROM ai_writer_training_examples WHERE id=$1", [req.params.id]
  );
  if (!rowCount) throw training.bad("Example not found.", 404);
  res.json({ ok: true });
});

// Admin-only, lead-free preview using the exact one-message Gemini writer.
// No CRM lead is queried, and neither the request nor the result is stored.
router.post("/test", admin, async (req, res) => {
  const body = req.body || {};
  const options = conversation.conversationOptions({
    ...body,
    instruction: body.instruction ?? "",
    useGemini: true
  });
  if (!options.notes && !options.instruction) throw training.bad("Enter a test scenario or instruction.");
  writer.rateLimit(req.user.id);
  const context = await training.getPromptContext(db.query, options);
  const lead = { contact_name: "Sir", business_name: "your restaurant", writer_name: "Sales Team" };
  const message = await conversation.generateConversationMessage(options, lead, context);
  res.json({ message, source: "gemini" });
});
module.exports = router;
