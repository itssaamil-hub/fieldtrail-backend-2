const IST = 'Asia/Kolkata';

function isoDay(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function rangeDays(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function dayOfWeek(day) {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

function timeParts(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{2}):(\d{2})/);
  return m ? { h:Number(m[1]), m:Number(m[2]) } : null;
}

function istParts(value) {
  if (!value) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23',
  }).formatToParts(new Date(value));
  const get = type => parts.find(p => p.type === type)?.value;
  return { day:`${get('year')}-${get('month')}-${get('day')}`, h:Number(get('hour')), m:Number(get('minute')) };
}

function clockMinutes(parts) {
  return parts ? parts.h * 60 + parts.m : null;
}

function durationMinutes(start, end) {
  if (!start || !end) return 0;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60000) : 0;
}

function effectiveSchedule(userId, company, employeeSchedules) {
  const employee = employeeSchedules.find(s => s.user_id === userId) || null;
  return {
    workingDays:(employee?.working_days || company.working_days || []).map(Number),
    expectedStartTime:employee?.expected_start_time ?? company.expected_start_time ?? null,
    expectedEndTime:employee?.expected_end_time ?? company.expected_end_time ?? null,
    lateToleranceMinutes:Number(employee?.late_tolerance_minutes ?? company.late_tolerance_minutes ?? 0),
    earlyLeaveToleranceMinutes:Number(employee?.early_leave_tolerance_minutes ?? company.early_leave_tolerance_minutes ?? 0),
    longSessionMinutes:Number(employee?.long_session_minutes ?? company.long_session_minutes ?? 720),
    source:employee ? 'employee_override' : 'company',
  };
}

function calendarState(day, userId, schedule, exceptions) {
  let working = schedule.workingDays.includes(dayOfWeek(day));
  const global = exceptions.find(e => !e.user_id && isoDay(e.day) === day) || null;
  const employee = exceptions.find(e => e.user_id === userId && isoDay(e.day) === day) || null;
  for (const item of [global, employee]) {
    if (!item) continue;
    working = item.kind === 'working_day';
  }
  return { working, exception:employee || global || null };
}

function closingForDay(sessions, currentPolicy) {
  if (!sessions.length) return { required:false, completed:false, pending:false, source:'no_work' };
  const statuses = sessions.map(s => s.closing_status).filter(Boolean);
  if (statuses.some(s => s === 'submitted' || s === 'skipped')) {
    return { required:true, completed:true, pending:false, source:'closing_record' };
  }
  if (statuses.includes('not_required')) {
    return { required:false, completed:false, pending:false, source:'closing_record' };
  }
  const snapshots = sessions.map(s => s.closing_required_snapshot).filter(v => v !== null && v !== undefined);
  if (snapshots.length) {
    const required = snapshots.some(Boolean);
    return { required, completed:false, pending:required, source:'attendance_snapshot' };
  }
  if (currentPolicy && typeof currentPolicy.require_closing === 'boolean') {
    const required = currentPolicy.require_closing === true;
    return { required, completed:false, pending:required, source:'legacy_current_policy' };
  }
  return { required:false, completed:false, pending:false, source:'legacy_unknown' };
}

