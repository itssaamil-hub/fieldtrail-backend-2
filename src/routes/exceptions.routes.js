const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildDetections, loadDetectionSources } = require('../utils/exceptionDetection');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_TYPES = new Set(['followup','hot','negotiation','renewal','payment','task','data','employee']);
const ALLOWED_SEVERITY = new Set(['low','medium','high','critical']);
const ALLOWED_STATUS = new Set(['open','snoozed','resolved']);
const BOOLEAN_RULES = ['followup_enabled','hot_enabled','negotiation_enabled','renewal_enabled','tasks_enabled','payments_enabled','data_quality_enabled'];
const NUMBER_RULES = {
  hot_stale_days:[1,90], hot_critical_days:[1,180], negotiation_stale_days:[1,90],
  negotiation_critical_days:[1,180], renewal_warning_days:[1,180],
};

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

async function syncCases(client, rawItems) {
  const items=rawItems.map(normalizeCase).filter(Boolean);
  const existingResult=await client.query(`SELECT id,fingerprint,status,active,snoozed_until FROM exception_cases FOR UPDATE`);
  const existing=new Map(existingResult.rows.map(row=>[row.fingerprint,row]));
  await client.query(`UPDATE exception_cases SET active=false,updated_at=now() WHERE active=true`);
  let synced=0;
  for (const item of items) {
    synced += 1;
    const old=existing.get(item.fingerprint);
    if (!old) {
      await client.query(`INSERT INTO exception_cases
        (fingerprint,type,severity,title,reason,entity_type,entity_id,entity_name,owner_name,metadata,active)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,true)`,
        [item.fingerprint,item.type,item.severity,item.title,item.reason,item.entityType,item.entityId,item.entityName,item.owner,JSON.stringify(item.metadata)]);
      continue;
    }
    const expiredSnooze=old.status==='snoozed' && old.snoozed_until && new Date(old.snoozed_until)<=new Date();
    const returnedResolved=old.status==='resolved' && old.active===false;
    const status=expiredSnooze||returnedResolved?'open':old.status;
    const clearWorkflow=expiredSnooze||returnedResolved;
    const updated=await client.query(`UPDATE exception_cases SET
      type=$2,severity=$3,title=$4,reason=$5,entity_type=$6,entity_id=$7,entity_name=$8,owner_name=$9,metadata=$10::jsonb,
      active=true,last_seen_at=now(),updated_at=now(),status=$11,
      snoozed_until=CASE WHEN $12 THEN NULL ELSE snoozed_until END,
      resolved_at=CASE WHEN $12 THEN NULL ELSE resolved_at END,
      resolved_by=CASE WHEN $12 THEN NULL ELSE resolved_by END,
      resolution_note=CASE WHEN $12 THEN NULL ELSE resolution_note END,
      reopened_count=reopened_count+CASE WHEN $13 THEN 1 ELSE 0 END
      WHERE fingerprint=$1 RETURNING id`,
      [item.fingerprint,item.type,item.severity,item.title,item.reason,item.entityType,item.entityId,item.entityName,item.owner,JSON.stringify(item.metadata),status,clearWorkflow,returnedResolved]);
    if (returnedResolved && updated.rows[0]) {
      await client.query(`INSERT INTO exception_events(exception_id,action,note,payload) VALUES($1,'auto_reopen',$2,$3::jsonb)`,
        [updated.rows[0].id,'Issue returned after it had disappeared.',JSON.stringify({fingerprint:item.fingerprint})]);
    }
  }
  return synced;
}

function validateSettings(current, body) {
  const next={...current};
  for (const key of BOOLEAN_RULES) {
    if (body?.[key] == null) continue;
    if (typeof body[key] !== 'boolean') return {error:`${key} must be true or false`};
    next[key]=body[key];
  }
  for (const [key,[min,max]] of Object.entries(NUMBER_RULES)) {
    if (body?.[key] == null) continue;
    const n=Number(body[key]);
    if (!Number.isInteger(n) || n<min || n>max) return {error:`${key} must be a whole number between ${min} and ${max}`};
    next[key]=n;
  }
  if (Number(next.hot_critical_days)<Number(next.hot_stale_days)) return {error:'Hot critical threshold must be the same as or later than the warning threshold'};
  if (Number(next.negotiation_critical_days)<Number(next.negotiation_stale_days)) return {error:'Negotiation critical threshold must be the same as or later than the warning threshold'};
  return {next};
}

router.get('/', async (req, res) => {
  const status = req.query.status && req.query.status !== 'all' ? String(req.query.status) : null;
  if (status && !ALLOWED_STATUS.has(status)) return res.status(400).json({ error: 'Invalid status' });
  const assignedTo = req.query.assignedTo ? String(req.query.assignedTo) : null;
  if (assignedTo && assignedTo !== 'me' && !UUID.test(assignedTo)) return res.status(400).json({ error: 'Invalid assignee' });
  const params = [], where = [];
  if (status) { params.push(status); where.push(`c.status = $${params.length}`); }
  if (assignedTo) { params.push(assignedTo === 'me' ? req.user.id : assignedTo); where.push(`c.assigned_to = $${params.length}::uuid`); }
  const { rows } = await db.query(`SELECT c.*,a.full_name AS assigned_to_name,r.full_name AS resolved_by_name
    FROM exception_cases c LEFT JOIN users a ON a.id=c.assigned_to LEFT JOIN users r ON r.id=c.resolved_by
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE c.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,c.updated_at DESC LIMIT 1000`,params);
  res.json({ exceptions: rows });
});

