const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getPerformanceReport, getDataHealth } = require('../utils/performanceV2Strong');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));
router.use((req,res,next)=>{ res.set('Cache-Control','no-store'); next(); });

router.get('/', async (req, res) => {
  try {
    const report = await getPerformanceReport(db.query, {
      from: req.query.from,
      to: req.query.to,
      salesmanId: req.query.salesmanId || null,
    });
    res.json(report);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.get('/health', async (req, res) => {
  res.json(await getDataHealth(db.query));
});

module.exports = router;
