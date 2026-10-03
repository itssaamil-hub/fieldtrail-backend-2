const test=require('node:test');
const assert=require('node:assert/strict');
const {
  requireCompanySchedule,effectiveSchedule,calendarState,closingForDay,dayMetrics,loadAttendanceReport,
}=require('../src/utils/attendanceReportV2');

const USER='11111111-1111-4111-8111-111111111111';
const company={
  id:1,working_days:[1,2,3,4,5,6],expected_start_time:'10:00:00',expected_end_time:'19:00:00',
  late_tolerance_minutes:15,early_leave_tolerance_minutes:15,long_session_minutes:720,version:4,
};
const schedule={
  workingDays:[1,2,3,4,5,6],expectedStartTime:'10:00',expectedEndTime:'19:00',
  lateToleranceMinutes:15,earlyLeaveToleranceMinutes:15,longSessionMinutes:720,
};

function session(overrides={}){
  return {
    id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',salesman_id:USER,day:'2026-10-02',session_number:1,
    start_day_at:'2026-10-02T04:30:00.000Z',end_day_at:'2026-10-02T13:30:00.000Z',
    start_lat:1,start_lng:1,end_lat:1,end_lng:1,closing_status:'not_required',
    closing_required_snapshot:false,expected_start_time_snapshot:'10:00:00',expected_end_time_snapshot:'19:00:00',
    late_tolerance_minutes_snapshot:15,early_leave_tolerance_minutes_snapshot:15,long_session_minutes_snapshot:720,
    ...overrides,
  };
}

test('missing canonical company schedule fails instead of inventing defaults',()=>{
  assert.throws(()=>requireCompanySchedule(null),error=>error.code==='ATTENDANCE_CONFIGURATION_MISSING');
  assert.throws(()=>requireCompanySchedule({working_days:[],late_tolerance_minutes:0,early_leave_tolerance_minutes:0,long_session_minutes:720}),/working days/i);
  assert.throws(()=>requireCompanySchedule({working_days:[1],late_tolerance_minutes:null,early_leave_tolerance_minutes:0,long_session_minutes:720}),/tolerance settings/i);
});

test('employee schedule inherits only real company values',()=>{
  const inherited=effectiveSchedule(USER,company,[]);
  assert.deepEqual(inherited.workingDays,[1,2,3,4,5,6]);
  assert.equal(inherited.lateToleranceMinutes,15);
  assert.equal(inherited.longSessionMinutes,720);
  const overridden=effectiveSchedule(USER,company,[{
    user_id:USER,working_days:[1,2,3,4,5],expected_start_time:'09:30:00',expected_end_time:null,
    late_tolerance_minutes:5,early_leave_tolerance_minutes:null,long_session_minutes:600,
  }]);
  assert.deepEqual(overridden.workingDays,[1,2,3,4,5]);
  assert.equal(overridden.expectedStartTime,'09:30:00');
  assert.equal(overridden.expectedEndTime,'19:00:00');
  assert.equal(overridden.lateToleranceMinutes,5);
  assert.equal(overridden.earlyLeaveToleranceMinutes,15);
  assert.equal(overridden.longSessionMinutes,600);
});

test('off-day work remains recorded without turning the off-day into a scheduled day',()=>{
  const sunday='2026-10-04';
  const calendar=calendarState(sunday,USER,schedule,[]);
  assert.equal(calendar.working,false);
  const metrics=dayMetrics({
    day:sunday,today:sunday,now:'2026-10-04T13:30:00.000Z',schedule,policy:{require_closing:false},
    sessions:[session({day:sunday,start_day_at:'2026-10-04T04:30:00.000Z',end_day_at:'2026-10-04T13:30:00.000Z'})],
  });
  assert.equal(metrics.sessionCount,1);
  assert.equal(metrics.durationMinutes,540);
});

