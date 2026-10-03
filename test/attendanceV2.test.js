const test=require('node:test');
const assert=require('node:assert/strict');
const { closingForDay, dayMetrics, exportRows }=require('../src/utils/attendanceReportV2');

const baseSchedule={
  expectedStartTime:'10:00',expectedEndTime:'19:00',lateToleranceMinutes:15,
  earlyLeaveToleranceMinutes:15,longSessionMinutes:720,workingDays:[1,2,3,4,5,6],
};

function session(overrides={}) {
  return {
    id:'a',session_number:1,start_day_at:'2026-10-03T04:30:00.000Z', // 10:00 IST
    end_day_at:'2026-10-03T13:30:00.000Z', // 19:00 IST
    start_lat:1,start_lng:1,end_lat:1,end_lng:1,closing_status:null,
    closing_required_snapshot:true,expected_start_time_snapshot:'10:00:00',expected_end_time_snapshot:'19:00:00',
    late_tolerance_minutes_snapshot:15,early_leave_tolerance_minutes_snapshot:15,long_session_minutes_snapshot:720,
    ...overrides,
  };
}

test('historical closing record overrides current policy',()=>{
  assert.deepEqual(closingForDay([session({closing_status:'not_required',closing_required_snapshot:null})],{require_closing:true}),{
    required:false,completed:false,pending:false,source:'closing_record',
  });
  assert.deepEqual(closingForDay([session({closing_status:'submitted',closing_required_snapshot:false})],{require_closing:false}),{
    required:true,completed:true,pending:false,source:'closing_record',
  });
});

test('snapshot controls pending closing independent of current policy',()=>{
  assert.deepEqual(closingForDay([session({closing_required_snapshot:true})],{require_closing:false}),{
    required:true,completed:false,pending:true,source:'attendance_snapshot',
  });
});

test('late and early flags respect configured tolerances',()=>{
  const metrics=dayMetrics({
    day:'2026-10-03',today:'2026-10-03',now:'2026-10-03T14:00:00.000Z',schedule:baseSchedule,policy:{require_closing:true},
    sessions:[session({start_day_at:'2026-10-03T05:01:00.000Z',end_day_at:'2026-10-03T12:59:00.000Z'})], // 10:31 to 18:29 IST
  });
  assert.equal(metrics.lateMinutes,16);
  assert.equal(metrics.earlyLeaveMinutes,16);
  assert.ok(metrics.anomalies.some(a=>a.type==='late_start'));
  assert.ok(metrics.anomalies.some(a=>a.type==='early_end'));
});

test('missing End Day is separate from Day Closing and long-session anomaly',()=>{
  const metrics=dayMetrics({
    day:'2026-10-02',today:'2026-10-03',now:'2026-10-03T10:00:00.000Z',schedule:baseSchedule,policy:{require_closing:true},
    sessions:[session({start_day_at:'2026-10-02T04:30:00.000Z',end_day_at:null})],
  });
  assert.equal(metrics.staleOpen,true);
  assert.ok(metrics.anomalies.some(a=>a.type==='missing_end'));
  assert.ok(metrics.anomalies.some(a=>a.type==='long_session'));
  assert.ok(metrics.anomalies.some(a=>a.type==='closing_pending'));
});

test('multiple Start/End cycles aggregate duration and expose session count',()=>{
  const metrics=dayMetrics({
    day:'2026-10-03',today:'2026-10-03',now:'2026-10-03T14:00:00.000Z',schedule:baseSchedule,policy:{require_closing:false},
    sessions:[
      session({id:'a',session_number:1,start_day_at:'2026-10-03T04:30:00.000Z',end_day_at:'2026-10-03T08:30:00.000Z',closing_required_snapshot:false,closing_status:'not_required'}),
      session({id:'b',session_number:2,start_day_at:'2026-10-03T09:00:00.000Z',end_day_at:'2026-10-03T14:00:00.000Z',closing_required_snapshot:false,closing_status:'not_required'}),
    ],
  });
  assert.equal(metrics.sessionCount,2);
  assert.equal(metrics.durationMinutes,540);
  assert.ok(metrics.anomalies.some(a=>a.type==='multiple_sessions'));
});

test('export row carries payroll/audit fields',()=>{
  const rows=exportRows({employees:[{name:'Anand',details:[{
    day:'2026-10-03',working:true,state:'Present',sessions:[{startDayAt:'s',endDayAt:'e'}],hasOpen:false,durationMinutes:540,sessionCount:2,
    expectedStartTime:'10:00',expectedEndTime:'19:00',lateMinutes:0,earlyLeaveMinutes:0,
    closing:{required:false,completed:false,pending:false},anomalies:[{label:'2 sessions'}],
  }]}]});
  assert.equal(rows[0].Employee,'Anand');
  assert.equal(rows[0].Sessions,2);
  assert.equal(rows[0]['Day Closing Status'],'Not required');
  assert.equal(rows[0].Anomalies,'2 sessions');
});