function dayMetrics({ day, sessions, schedule, policy, now, today }) {
  const sorted = [...sessions].sort((a,b) => new Date(a.start_day_at || 0) - new Date(b.start_day_at || 0));
  const first = sorted.find(s => s.start_day_at) || null;
  const firstStart = first?.start_day_at || null;
  const open = sorted.filter(s => s.start_day_at && !s.end_day_at);
  const hasOpen = open.length > 0;
  const closed = sorted.filter(s => s.start_day_at && s.end_day_at);
  const lastEnd = hasOpen ? null : (closed[closed.length - 1]?.end_day_at || null);
  let duration = closed.reduce((sum,s) => sum + durationMinutes(s.start_day_at, s.end_day_at), 0);
  if (day === today) duration += open.reduce((sum,s) => sum + durationMinutes(s.start_day_at, now), 0);

  const snapshotSource = first && first.expected_start_time_snapshot != null;
  const expectedStart = snapshotSource ? first.expected_start_time_snapshot : (first ? null : schedule.expectedStartTime);
  const expectedEnd = snapshotSource ? first.expected_end_time_snapshot : (first ? null : schedule.expectedEndTime);
  const lateTolerance = snapshotSource ? Number(first.late_tolerance_minutes_snapshot ?? 0) : schedule.lateToleranceMinutes;
  const earlyTolerance = snapshotSource ? Number(first.early_leave_tolerance_minutes_snapshot ?? 0) : schedule.earlyLeaveToleranceMinutes;
  const longLimit = first?.long_session_minutes_snapshot != null ? Number(first.long_session_minutes_snapshot) : schedule.longSessionMinutes;

  let lateMinutes = 0;
  const startParts = istParts(firstStart);
  const expectedStartParts = timeParts(expectedStart);
  if (startParts && expectedStartParts && startParts.day === day) {
    lateMinutes = Math.max(0, clockMinutes(startParts) - clockMinutes(expectedStartParts) - lateTolerance);
  }

  let earlyLeaveMinutes = 0;
  const endParts = istParts(lastEnd);
  const expectedEndParts = timeParts(expectedEnd);
  if (endParts && expectedEndParts && endParts.day === day) {
    earlyLeaveMinutes = Math.max(0, clockMinutes(expectedEndParts) - clockMinutes(endParts) - earlyTolerance);
  }

  let longestSessionMinutes = 0;
  for (const s of sorted) {
    const end = s.end_day_at || now;
    longestSessionMinutes = Math.max(longestSessionMinutes, durationMinutes(s.start_day_at, end));
  }
  const staleOpen = open.some(s => istParts(s.start_day_at)?.day !== today);
  const missingStartGps = sorted.some(s => s.start_day_at && (s.start_lat == null || s.start_lng == null));
  const missingEndGps = closed.some(s => s.end_lat == null || s.end_lng == null);
  const closing = closingForDay(sorted, policy);

  const anomalies = [];
  if (lateMinutes > 0) anomalies.push({ type:'late_start', severity:'medium', minutes:lateMinutes, label:`Late by ${lateMinutes}m` });
  if (earlyLeaveMinutes > 0) anomalies.push({ type:'early_end', severity:'medium', minutes:earlyLeaveMinutes, label:`Left ${earlyLeaveMinutes}m early` });
  if (staleOpen) anomalies.push({ type:'missing_end', severity:'high', label:'Missing End Day' });
  if (longestSessionMinutes > longLimit) anomalies.push({ type:'long_session', severity:longestSessionMinutes >= longLimit * 2 ? 'high' : 'medium', minutes:longestSessionMinutes, label:'Unusually long session' });
  if (sorted.length > 1) anomalies.push({ type:'multiple_sessions', severity:'info', count:sorted.length, label:`${sorted.length} sessions` });
  if (closing.pending) anomalies.push({ type:'closing_pending', severity:'medium', label:'Day Closing pending' });
  if (missingStartGps || missingEndGps) anomalies.push({ type:'gps_missing', severity:'medium', label:'GPS missing' });

  return {
    firstStart, lastEnd, hasOpen, staleOpen, durationMinutes:duration, sessionCount:sorted.length,
    expectedStartTime:expectedStart || null, expectedEndTime:expectedEnd || null,
    lateMinutes, earlyLeaveMinutes, longestSessionMinutes,
    missingStartGps, missingEndGps, closing, anomalies,
  };
}

