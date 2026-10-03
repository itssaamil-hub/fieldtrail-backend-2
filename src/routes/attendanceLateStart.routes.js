const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

function configurationError(message) {
  const error = new Error(message);
  error.status = 500;
  error.code = 'ATTENDANCE_CONFIGURATION_MISSING';
  return error;
}

router.use(requireAuth);
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/late-start-ui', async (req, res) => {
  const { rows } = await db.query(
    'SELECT show_late_start_banner FROM attendance_company_schedule WHERE id=1'
  );
  if (!rows[0]) throw configurationError('Attendance company schedule is missing.');
  res.json({ showLateStartBanner: rows[0].show_late_start_banner === true });
});

router.put('/late-start-ui', requireRole('admin'), async (req, res) => {
  const value = req.body?.showLateStartBanner;
  if (typeof value !== 'boolean') {
    const error = new Error('showLateStartBanner must be a boolean.');
    error.status = 400;
    throw error;
  }
  const { rows } = await db.query(
    `UPDATE attendance_company_schedule
       SET show_late_start_banner=$1,updated_at=now(),updated_by=$2
     WHERE id=1
     RETURNING show_late_start_banner`,
    [value, req.user.id]
  );
  if (!rows[0]) throw configurationError('Attendance company schedule is missing.');
  res.json({ ok: true, showLateStartBanner: rows[0].show_late_start_banner === true });
});

module.exports = router;
