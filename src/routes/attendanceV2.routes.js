const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { bad, date, str, UUID } = require('../utils/quotations');
const { buildXlsx } = require('../utils/simpleXlsx');
const { loadAttendanceReport, exportRows } = require('../utils/attendanceReportV2');

const EXCEPTION_KINDS = new Set(['holiday','leave','weekly_off','working_day']);

function rangeFromQuery(query) {
  const from = date(query.from);
  const to = date(query.to || from);
  if (from > to) throw bad('From date must be before To date.');
  const span = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (span > 366) throw bad('Attendance reports are limited to 366 days per request.');
  return { from, to };
}

function integer(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} must be between ${min} and ${max}.`);
  return n;
}

function optionalTime(value, label) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) throw bad(`${label} must use HH:MM.`);
  return raw;
}

function normalizeWorkingDays(value) {
  if (!Array.isArray(value)) throw bad('Working days must be an array.');
  const days = [...new Set(value.map(Number))].sort((a,b)=>a-b);
  if (!days.length || days.some(n => !Number.isInteger(n) || n < 0 || n > 6)) throw bad('Working days must contain day numbers from 0 to 6.');
  return days;
}

function schedulePayload(body, { employee = false } = {}) {
  const payload = {
    workingDays:normalizeWorkingDays(body.workingDays),
    expectedStartTime:optionalTime(body.expectedStartTime,'Expected start time'),
    expectedEndTime:optionalTime(body.expectedEndTime,'Expected end time'),
  };
  if (employee) {
    payload.lateToleranceMinutes = body.lateToleranceMinutes == null || body.lateToleranceMinutes === '' ? null : integer(body.lateToleranceMinutes,0,240,'Late tolerance');
    payload.earlyLeaveToleranceMinutes = body.earlyLeaveToleranceMinutes == null || body.earlyLeaveToleranceMinutes === '' ? null : integer(body.earlyLeaveToleranceMinutes,0,240,'Early-leave tolerance');
    payload.longSessionMinutes = body.longSessionMinutes == null || body.longSessionMinutes === '' ? null : integer(body.longSessionMinutes,60,2880,'Long-session threshold');
  } else {
    payload.lateToleranceMinutes = integer(body.lateToleranceMinutes ?? 0,0,240,'Late tolerance');
    payload.earlyLeaveToleranceMinutes = integer(body.earlyLeaveToleranceMinutes ?? 0,0,240,'Early-leave tolerance');
    payload.longSessionMinutes = integer(body.longSessionMinutes ?? 720,60,2880,'Long-session threshold');
  }
  return payload;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}

router.use(requireAuth);
router.use(async (req,res,next) => {
  res.set('Cache-Control','no-store');
  const { rows } = await db.query('SELECT id FROM users WHERE id=$1 AND role=$2 AND is_active=true',[req.user.id,req.user.role]);
  if (!rows.length) throw bad('Active account required',403);
  next();
});

router.get('/report', async (req,res) => {
  const { from, to } = rangeFromQuery(req.query);
  const employee = req.user.role === 'admin' ? (req.query.employee || null) : null;
  if (employee && !UUID.test(employee)) throw bad('Invalid employee');
  const report = await loadAttendanceReport(db.query,{ from,to,employee,userScope:req.user.role === 'salesman' ? req.user.id : null });
  res.json(report);
});

router.get('/settings', requireRole('admin'), async (req,res) => {
  const { from, to } = rangeFromQuery(req.query);
  const employee = req.query.employee || null;
  if (employee && !UUID.test(employee)) throw bad('Invalid employee');
  const [companyResult,scheduleResult,exceptionResult] = await Promise.all([
    db.query('SELECT * FROM attendance_company_schedule WHERE id=1'),
    db.query(`SELECT s.*,u.full_name FROM attendance_employee_schedule s JOIN users u ON u.id=s.user_id
      WHERE u.role='salesman' AND ($1::uuid IS NULL OR s.user_id=$1) ORDER BY u.full_name`,[employee]),
    db.query(`SELECT e.*,creator.full_name AS created_by_name FROM attendance_calendar_exceptions e
      LEFT JOIN users creator ON creator.id=e.created_by
      WHERE e.day BETWEEN $1::date AND $2::date
        AND (e.user_id IS NULL OR $3::uuid IS NULL OR e.user_id=$3)
      ORDER BY e.day,e.user_id NULLS FIRST`,[from,to,employee]),
  ]);
  const c = companyResult.rows[0];
  res.json({
    range:{from,to},
    company:{
      workingDays:(c?.working_days || [1,2,3,4,5,6]).map(Number),
      expectedStartTime:c?.expected_start_time || null, expectedEndTime:c?.expected_end_time || null,
      lateToleranceMinutes:Number(c?.late_tolerance_minutes ?? 0), earlyLeaveToleranceMinutes:Number(c?.early_leave_tolerance_minutes ?? 0),
      longSessionMinutes:Number(c?.long_session_minutes ?? 720), version:Number(c?.version || 1), updatedAt:c?.updated_at || null,
    },
    employeeSchedules:scheduleResult.rows.map(s=>({
      userId:s.user_id,name:s.full_name,workingDays:s.working_days.map(Number),
      expectedStartTime:s.expected_start_time || null,expectedEndTime:s.expected_end_time || null,
      lateToleranceMinutes:s.late_tolerance_minutes == null ? null : Number(s.late_tolerance_minutes),
      earlyLeaveToleranceMinutes:s.early_leave_tolerance_minutes == null ? null : Number(s.early_leave_tolerance_minutes),
      longSessionMinutes:s.long_session_minutes == null ? null : Number(s.long_session_minutes),
      version:Number(s.version),updatedAt:s.updated_at,
    })),
    exceptions:exceptionResult.rows.map(e=>({
      id:String(e.id),userId:e.user_id,day:String(e.day).slice(0,10),kind:e.kind,label:e.label || '',
      createdBy:e.created_by || null,createdByName:e.created_by_name || null,createdAt:e.created_at,updatedAt:e.updated_at,
    })),
  });
});

router.put('/settings/company', requireRole('admin'), async (req,res) => {
  const version = Number(req.body?.version);
  if (!Number.isInteger(version)) throw bad('Settings version is required.');
  const p = schedulePayload(req.body || {});
  const result = await db.query(`UPDATE attendance_company_schedule SET
    working_days=$1::smallint[],expected_start_time=$2::time,expected_end_time=$3::time,
    late_tolerance_minutes=$4,early_leave_tolerance_minutes=$5,long_session_minutes=$6,
    version=version+1,updated_at=now(),updated_by=$7
    WHERE id=1 AND version=$8 RETURNING *`,[
    p.workingDays,p.expectedStartTime,p.expectedEndTime,p.lateToleranceMinutes,p.earlyLeaveToleranceMinutes,p.longSessionMinutes,req.user.id,version,
  ]);
  if (!result.rows.length) throw bad('Attendance settings changed. Reload before saving.',409);
  res.json({ok:true,version:result.rows[0].version});
});

router.put('/settings/employee/:id', requireRole('admin'), async (req,res) => {
  if (!UUID.test(req.params.id)) throw bad('Invalid employee');
  const exists = await db.query("SELECT id FROM users WHERE id=$1 AND role='salesman'",[req.params.id]);
  if (!exists.rows.length) throw bad('Employee not found',404);
  if (req.body?.inherit === true) {
    await db.query('DELETE FROM attendance_employee_schedule WHERE user_id=$1',[req.params.id]);
    return res.json({ok:true,inherited:true,userId:req.params.id});
  }
  const p = schedulePayload(req.body || {},{employee:true});
  const version = req.body?.version == null ? null : Number(req.body.version);
  if (version != null && !Number.isInteger(version)) throw bad('Invalid settings version.');
  const current = await db.query('SELECT version FROM attendance_employee_schedule WHERE user_id=$1',[req.params.id]);
  if (current.rows.length && current.rows[0].version !== version) throw bad('Employee schedule changed. Reload before saving.',409);
  if (!current.rows.length && version != null) throw bad('Employee schedule changed. Reload before saving.',409);
  const result = await db.query(`INSERT INTO attendance_employee_schedule(
      user_id,working_days,expected_start_time,expected_end_time,late_tolerance_minutes,early_leave_tolerance_minutes,long_session_minutes,updated_by)
    VALUES($1,$2::smallint[],$3::time,$4::time,$5,$6,$7,$8)
    ON CONFLICT(user_id) DO UPDATE SET
      working_days=EXCLUDED.working_days,expected_start_time=EXCLUDED.expected_start_time,expected_end_time=EXCLUDED.expected_end_time,
      late_tolerance_minutes=EXCLUDED.late_tolerance_minutes,early_leave_tolerance_minutes=EXCLUDED.early_leave_tolerance_minutes,
      long_session_minutes=EXCLUDED.long_session_minutes,version=attendance_employee_schedule.version+1,updated_at=now(),updated_by=EXCLUDED.updated_by
    RETURNING *`,[req.params.id,p.workingDays,p.expectedStartTime,p.expectedEndTime,p.lateToleranceMinutes,p.earlyLeaveToleranceMinutes,p.longSessionMinutes,req.user.id]);
  res.json({ok:true,userId:req.params.id,version:result.rows[0].version,inherited:false});
});

router.post('/exceptions', requireRole('admin'), async (req,res) => {
  const userId = req.body?.userId || null;
  const exceptionDay = date(req.body?.day);
  const kind = String(req.body?.kind || '');
  const label = str(req.body?.label || '',120) || null;
  if (userId && !UUID.test(userId)) throw bad('Invalid employee');
  if (!EXCEPTION_KINDS.has(kind)) throw bad('Invalid attendance exception type.');
  const c = await db.pool.connect(); const q = c.query.bind(c);
  try {
    await q('BEGIN');
    let previous = null;
    if (userId) previous=(await q('SELECT * FROM attendance_calendar_exceptions WHERE user_id=$1 AND day=$2 FOR UPDATE',[userId,exceptionDay])).rows[0] || null;
    else previous=(await q('SELECT * FROM attendance_calendar_exceptions WHERE user_id IS NULL AND day=$1 FOR UPDATE',[exceptionDay])).rows[0] || null;
    if (previous) await q('DELETE FROM attendance_calendar_exceptions WHERE id=$1',[previous.id]);
    const result = await q(`INSERT INTO attendance_calendar_exceptions(user_id,day,kind,label,created_by)
      VALUES($1,$2,$3,$4,$5) RETURNING *`,[userId,exceptionDay,kind,label,req.user.id]);
    const row=result.rows[0];
    await q(`INSERT INTO attendance_exception_audit(exception_id,user_id,day,action,before_value,after_value,actor_id)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,[
      row.id,userId,exceptionDay,previous?'replaced':'created',previous?JSON.stringify(previous):null,JSON.stringify(row),req.user.id,
    ]);
    await q('COMMIT');
    res.status(201).json({id:String(row.id),userId:row.user_id,day:String(row.day).slice(0,10),kind:row.kind,label:row.label || ''});
  } catch(e) { await q('ROLLBACK'); throw e; } finally { c.release(); }
});

