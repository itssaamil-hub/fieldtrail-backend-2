const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_TYPES = new Set(['followup','hot','negotiation','renewal','payment','task','data','employee']);
const ALLOWED_SEVERITY = new Set(['low','medium','high','critical']);
const ALLOWED_STATUS = new Set(['open','snoozed','resolved']);

function normalizeCase(item) {
  const fingerprint = String(item.fingerprint || '').trim().slice(0, 240);
  const type = String(item.type || '').trim();
  const severity = String(item.severity || '').trim();
  const title = String(item.title || '').trim().slice(0, 180);
  const reason = String(item.reason || '').trim().slice(0, 500);
  const entityType = String(item.entityType || 'lead').trim().slice(0, 40);
  const entityId = item.entityId == null ? null : String(item.entityId).slice(0, 120);
  const entityName = String(item.entityName || 'Unknown').trim().slice(0, 180);
  const owner = item.owner == null ? null : String(item.owner).trim().slice(0, 180);
  const metadata = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata) ? item.metadata : {};
  if (!fingerprint || !ALLOWED_TYPES.has(type) || !ALLOWED_SEVERITY.has(severity) || !title || !reason || !entityName) return null;
  return { fingerprint, type, severity, title, reason, entityType, entityId, entityName, owner, metadata };
}

router.get('/', async (req, res) => {
  const status = req.query.status && req.query.status !== 'all' ? String(req.query.status) : null;
  if (status && !ALLOWED_STATUS.has(status)) return res.status(400).json({ error: 'Invalid status' });
  const assignedTo = req.query.assignedTo ? String(req.query.assignedTo) : null;
  if (assignedTo && assignedTo !== 'me' && !UUID.test(assignedTo)) return res.status(400).json({ error: 'Invalid assignee' });
  const params = [];
  const where = [];
  if (status) { params.push(status); where.push(`c.status = $${params.length}`); }
  if (assignedTo) { params.push(assignedTo === 'me' ? req.user.id : assignedTo); where.push(`c.assigned_to = $${params.length}::uuid`); }
  const { rows } = await db.query(
    `SELECT c.*, a.full_name AS assigned_to_name, r.full_name AS resolved_by_name
     FROM exception_cases c
     LEFT JOIN users a ON a.id = c.assigned_to
     LEFT JOIN users r ON r.id = c.resolved_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE c.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
              c.updated_at DESC
     LIMIT 1000`,
    params
  );
  res.json({ exceptions: rows });
});

router.post('/sync', async (req, res) => {
  const items = Array.isArray(req.body?.exceptions) ? req.body.exceptions.slice(0, 1000) : [];
  const client = await db.pool.connect();
  let synced = 0;
  try {
    await client.query('BEGIN');
    // A case remains in history even when the live condition disappears.
    await client.query(`UPDATE exception_cases SET active=false, updated_at=now() WHERE active=true`);
    for (const raw of items) {
      const item = normalizeCase(raw);
      if (!item) continue;
      synced += 1;
      await client.query(
        `INSERT INTO exception_cases
           (fingerprint,type,severity,title,reason,entity_type,entity_id,entity_name,owner_name,metadata,active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,true)
         ON CONFLICT (fingerprint) DO UPDATE SET
           type=EXCLUDED.type,severity=EXCLUDED.severity,title=EXCLUDED.title,reason=EXCLUDED.reason,
           entity_type=EXCLUDED.entity_type,entity_id=EXCLUDED.entity_id,entity_name=EXCLUDED.entity_name,
           owner_name=EXCLUDED.owner_name,metadata=EXCLUDED.metadata,active=true,last_seen_at=now(),updated_at=now(),
           status=CASE
             WHEN exception_cases.status='snoozed' AND exception_cases.snoozed_until <= now() THEN 'open'
             ELSE exception_cases.status
           END,
           snoozed_until=CASE
             WHEN exception_cases.status='snoozed' AND exception_cases.snoozed_until <= now() THEN NULL
             ELSE exception_cases.snoozed_until
           END`,
        [item.fingerprint,item.type,item.severity,item.title,item.reason,item.entityType,item.entityId,item.entityName,item.owner,JSON.stringify(item.metadata)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true, synced });
});

router.get('/settings', async (req, res) => {
  const { rows } = await db.query(`SELECT * FROM exception_settings WHERE id=1`);
  res.json({ settings: rows[0] });
});

router.put('/settings', async (req, res) => {
  const allowed = [
    'followup_enabled','hot_enabled','hot_stale_days','hot_critical_days','negotiation_enabled',
    'negotiation_stale_days','negotiation_critical_days','renewal_enabled','renewal_warning_days',
    'tasks_enabled','payments_enabled','data_quality_enabled'
  ];
  const values = [];
  const sets = [];
  for (const key of allowed) {
    if (req.body?.[key] == null) continue;
    values.push(req.body[key]);
    sets.push(`${key}=$${values.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'No settings supplied' });
  values.push(req.user.id);
  const { rows } = await db.query(
    `UPDATE exception_settings SET ${sets.join(',')}, updated_by=$${values.length}::uuid, updated_at=now() WHERE id=1 RETURNING *`,
    values
  );
  res.json({ settings: rows[0] });
});

router.get('/:id/history', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid exception' });
  const { rows } = await db.query(
    `SELECT e.*, u.full_name AS actor_name FROM exception_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.exception_id=$1 ORDER BY e.created_at DESC LIMIT 200`,
    [req.params.id]
  );
  res.json({ events: rows });
});

router.patch('/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid exception' });
  const action = String(req.body?.action || '').trim();
  const note = req.body?.note == null ? null : String(req.body.note).trim().slice(0, 800);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(`SELECT * FROM exception_cases WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Exception not found' }); }
    let row;
    if (action === 'resolve') {
      const r = await client.query(`UPDATE exception_cases SET status='resolved',resolved_at=now(),resolved_by=$2::uuid,resolution_note=$3,snoozed_until=NULL,updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, req.user.id, note]); row = r.rows[0];
    } else if (action === 'snooze') {
      const until = new Date(req.body?.until);
      if (Number.isNaN(until.getTime()) || until <= new Date()) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Choose a future snooze time' }); }
      const r = await client.query(`UPDATE exception_cases SET status='snoozed',snoozed_until=$2::timestamptz,resolved_at=NULL,resolved_by=NULL,resolution_note=NULL,updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, until]); row = r.rows[0];
    } else if (action === 'reopen') {
      const r = await client.query(`UPDATE exception_cases SET status='open',active=true,snoozed_until=NULL,resolved_at=NULL,resolved_by=NULL,resolution_note=NULL,reopened_count=reopened_count+1,updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id]); row = r.rows[0];
    } else if (action === 'assign') {
      const assignedTo = req.body?.assignedTo || null;
      if (assignedTo && !UUID.test(String(assignedTo))) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Invalid assignee' }); }
      const r = await client.query(`UPDATE exception_cases SET assigned_to=$2::uuid,updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, assignedTo]); row = r.rows[0];
    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid action' });
    }
    await client.query(`INSERT INTO exception_events(exception_id,action,actor_id,note,payload) VALUES($1,$2,$3,$4,$5::jsonb)`, [req.params.id, action, req.user.id, note, JSON.stringify(req.body || {})]);
    await client.query('COMMIT');
    res.json({ exception: row });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
