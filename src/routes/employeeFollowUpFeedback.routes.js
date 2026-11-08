const router = require("express").Router();
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logActivity } = require("../utils/logging");
const { UUID, bad, requireCustomerFeedback } = require("../utils/employeeFollowUpFeedback");

router.use(requireAuth, requireRole("admin"));

router.get("/employees/:id/follow-up-feedback", async (req, res) => {
  if (!UUID.test(req.params.id)) throw bad("Invalid employee");
  const { rows } = await db.query("SELECT id FROM users WHERE id=$1 AND role='salesman'", [req.params.id]);
  if (!rows.length) throw bad("Employee not found", 404);
  const required = await requireCustomerFeedback(db.query, req.params.id);
  res.set("Cache-Control", "no-store");
  res.json({ requireCustomerFeedback: required });
});

router.put("/employees/:id/follow-up-feedback", async (req, res) => {
  if (!UUID.test(req.params.id)) throw bad("Invalid employee");
  if (typeof req.body?.requireCustomerFeedback !== "boolean") throw bad("Select ON or OFF for customer feedback.");
  const c = await db.pool.connect();
  try {
    await c.query("BEGIN");
    const { rows } = await c.query("SELECT id FROM users WHERE id=$1 AND role='salesman' FOR UPDATE", [req.params.id]);
    if (!rows.length) throw bad("Employee not found", 404);
    const before = await requireCustomerFeedback((sql, params) => c.query(sql, params), req.params.id);
    await c.query(`INSERT INTO employee_follow_up_settings(user_id, require_customer_feedback, updated_at)
                   VALUES($1,$2,now())
                   ON CONFLICT(user_id) DO UPDATE SET require_customer_feedback=$2, updated_at=now()`,
      [req.params.id, req.body.requireCustomerFeedback]);
    await c.query("COMMIT");
    if (before !== req.body.requireCustomerFeedback)
      await logActivity({ actorId: req.user.id, action: "settings.updated", entityType: "user", entityId: req.params.id,
        metadata: { setting: "requireCustomerFeedback", from: before, to: req.body.requireCustomerFeedback } });
    res.set("Cache-Control", "no-store");
    res.json({ requireCustomerFeedback: req.body.requireCustomerFeedback });
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally { c.release(); }
});

module.exports = router;
