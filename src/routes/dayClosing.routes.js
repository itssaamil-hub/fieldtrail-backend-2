const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { UUID, bad, date, day, str } = require('../utils/quotations');
const { permissions, metrics, activeAttendance } = require('../utils/dayClosing');

const ATTENDANCE_EXCEPTION_KINDS = new Set(['holiday', 'leave', 'weekly_off', 'working_day']);

function normalizeWorkingDays(value) {
  if (!Array.isArray(value)) throw bad('Working days must be an array.');
  const days = [...new Set(value.map(Number))].sort((a, b) => a - b);
  if (!days.length || days.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) {
    throw bad('Working days must contain day numbers from 0 (Sunday) to 6 (Saturday).');
  }
  return days;
}

function rangeFromQuery(query) {
  const legacyDay = query.day || null;
  const from = date(query.from || legacyDay || day());
  const to = date(query.to || legacyDay || from);
  if (from > to) throw bad('From date must be before To date.');
  const span = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (span > 366) throw bad('Attendance reports are limited to 366 days per request.');
  return { from, to };
}

router.use(requireAuth);
router.use(async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const { rows } = await db.query(
    'SELECT id FROM users WHERE id=$1 AND role=$2 AND is_active=true',
    [req.user.id, req.user.role]
  );
  if (!rows.length) throw bad('Active account required', 403);
  next();
});

router.get('/permissions/:id', requireRole('admin'), async (req, res) => {
  if (!UUID.test(req.params.id)) throw bad('Invalid employee');
  res.json(await permissions(db.query, req.params.id));
});

