const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { runDailyReminders, runNoonDigest } = require('../utils/pushNotifications');
const { runSalesBriefings } = require('../utils/salesBriefing');

const router = express.Router();

function timingSafeSecret(req) {
  const supplied = String(req.headers['x-cron-secret'] || req.query.secret || '');
  const expected = String(process.env.CRON_SECRET || '');
  if (!supplied || !expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function istDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

async function claim(jobName, runKey) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO scheduled_job_runs(job_name,run_key,status)
       VALUES($1,$2,'running') ON CONFLICT DO NOTHING RETURNING *`,
      [jobName, runKey]
    );
    if (inserted.rows[0]) {
      await client.query('COMMIT');
      return { claimed: true };
    }

    const { rows } = await client.query(
      `SELECT * FROM scheduled_job_runs WHERE job_name=$1 AND run_key=$2 FOR UPDATE`,
      [jobName, runKey]
    );
    const row = rows[0];
    if (row.status === 'done') {
      await client.query('COMMIT');
      return { claimed: false, done: true, result: row.result || null };
    }

    const stale = Date.now() - new Date(row.started_at).getTime() > 30 * 60 * 1000;
    if (row.status === 'running' && !stale) {
      await client.query('COMMIT');
      return { claimed: false, running: true };
    }

    await client.query(
      `UPDATE scheduled_job_runs
       SET status='running',started_at=now(),finished_at=NULL,result=NULL,error=NULL
       WHERE job_name=$1 AND run_key=$2`,
      [jobName, runKey]
    );
    await client.query('COMMIT');
    return { claimed: true, retried: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function finish(jobName, runKey, status, result, error) {
  await db.query(
    `UPDATE scheduled_job_runs
     SET status=$3,finished_at=now(),result=$4::jsonb,error=$5
     WHERE job_name=$1 AND run_key=$2`,
    [jobName, runKey, status, result == null ? null : JSON.stringify(result), error || null]
  );
}

async function guarded(req, res, jobName, fn) {
  if (!timingSafeSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
  const runKey = istDay();
  const state = await claim(jobName, runKey);
  if (state.done) return res.json({ ok: true, deduped: true, ...(state.result || {}) });
  if (state.running) return res.status(202).json({ ok: true, running: true, deduped: true });

  try {
    const result = await fn();
    await finish(jobName, runKey, 'done', result, null);
    return res.json({ ok: true, ...result });
  } catch (err) {
    await finish(jobName, runKey, 'failed', null, String(err.message || 'job failed').slice(0, 1000));
    console.error(`${jobName} cron failed:`, err);
    return res.status(500).json({ ok: false, error: `${jobName} failed` });
  }
}

router.post('/run-daily-reminders', (req,res) => guarded(req,res,'daily-reminders', async()=>{
  const reminders = await runDailyReminders();
  const tasks = await require('../utils/taskReminders').runTaskReminders();
  const quotations = await require('../utils/quotations').runQuotationReminders();
  return { reminders, tasks, quotations };
}));

router.post('/run-noon-digest', (req,res) => guarded(req,res,'noon-digest', async()=>runNoonDigest()));
router.post('/run-sales-briefing', (req,res) => guarded(req,res,'sales-briefing', async()=>runSalesBriefings()));

module.exports = router;
