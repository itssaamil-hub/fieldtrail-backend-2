const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const {
  parseFilters, parsePage, getSummary, getEvents,
} = require("../utils/stageMovementReport");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/", async (req, res) => {
  const filters = parseFilters(req.query);
  res.json(await getSummary(filters));
});

router.get("/events", async (req, res) => {
  const filters = parseFilters(req.query);
  const selection = parsePage(req.query);
  res.json(await getEvents(filters, selection));
});

router.use((err, _req, res, next) => {
  if (err.status === 400) return res.status(400).json({ error: err.message });
  next(err);
});

module.exports = router;