router.post('/refresh', async (req,res) => {
  const client=await db.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const source=await loadDetectionSources(client.query.bind(client));
    const detections=buildDetections(source);
    const synced=await syncCases(client,detections);
    await client.query('COMMIT');
    res.json({ok:true,synced,sourceCounts:{leads:source.leads.length,tasks:source.tasks.length,accounts:source.collections.length}});
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
});

// Kept for rollout compatibility with older clients. New clients use /refresh.
router.post('/sync', async (req, res) => {
  const items = Array.isArray(req.body?.exceptions) ? req.body.exceptions.slice(0,1000) : [];
  const client=await db.pool.connect();
  try { await client.query('BEGIN'); const synced=await syncCases(client,items); await client.query('COMMIT'); res.json({ok:true,synced}); }
  catch(err){await client.query('ROLLBACK');throw err;} finally{client.release();}
});

router.get('/settings', async (req, res) => {
  const { rows } = await db.query(`SELECT * FROM exception_settings WHERE id=1`);
  if (!rows[0]) return res.status(503).json({error:'Exception settings are not configured'});
  res.json({ settings: rows[0] });
});

router.put('/settings', async (req, res) => {
  const currentResult=await db.query(`SELECT * FROM exception_settings WHERE id=1`);
  if (!currentResult.rows[0]) return res.status(503).json({error:'Exception settings are not configured'});
  const validation=validateSettings(currentResult.rows[0],req.body||{});
  if (validation.error) return res.status(400).json({error:validation.error});
  const allowed=[...BOOLEAN_RULES,...Object.keys(NUMBER_RULES)];
  const values=[],sets=[];
  for (const key of allowed) if (req.body?.[key] != null) { values.push(validation.next[key]); sets.push(`${key}=$${values.length}`); }
  if (!sets.length) return res.status(400).json({error:'No settings supplied'});
  values.push(req.user.id);
  const {rows}=await db.query(`UPDATE exception_settings SET ${sets.join(',')},updated_by=$${values.length}::uuid,updated_at=now() WHERE id=1 RETURNING *`,values);
  res.json({settings:rows[0]});
});

router.get('/:id/history', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid exception' });
  const {rows}=await db.query(`SELECT e.*,u.full_name AS actor_name FROM exception_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.exception_id=$1 ORDER BY e.created_at DESC LIMIT 200`,[req.params.id]);
  res.json({events:rows});
});

router.patch('/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid exception' });
  const action=String(req.body?.action||'').trim();
  const note=req.body?.note==null?null:String(req.body.note).trim().slice(0,800);
  const client=await db.pool.connect();
  try {
    await client.query('BEGIN');
    const found=await client.query(`SELECT * FROM exception_cases WHERE id=$1 FOR UPDATE`,[req.params.id]);
    if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({error:'Exception not found'}); }
    let row;
    if (action==='resolve') {
      row=(await client.query(`UPDATE exception_cases SET status='resolved',resolved_at=now(),resolved_by=$2::uuid,resolution_note=$3,snoozed_until=NULL,updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,req.user.id,note])).rows[0];
    } else if (action==='snooze') {
      const until=new Date(req.body?.until);
      if (Number.isNaN(until.getTime())||until<=new Date()) { await client.query('ROLLBACK'); return res.status(400).json({error:'Choose a future snooze time'}); }
      row=(await client.query(`UPDATE exception_cases SET status='snoozed',snoozed_until=$2::timestamptz,resolved_at=NULL,resolved_by=NULL,resolution_note=NULL,updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,until])).rows[0];
    } else if (action==='reopen') {
      row=(await client.query(`UPDATE exception_cases SET status='open',active=true,snoozed_until=NULL,resolved_at=NULL,resolved_by=NULL,resolution_note=NULL,reopened_count=reopened_count+1,updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id])).rows[0];
    } else if (action==='assign') {
      const assignedTo=req.body?.assignedTo||null;
      if (assignedTo&&!UUID.test(String(assignedTo))) { await client.query('ROLLBACK'); return res.status(400).json({error:'Invalid assignee'}); }
      row=(await client.query(`UPDATE exception_cases SET assigned_to=$2::uuid,updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,assignedTo])).rows[0];
    } else { await client.query('ROLLBACK'); return res.status(400).json({error:'Invalid action'}); }
    await client.query(`INSERT INTO exception_events(exception_id,action,actor_id,note,payload) VALUES($1,$2,$3,$4,$5::jsonb)`,[req.params.id,action,req.user.id,note,JSON.stringify(req.body||{})]);
    await client.query('COMMIT'); res.json({exception:row});
  } catch(err){await client.query('ROLLBACK');throw err;} finally{client.release();}
});

module.exports = router;
module.exports._test = { normalizeCase, validateSettings, syncCases };