router.delete('/exceptions/:id', requireRole('admin'), async (req,res) => {
  if (!/^\d+$/.test(String(req.params.id))) throw bad('Invalid attendance exception.');
  const c=await db.pool.connect(); const q=c.query.bind(c);
  try {
    await q('BEGIN');
    const row=(await q('SELECT * FROM attendance_calendar_exceptions WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
    if (!row) throw bad('Attendance exception not found',404);
    await q('DELETE FROM attendance_calendar_exceptions WHERE id=$1',[req.params.id]);
    await q(`INSERT INTO attendance_exception_audit(exception_id,user_id,day,action,before_value,actor_id)
      VALUES($1,$2,$3,'deleted',$4::jsonb,$5)`,[row.id,row.user_id,row.day,JSON.stringify(row),req.user.id]);
    await q('COMMIT'); res.json({ok:true});
  } catch(e) { await q('ROLLBACK'); throw e; } finally { c.release(); }
});

router.get('/exceptions/audit', requireRole('admin'), async (req,res) => {
  const { from, to } = rangeFromQuery(req.query);
  const employee=req.query.employee || null;
  if (employee && !UUID.test(employee)) throw bad('Invalid employee');
  const result=await db.query(`SELECT a.*,u.full_name AS actor_name FROM attendance_exception_audit a
    LEFT JOIN users u ON u.id=a.actor_id WHERE a.day BETWEEN $1::date AND $2::date
      AND ($3::uuid IS NULL OR a.user_id=$3) ORDER BY a.created_at DESC LIMIT 500`,[from,to,employee]);
  res.json({audit:result.rows});
});

router.post('/sessions/:id/close', requireRole('admin'), async (req,res) => {
  if (!UUID.test(req.params.id)) throw bad('Invalid attendance session.');
  const reason=str(req.body?.reason || '',500);
  if (!reason) throw bad('A correction reason is required.');
  const endAt=new Date(req.body?.endAt);
  if (Number.isNaN(endAt.getTime())) throw bad('A valid End Day time is required.');
  if (endAt.getTime() > Date.now()+60000) throw bad('End Day cannot be in the future.');
  const c=await db.pool.connect(); const q=c.query.bind(c);
  try {
    await q('BEGIN');
    const row=(await q('SELECT * FROM attendance WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
    if (!row) throw bad('Attendance session not found',404);
    if (row.end_day_at) throw bad('This attendance session is already closed.',409);
    if (!row.start_day_at || endAt.getTime() < new Date(row.start_day_at).getTime()) throw bad('End Day must be after Start Day.');
    await q('UPDATE attendance SET end_day_at=$2 WHERE id=$1',[row.id,endAt.toISOString()]);
    await q(`INSERT INTO attendance_corrections(attendance_id,correction_type,previous_value,corrected_value,reason,actor_id)
      VALUES($1,'close_stale_session',$2::jsonb,$3::jsonb,$4,$5)`,[
      row.id,JSON.stringify({end_day_at:null}),JSON.stringify({end_day_at:endAt.toISOString()}),reason,req.user.id,
    ]);
    const other=(await q('SELECT 1 FROM attendance WHERE salesman_id=$1 AND id<>$2 AND start_day_at IS NOT NULL AND end_day_at IS NULL LIMIT 1',[row.salesman_id,row.id])).rows.length;
    if (!other) await q("UPDATE salesman_profiles SET status='offline',last_seen_at=now() WHERE user_id=$1",[row.salesman_id]);
    await q('COMMIT');
    res.json({ok:true,attendanceId:row.id,endAt:endAt.toISOString()});
  } catch(e) { await q('ROLLBACK'); throw e; } finally { c.release(); }
});

router.get('/export', requireRole('admin'), async (req,res) => {
  const { from, to } = rangeFromQuery(req.query);
  const employee=req.query.employee || null;
  if (employee && !UUID.test(employee)) throw bad('Invalid employee');
  const format=String(req.query.format || 'csv').toLowerCase();
  if (!['csv','xlsx'].includes(format)) throw bad('Format must be csv or xlsx.');
  const report=await loadAttendanceReport(db.query,{from,to,employee});
  const rows=exportRows(report);
  const headers=rows.length ? Object.keys(rows[0]) : ['Employee','Date','Scheduled','Status','Start Day','End Day','Duration Minutes','Sessions','Expected Start','Expected End','Late Minutes','Early Leave Minutes','Day Closing Required','Day Closing Status','Anomalies'];
  const name=`attendance-${from}-to-${to}`;
  if (format==='xlsx') {
    const file=buildXlsx(headers,rows,'Attendance');
    res.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition',`attachment; filename="${name}.xlsx"`);
    return res.send(file);
  }
  const csv=[headers.map(csvEscape).join(','),...rows.map(r=>headers.map(h=>csvEscape(r[h])).join(','))].join('\r\n');
  res.set('Content-Type','text/csv; charset=utf-8');
  res.set('Content-Disposition',`attachment; filename="${name}.csv"`);
  res.send(`\uFEFF${csv}`);
});

module.exports=router;