test('leave, weekly off and special working day override expectation by date',()=>{
  const day='2026-10-01';
  assert.equal(calendarState(day,USER,schedule,[{user_id:USER,day,kind:'leave'}]).working,false);
  assert.equal(calendarState(day,USER,schedule,[{user_id:USER,day,kind:'weekly_off'}]).working,false);
  const sunday='2026-10-04';
  assert.equal(calendarState(sunday,USER,schedule,[{user_id:USER,day:sunday,kind:'working_day'}]).working,true);
});

test('skipped closing is completed and not pending',()=>{
  assert.deepEqual(closingForDay([session({closing_status:'skipped',closing_required_snapshot:true})],{require_closing:true}),{
    required:true,completed:true,pending:false,source:'closing_record',
  });
});

test('legacy worked sessions without timing snapshots do not borrow current timing policy',()=>{
  const metrics=dayMetrics({
    day:'2026-10-02',today:'2026-10-03',now:'2026-10-03T10:00:00.000Z',schedule,policy:{require_closing:false},
    sessions:[session({
      start_day_at:'2026-10-02T06:00:00.000Z',end_day_at:'2026-10-02T16:00:00.000Z',
      expected_start_time_snapshot:null,expected_end_time_snapshot:null,
      late_tolerance_minutes_snapshot:null,early_leave_tolerance_minutes_snapshot:null,long_session_minutes_snapshot:null,
    })],
  });
  assert.equal(metrics.expectedStartTime,null);
  assert.equal(metrics.expectedEndTime,null);
  assert.equal(metrics.lateMinutes,0);
  assert.equal(metrics.earlyLeaveMinutes,0);
  assert.equal(metrics.anomalies.some(a=>a.type==='late_start'),false);
  assert.equal(metrics.anomalies.some(a=>a.type==='early_end'),false);
  assert.equal(metrics.anomalies.some(a=>a.type==='long_session'),false);
});

test('canonical report caps future dates, preserves employee filter and crosses month boundary correctly',async()=>{
  const seen=[];
  const query=async(sql,params=[])=>{
    seen.push({sql,params});
    if(sql.includes("CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'")) return {rows:[{today:'2026-10-03',now:'2026-10-03T10:00:00.000Z'}]};
    if(sql.includes('FROM users u')) return {rows:[{id:USER,full_name:'Anand',is_active:true}]};
    if(sql.includes('FROM attendance_company_schedule')) return {rows:[company]};
    if(sql.includes('FROM attendance_employee_schedule')) return {rows:[]};
    if(sql.includes('FROM attendance_calendar_exceptions')) return {rows:[{id:1,user_id:USER,day:'2026-10-01',kind:'leave',label:'Approved',created_by:null,actor_name:null,created_at:null}]};
    if(sql.includes('FROM attendance a LEFT JOIN day_closing_reports')) return {rows:[
      session({day:'2026-09-30',id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',start_day_at:'2026-09-30T04:30:00.000Z',end_day_at:'2026-09-30T13:30:00.000Z'}),
      session({day:'2026-10-02',id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'}),
    ]};
    if(sql.includes('FROM employee_day_closing_permissions')) return {rows:[{user_id:USER,require_closing:false}]};
    throw new Error(`Unexpected query: ${sql}`);
  };

  const report=await loadAttendanceReport(query,{from:'2026-09-30',to:'2026-10-05',employee:USER,userScope:null});
  assert.equal(report.range.effectiveTo,'2026-10-03');
  assert.equal(report.employees.length,1);
  assert.equal(report.employees[0].userId,USER);
  assert.deepEqual(report.employees[0].details.map(d=>d.day),['2026-10-03','2026-10-02','2026-10-01','2026-09-30']);
  const leave=report.employees[0].details.find(d=>d.day==='2026-10-01');
  assert.equal(leave.working,false);
  assert.equal(leave.state,'leave');
  assert.equal(report.employees[0].absentDays,0);
  assert.equal(report.employees[0].notStartedToday,true);
  const userQuery=seen.find(item=>item.sql.includes('FROM users u'));
  assert.equal(userQuery.params[0],USER);
  assert.equal(userQuery.params[2],'2026-09-30');
  assert.equal(userQuery.params[3],'2026-10-05');
});
