const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logActivity } = require("../utils/logging");
const {
  getDashboardComparisonData,
  getDisplaySettings,
  saveDisplaySettings,
} = require("../utils/dashboardComparisons");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

router.get("/settings", async (req, res) => {
  res.json({ displaySettings: await getDisplaySettings() });
});

router.patch("/settings", async (req, res) => {
  const displaySettings = await saveDisplaySettings(req.body || {}, req.user.id);
  await logActivity({
    actorId: req.user.id,
    action: "dashboard_display_settings.updated",
    entityType: "crm_settings",
    entityId: null,
    metadata: { displaySettings },
  });
  res.json({ displaySettings });
});

router.get("/", async (req, res) => {
  const salesmanId = req.query.salesmanId && req.query.salesmanId !== "all" ? req.query.salesmanId : null;
  if (salesmanId && !/^[0-9a-f-]{36}$/i.test(salesmanId)) {
    return res.status(400).json({ error: "Invalid employee" });
  }
  const result = await getDashboardComparisonData({
    role: "admin",
    userId: req.user.id,
    salesmanId,
    period: req.query.period,
  });
  res.json({ ...result, salesmanId: salesmanId || "all" });
});

module.exports = router;
