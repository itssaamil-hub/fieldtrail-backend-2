const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/leads/:id/history', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Invalid lead' });
  const exists = await db.query('SELECT id FROM leads WHERE id=$1', [req.params.id]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'Lead not found' });

  const { rows } = await db.query(
    `SELECT a.id, a.action,
            a.metadata->>'from' AS old_value,
            a.metadata->>'to' AS new_value,
            CASE WHEN a.action='lead.status_changed' THEN a.metadata->>'from' END AS old_status,
            CASE WHEN a.action='lead.status_changed' THEN a.metadata->>'to' END AS new_status,
            a.metadata->'changes' AS changes,
            a.metadata->>'body' AS message_body,
            a.metadata->>'recipientName' AS recipient_name,
            a.metadata->>'messageId' AS message_id,
            a.created_at AS changed_at,
            COALESCE(u.full_name, 'Former user') AS changed_by_name
     FROM activity_logs a
     LEFT JOIN users u ON u.id=a.actor_id
     WHERE a.entity_type='lead' AND a.entity_id=$1
       AND a.action IN ('lead.created','lead.created_by_admin','lead.status_changed',
                        'lead.follow_up_scheduled','lead.follow_up_rescheduled','lead.follow_up_done',
                        'lead.comment_updated','lead.edited','lead.won_date_changed',
                        'lead.admin_mention','lead.employee_reply')
       AND (
         a.action NOT IN ('lead.admin_mention','lead.employee_reply')
         OR NOT EXISTS (
           SELECT 1 FROM messages dm
           WHERE dm.id::text=a.metadata->>'messageId' AND dm.deleted_at IS NOT NULL
         )
       )
     ORDER BY a.created_at ASC`,
    [req.params.id]
  );
  res.json({ history: rows });
});

module.exports = router;