async function loadAttendanceReport(query, { from, to, employee = null, userScope = null }) {
  const todayResult = await query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS today, CURRENT_TIMESTAMP AS now");
  const today = todayResult.rows[0].today;
  const now = todayResult.rows[0].now;
  const effectiveTo = to > today ? today : to;
  const days = rangeDays(from, effectiveTo);

  const [usersResult, companyResult, scheduleResult, exceptionResult, attendanceResult, policyResult] = await Promise.all([
    query(`SELECT u.id,u.full_name,u.is_active FROM users u
      WHERE u.role='salesman'
        AND ($1::uuid IS NULL OR u.id=$1)
        AND ($2::uuid IS NULL OR u.id=$2)
        AND (u.is_active OR EXISTS (SELECT 1 FROM attendance a WHERE a.salesman_id=u.id AND a.day BETWEEN $3::date AND $4::date))
      ORDER BY u.full_name,u.id`, [employee,userScope,from,to]),
    query('SELECT * FROM attendance_company_schedule WHERE id=1'),
    query(`SELECT * FROM attendance_employee_schedule WHERE ($1::uuid IS NULL OR user_id=$1) AND ($2::uuid IS NULL OR user_id=$2)`,[employee,userScope]),
    query(`SELECT e.*,u.full_name AS actor_name FROM attendance_calendar_exceptions e
      LEFT JOIN users u ON u.id=e.created_by
      WHERE e.day BETWEEN $1::date AND $2::date
        AND (e.user_id IS NULL OR ($3::uuid IS NULL OR e.user_id=$3))
        AND ($4::uuid IS NULL OR e.user_id IS NULL OR e.user_id=$4)
      ORDER BY e.day,e.user_id NULLS FIRST`,[from,to,employee,userScope]),
    query(`SELECT a.*,r.status AS closing_status,r.permissions AS closing_permissions
      FROM attendance a LEFT JOIN day_closing_reports r ON r.attendance_id=a.id
      WHERE a.day BETWEEN $1::date AND $2::date
        AND ($3::uuid IS NULL OR a.salesman_id=$3)
        AND ($4::uuid IS NULL OR a.salesman_id=$4)
      ORDER BY a.salesman_id,a.day,a.session_number`,[from,to,employee,userScope]),
    query(`SELECT p.* FROM employee_day_closing_permissions p
      WHERE ($1::uuid IS NULL OR p.user_id=$1) AND ($2::uuid IS NULL OR p.user_id=$2)`,[employee,userScope]),
  ]);

  const company = companyResult.rows[0] || { working_days:[1,2,3,4,5,6], late_tolerance_minutes:0, early_leave_tolerance_minutes:0, long_session_minutes:720 };
  const exceptions = exceptionResult.rows;
  const policies = new Map(policyResult.rows.map(p => [p.user_id,p]));
  const sessionsByUserDay = new Map();
  for (const s of attendanceResult.rows) {
    const key = `${s.salesman_id}:${isoDay(s.day)}`;
    if (!sessionsByUserDay.has(key)) sessionsByUserDay.set(key,[]);
    sessionsByUserDay.get(key).push(s);
  }

  const employees = [];
  const totals = { worked:0, working:0, present:0, absent:0, notStartedToday:0, closingDone:0, closingRequired:0, closingPending:0, anomalyCount:0 };
  for (const user of usersResult.rows) {
    const schedule = effectiveSchedule(user.id, company, scheduleResult.rows);
    const details = [];
    let workedDays=0, workingDays=0, presentWorkingDays=0, absentDays=0, notStartedToday=false, totalDurationMinutes=0;
    let closingDone=0, closingRequired=0, closingPending=0;
    const anomalyCounts = {};

    for (const day of days) {
      const calendar = calendarState(day,user.id,schedule,exceptions);
      const sessions = sessionsByUserDay.get(`${user.id}:${day}`) || [];
      const metrics = dayMetrics({day,sessions,schedule,policy:policies.get(user.id),now,today});
      const worked = sessions.length > 0;
      if (worked) workedDays += 1;
      if (calendar.working) workingDays += 1;
      if (worked && calendar.working) presentWorkingDays += 1;
      if (day < today && calendar.working && !worked) absentDays += 1;
      if (day === today && calendar.working && !worked) notStartedToday = true;
      totalDurationMinutes += metrics.durationMinutes;
      if (metrics.closing.required) closingRequired += 1;
      if (metrics.closing.completed) closingDone += 1;
      if (metrics.closing.pending) closingPending += 1;
      for (const a of metrics.anomalies) anomalyCounts[a.type]=(anomalyCounts[a.type]||0)+1;

      let state='Off Day';
      if (worked) state=metrics.hasOpen?'Day Open':'Present';
      else if (calendar.exception && calendar.exception.kind !== 'working_day') state=calendar.exception.kind;
      else if (day === today && calendar.working) state='Not Started';
      else if (calendar.working) state='Absent';

      details.push({
        day,state,working:calendar.working,exception:calendar.exception ? {
          id:String(calendar.exception.id),kind:calendar.exception.kind,label:calendar.exception.label || '',
          createdBy:calendar.exception.created_by || null,createdByName:calendar.exception.actor_name || null,
          createdAt:calendar.exception.created_at || null,
        } : null,
        sessions:sessions.map(s => ({
          id:s.id,sessionNumber:s.session_number,startDayAt:s.start_day_at,endDayAt:s.end_day_at,
          startLat:s.start_lat,startLng:s.start_lng,endLat:s.end_lat,endLng:s.end_lng,
          startAccuracyM:s.start_accuracy_m,endAccuracyM:s.end_accuracy_m,
        })),
        ...metrics,
      });
    }

    const attendancePct = workingDays ? Math.round((presentWorkingDays/workingDays)*1000)/10 : 0;
    const anomalyCount = Object.values(anomalyCounts).reduce((a,b)=>a+b,0);
    const item = {
      userId:user.id,name:user.full_name,workedDays,workingDays,presentWorkingDays,absentDays,notStartedToday,
      attendancePct,totalDurationMinutes,closingDone,closingRequired,closingPending,anomalyCount,anomalyCounts,
      schedule:{
        workingDays:schedule.workingDays,expectedStartTime:schedule.expectedStartTime,expectedEndTime:schedule.expectedEndTime,
        lateToleranceMinutes:schedule.lateToleranceMinutes,earlyLeaveToleranceMinutes:schedule.earlyLeaveToleranceMinutes,
        longSessionMinutes:schedule.longSessionMinutes,source:schedule.source,
      },
      details:details.reverse(),
    };
    employees.push(item);
    totals.worked += workedDays; totals.working += workingDays; totals.present += presentWorkingDays; totals.absent += absentDays;
    totals.notStartedToday += notStartedToday ? 1 : 0; totals.closingDone += closingDone; totals.closingRequired += closingRequired;
    totals.closingPending += closingPending; totals.anomalyCount += anomalyCount;
  }
  totals.attendancePct = totals.working ? Math.round((totals.present/totals.working)*1000)/10 : 0;
  return { range:{from,to,effectiveTo,today}, totals, employees };
}

