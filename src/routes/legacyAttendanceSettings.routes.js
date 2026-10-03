const router = require('express').Router();

// Attendance V2 is the single canonical settings API. The old Day Closing
// attendance-settings endpoints are intentionally retired so no client can
// continue mutating the same attendance configuration through a second path.
router.use('/attendance-settings', (req, res) => {
  res.status(410).json({
    error: 'Legacy attendance settings API has been retired. Use Attendance V2.',
    canonicalPath: '/attendance-v2/settings',
  });
});

module.exports = router;
