const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logActivity } = require("../utils/logging");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/employees/:id/device-policy", async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid employee" });
  const { rows } = await db.query(
    "SELECT device_access_policy AS policy, device_access_version AS version FROM users WHERE id=$1 AND role='salesman'",
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Employee not found" });
  res.json({ policy: rows[0].policy, version: rows[0].version });
});

router.put("/employees/:id/device-policy", async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid employee" });
  const { policy, version } = req.body || {};
  if (!["both", "mobile_only"].includes(policy) || !Number.isInteger(version) || version < 0) {
    return res.status(400).json({ error: "Invalid device policy or version" });
  }
  const { rows } = await db.query(
    `UPDATE users
        SET device_access_policy=$1, device_access_version=device_access_version+1
      WHERE id=$2 AND role='salesman' AND device_access_version=$3
    RETURNING device_access_policy AS policy, device_access_version AS version`,
    [policy, req.params.id, version]
  );
  if (!rows[0]) {
    const check = await db.query("SELECT id FROM users WHERE id=$1 AND role='salesman'", [req.params.id]);
    return res.status(check.rows.length ? 409 : 404).json({
      error: check.rows.length ? "Device access changed. Reload before saving." : "Employee not found",
    });
  }
  await logActivity({
    actorId: req.user.id, action: "employee.device_access_updated",
    entityType: "user", entityId: req.params.id,
    metadata: { policy, version: rows[0].version },
  });
  res.json(rows[0]);
});

module.exports = router;