router.put('/permissions/:id', requireRole('admin'), async (req, res) => {
  const b = req.body;
  if (
    !UUID.test(req.params.id) ||
    !Number.isInteger(b.version) ||
    ['require_closing', 'allow_skip', 'require_skip_reason'].some((k) => typeof b[k] !== 'boolean') ||
    (b.allow_multiple_starts !== undefined && typeof b.allow_multiple_starts !== 'boolean') ||
    (b.allow_lead_without_start_day !== undefined && typeof b.allow_lead_without_start_day !== 'boolean')
  ) throw bad('Invalid permissions');

  const c = await db.pool.connect();
  const query = c.query.bind(c);
  try {
    await query('BEGIN');
    const { rows } = await query("SELECT id FROM users WHERE id=$1 AND role='salesman' FOR UPDATE", [req.params.id]);
    if (!rows.length) throw bad('Employee not found', 404);
    const p = await permissions(query, req.params.id);
    if (p.version !== b.version) throw bad('Permissions changed. Reload before saving.', 409);
    const multi = b.allow_multiple_starts === undefined ? !!p.allow_multiple_starts : b.allow_multiple_starts;
    const leadWithoutDay = b.allow_lead_without_start_day === undefined ? !!p.allow_lead_without_start_day : b.allow_lead_without_start_day;
    const result = await query(
      `INSERT INTO employee_day_closing_permissions(user_id,require_closing,allow_skip,require_skip_reason,allow_multiple_starts,allow_lead_without_start_day)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(user_id) DO UPDATE SET
         require_closing=$2,allow_skip=$3,require_skip_reason=$4,allow_multiple_starts=$5,allow_lead_without_start_day=$6,
         version=employee_day_closing_permissions.version+1
       RETURNING *`,
      [req.params.id, b.require_closing, b.allow_skip, b.require_skip_reason, multi, leadWithoutDay]
    );
    await query('COMMIT');
    res.json(result.rows[0]);
  } catch (e) {
    await query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
});

router.get('/status', requireRole('salesman'), async (req, res) => {
  res.json({ active: !!(await activeAttendance(db.query, req.user.id)) });
});

router.get('/current', requireRole('salesman'), async (req, res) => {
  const a = await activeAttendance(db.query, req.user.id);
  if (!a) throw bad('No active day. Start your day first.', 409);
  const report = (await db.query('SELECT * FROM day_closing_reports WHERE attendance_id=$1', [a.id])).rows[0] || null;
  res.json({ attendance: a, permissions: await permissions(db.query, req.user.id), report, metrics: await metrics(db.query, req.user.id, a.day) });
});

router.put('/draft', requireRole('salesman'), async (req, res) => {
  const b = req.body;
  if (!UUID.test(b.attendanceId) || !Number.isInteger(b.version)) throw bad('Invalid draft');
  const c = await db.pool.connect();
  const query = c.query.bind(c);
  try {
    await query('BEGIN');
    await query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
    const a = await activeAttendance(query, req.user.id);
    if (!a || a.id !== b.attendanceId) throw bad('Active day changed. Reload before saving.', 409);
    const r = (await query('SELECT * FROM day_closing_reports WHERE attendance_id=$1', [a.id])).rows[0];
    if (r && r.status !== 'draft') throw bad('Report already submitted', 409);
    if ((r?.version || 0) !== b.version) throw bad('Draft changed. Reload before saving.', 409);
    const result = await query(
      `INSERT INTO day_closing_reports(attendance_id,user_id,day,status,outcomes,blockers,priorities)
       VALUES($1,$2,$3,'draft',$4,$5,$6)
       ON CONFLICT(attendance_id) DO UPDATE SET
         outcomes=$4,blockers=$5,priorities=$6,updated_at=now(),version=day_closing_reports.version+1
       RETURNING *`,
      [a.id, req.user.id, a.day, str(b.outcomes || '', 2000), str(b.blockers || '', 2000), str(b.priorities || '', 2000)]
    );
    await query('COMMIT');
    res.json(result.rows[0]);
  } catch (e) {
    await query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
});

// Attendance calendar settings. Company defaults apply unless an employee override exists.
// Date exceptions are then applied: global first, employee-specific second.
router.get('/attendance-settings', requireRole('admin'), async (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  const employee = req.query.employee || null;
  if (employee && !UUID.test(employee)) throw bad('Invalid employee');

  const [companyResult, scheduleResult, exceptionResult] = await Promise.all([
    db.query('SELECT working_days,version,updated_at FROM attendance_company_schedule WHERE id=1'),
    db.query(
      `SELECT s.user_id,s.working_days,s.version,s.updated_at,u.full_name
       FROM attendance_employee_schedule s
       JOIN users u ON u.id=s.user_id
       WHERE u.role='salesman' AND ($1::uuid IS NULL OR s.user_id=$1)
       ORDER BY u.full_name`,
      [employee]
    ),
    db.query(
      `SELECT e.id,e.user_id,e.day,e.kind,e.label,u.full_name
       FROM attendance_calendar_exceptions e
       LEFT JOIN users u ON u.id=e.user_id
       WHERE e.day BETWEEN $1::date AND $2::date
         AND (e.user_id IS NULL OR $3::uuid IS NULL OR e.user_id=$3)
       ORDER BY e.day,e.user_id NULLS FIRST`,
      [from, to, employee]
    )
  ]);

  const company = companyResult.rows[0] || { working_days: [1,2,3,4,5,6], version: 1 };
  res.json({
    range: { from, to },
    company: { workingDays: company.working_days.map(Number), version: company.version, updatedAt: company.updated_at || null },
    employeeSchedules: scheduleResult.rows.map((r) => ({ userId:r.user_id, name:r.full_name, workingDays:r.working_days.map(Number), version:r.version, updatedAt:r.updated_at })),
    exceptions: exceptionResult.rows.map((r) => ({ id:String(r.id), userId:r.user_id, employeeName:r.full_name || null, day:String(r.day).slice(0,10), kind:r.kind, label:r.label || '' }))
  });
});

router.put('/attendance-settings/company', requireRole('admin'), async (req, res) => {
  const workingDays = normalizeWorkingDays(req.body?.workingDays);
  const version = Number(req.body?.version);
  if (!Number.isInteger(version)) throw bad('Settings version is required.');
  const result = await db.query(
    `UPDATE attendance_company_schedule
     SET working_days=$1::smallint[],version=version+1,updated_at=now(),updated_by=$2
     WHERE id=1 AND version=$3
     RETURNING working_days,version,updated_at`,
    [workingDays, req.user.id, version]
  );
  if (!result.rows.length) throw bad('Attendance settings changed. Reload before saving.', 409);
  const row = result.rows[0];
  res.json({ workingDays: row.working_days.map(Number), version: row.version, updatedAt: row.updated_at });
});

router.put('/attendance-settings/employee/:id', requireRole('admin'), async (req, res) => {
  if (!UUID.test(req.params.id)) throw bad('Invalid employee');
  const exists = await db.query("SELECT id FROM users WHERE id=$1 AND role='salesman'", [req.params.id]);
  if (!exists.rows.length) throw bad('Employee not found', 404);

  if (req.body?.inherit === true) {
    await db.query('DELETE FROM attendance_employee_schedule WHERE user_id=$1', [req.params.id]);
    return res.json({ userId:req.params.id, inherited:true });
  }

  const workingDays = normalizeWorkingDays(req.body?.workingDays);
  const currentVersion = req.body?.version == null ? null : Number(req.body.version);
  if (currentVersion != null && !Number.isInteger(currentVersion)) throw bad('Invalid settings version.');

  const current = await db.query('SELECT version FROM attendance_employee_schedule WHERE user_id=$1', [req.params.id]);
  if (current.rows.length && currentVersion !== current.rows[0].version) throw bad('Employee schedule changed. Reload before saving.', 409);
  if (!current.rows.length && currentVersion != null) throw bad('Employee schedule changed. Reload before saving.', 409);

  const result = await db.query(
    `INSERT INTO attendance_employee_schedule(user_id,working_days,updated_by)
     VALUES($1,$2::smallint[],$3)
     ON CONFLICT(user_id) DO UPDATE SET working_days=EXCLUDED.working_days,version=attendance_employee_schedule.version+1,updated_at=now(),updated_by=EXCLUDED.updated_by
     RETURNING user_id,working_days,version,updated_at`,
    [req.params.id, workingDays, req.user.id]
  );
  const row = result.rows[0];
  res.json({ userId:row.user_id, workingDays:row.working_days.map(Number), version:row.version, updatedAt:row.updated_at, inherited:false });
});

router.post('/attendance-settings/exceptions', requireRole('admin'), async (req, res) => {
  const userId = req.body?.userId || null;
  const exceptionDay = date(req.body?.day);
  const kind = String(req.body?.kind || '');
  const label = str(req.body?.label || '', 120) || null;
  if (userId && !UUID.test(userId)) throw bad('Invalid employee');
  if (!ATTENDANCE_EXCEPTION_KINDS.has(kind)) throw bad('Invalid attendance exception type.');
  if (userId) {
    const exists = await db.query("SELECT id FROM users WHERE id=$1 AND role='salesman'", [userId]);
    if (!exists.rows.length) throw bad('Employee not found', 404);
  }

  const c = await db.pool.connect();
  const query = c.query.bind(c);
  try {
    await query('BEGIN');
    if (userId) await query('DELETE FROM attendance_calendar_exceptions WHERE user_id=$1 AND day=$2', [userId, exceptionDay]);
    else await query('DELETE FROM attendance_calendar_exceptions WHERE user_id IS NULL AND day=$1', [exceptionDay]);
    const result = await query(
      `INSERT INTO attendance_calendar_exceptions(user_id,day,kind,label,created_by)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id,user_id,day,kind,label`,
      [userId, exceptionDay, kind, label, req.user.id]
    );
    await query('COMMIT');
    const row = result.rows[0];
    res.status(201).json({ id:String(row.id), userId:row.user_id, day:String(row.day).slice(0,10), kind:row.kind, label:row.label || '' });
  } catch (e) {
    await query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
});

router.delete('/attendance-settings/exceptions/:id', requireRole('admin'), async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) throw bad('Invalid attendance exception.');
  const result = await db.query('DELETE FROM attendance_calendar_exceptions WHERE id=$1 RETURNING id', [req.params.id]);
  if (!result.rows.length) throw bad('Attendance exception not found', 404);
  res.json({ ok:true });
});

router.get('/reports', async (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  const employee = req.query.employee || null;
  const offset = Number(req.query.offset || 0);
  if ((employee && !UUID.test(employee)) || !Number.isInteger(offset) || offset < 0) throw bad('Invalid employee or page');
  const { rows } = await db.query(
    `SELECT u.id AS user_id,u.full_name,a.id AS attendance_id,a.day,a.session_number,a.start_day_at,a.end_day_at,
            r.status,r.outcomes,r.blockers,r.priorities,r.skip_reason,r.metrics,r.submitted_at
     FROM users u
     LEFT JOIN attendance a ON a.salesman_id=u.id AND a.day BETWEEN $1::date AND $2::date
     LEFT JOIN day_closing_reports r ON r.attendance_id=a.id
     WHERE u.role='salesman' AND (u.is_active OR a.id IS NOT NULL) AND ($3::uuid IS NULL OR u.id=$3)
     ORDER BY u.full_name,u.id,a.day,a.session_number
     LIMIT 51 OFFSET $4`,
    [from, to, req.user.role === 'admin' ? employee : req.user.id, offset]
  );
  res.json({ reports:rows.slice(0,50), hasMore:rows.length>50, range:{from,to} });
});

router.use((e, req, res, next) => {
  if (e.status) return res.status(e.status).json({ error:e.message });
  next(e);
});

module.exports = router;