function exportRows(report) {
  const rows=[];
  for (const employee of report.employees) for (const d of [...employee.details].reverse()) {
    const first=d.sessions[0] || null;
    const last=d.sessions[d.sessions.length-1] || null;
    rows.push({
      Employee:employee.name, Date:d.day, Scheduled:d.working?'Working':'Off', Status:d.state,
      'Start Day':first?.startDayAt || '', 'End Day':d.hasOpen?'':(last?.endDayAt || ''),
      'Duration Minutes':d.durationMinutes, Sessions:d.sessionCount,
      'Expected Start':d.expectedStartTime || '', 'Expected End':d.expectedEndTime || '',
      'Late Minutes':d.lateMinutes, 'Early Leave Minutes':d.earlyLeaveMinutes,
      'Day Closing Required':d.closing.required?'Yes':'No',
      'Day Closing Status':d.closing.completed?'Completed':d.closing.pending?'Pending':'Not required',
      'Anomalies':d.anomalies.map(a=>a.label).join('; '),
    });
  }
  return rows;
}

function attendanceExceptionDetections(report) {
  const out=[];
  const add=(employee,day,a)=>out.push({
    type:`attendance_${a.type}`,severity:a.severity==='info'?'medium':a.severity,
    title:a.type==='missing_end'?'Missing End Day':a.type==='long_session'?'Unusually long attendance session':a.type==='late_start'?'Repeated/late Start Day':a.type==='closing_pending'?'Day Closing pending':a.type==='gps_missing'?'Attendance GPS missing':'Attendance issue',
    reason:a.label, action:'Open Attendance', entityType:'attendance', entityId:`${employee.userId}:${day.day}`,
    entityName:`${employee.name} · ${day.day}`, owner:employee.name,
    metadata:{userId:employee.userId,day:day.day,anomalyType:a.type,minutes:a.minutes||null,count:a.count||null},
  });
  for (const employee of report.employees) {
    let lateCount=0;
    for (const day of employee.details) {
      for (const a of day.anomalies) {
        if (a.type==='late_start') lateCount += 1;
        if (['missing_end','long_session','closing_pending','gps_missing'].includes(a.type)) add(employee,day,a);
      }
    }
    if (lateCount >= 3) out.push({
      type:'attendance_late_start',severity:'medium',title:'Repeated late starts',reason:`${lateCount} late starts in the review window`,action:'Open Attendance',
      entityType:'attendance',entityId:`${employee.userId}:late-starts`,entityName:employee.name,owner:employee.name,
      metadata:{userId:employee.userId,lateCount},
    });
  }
  return out;
}

module.exports={rangeDays,effectiveSchedule,calendarState,closingForDay,dayMetrics,loadAttendanceReport,exportRows,attendanceExceptionDetections};
