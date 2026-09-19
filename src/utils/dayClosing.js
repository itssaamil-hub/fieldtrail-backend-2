const db=require('../db');
const {bad,str,day}=require('./quotations');
const {notifyDayEvent}=require('./pushNotifications');
const DEFAULTS={require_closing:false,allow_skip:false,require_skip_reason:true,allow_multiple_starts:false,version:0};
async function permissions(query,userId){const {rows}=await query('SELECT * FROM employee_day_closing_permissions WHERE user_id=$1',[userId]);return rows[0]||{...DEFAULTS};}
function validateClosing(p,b){const mode=b.mode||'none';if(!['submit','skip','none'].includes(mode))throw bad('Invalid closing action');if(mode==='none'&&p.require_closing)throw bad('Submit your Day Closing report before ending the day.',409);if(mode==='skip'&&!p.allow_skip)throw bad('Admin has not allowed you to skip Day Closing.',403);const fields={outcomes:str(b.outcomes||'',2000),blockers:str(b.blockers||'',2000),priorities:str(b.priorities||'',2000),skip_reason:str(b.skipReason||'',1000)};if(mode==='submit'&&(!fields.outcomes||!fields.priorities))throw bad('Enter outcomes and tomorrow’s priorities.');if(mode==='skip'&&p.require_skip_reason&&!fields.skip_reason)throw bad('A reason is required when skipping.');return {...fields,status:mode==='submit'?'submitted':mode==='skip'?'skipped':'not_required'};}
async function metrics(query,userId,reportDay){const {rows}=await query(`SELECT
 (SELECT count(*)::int FROM leads WHERE salesman_id=$1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=$2::date) AS leads,
 (SELECT count(*)::int FROM crm_tasks WHERE assigned_to=$1 AND status='completed' AND (completed_at AT TIME ZONE 'Asia/Kolkata')::date=$2::date) AS tasks,
 (SELECT count(DISTINCT quote_id)::int FROM quotation_events WHERE actor_id=$1 AND action='sent' AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=$2::date) AS quotes,
 (SELECT count(DISTINCT entity_id)::int FROM activity_logs WHERE actor_id=$1 AND action='lead.status_changed' AND metadata->>'to'='won' AND metadata->>'from' IS DISTINCT FROM 'won' AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=$2::date) AS won`,[userId,reportDay]);return rows[0];}
async function activeAttendance(query,id){const {rows}=await query("SELECT *,day::text AS day FROM attendance WHERE salesman_id=$1 AND start_day_at IS NOT NULL AND end_day_at IS NULL ORDER BY start_day_at DESC LIMIT 1 FOR UPDATE",[id]);return rows[0];}
async function startDay(userId,b){
 const c=await db.pool.connect(),query=c.query.bind(c);
 try{
  await query('BEGIN');
  const {rows}=await query("SELECT id FROM users WHERE id=$1 AND role='salesman' AND is_active=true FOR UPDATE",[userId]);
  if(!rows.length)throw bad('Active employee required',403);
  const active=await activeAttendance(query,userId);
  if(active){
   // Already running (e.g. double tap, or app reopened). Make sure the admin dashboard agrees.
   await query("UPDATE salesman_profiles SET status='online',last_seen_at=now() WHERE user_id=$1",[userId]);
   await query('COMMIT');return {ok:true};
  }
  const today=day();
  // Employee Day Closing permission is authoritative. A legacy global
  // location setting must never override an explicit employee OFF value.
  const allowMultiple=!!(await permissions(query,userId)).allow_multiple_starts;
  const prior=await query('SELECT COALESCE(MAX(session_number),0) AS max_session, count(*) FILTER (WHERE end_day_at IS NOT NULL) AS ended_count FROM attendance WHERE salesman_id=$1 AND day=$2',[userId,today]);
  const {max_session,ended_count}=prior.rows[0];
  if(Number(ended_count)>0&&!allowMultiple)throw bad('Your day has already ended. You can start again tomorrow.',409);
  const nextSession=Number(max_session)+1;
  const coord=(v,max)=>{if(v==null)return null;if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>max)throw bad('Invalid location');return v;};
  await query(`INSERT INTO attendance(salesman_id,day,session_number,start_day_at,start_lat,start_lng) VALUES($1,$2,$3,now(),$4,$5)`,[userId,today,nextSession,coord(b.lat,90),coord(b.lng,180)]);
  await query("UPDATE salesman_profiles SET status='online',last_seen_at=now() WHERE user_id=$1",[userId]);
  await query("INSERT INTO activity_logs(actor_id,action,entity_type,metadata) VALUES($1,'attendance.day_start','attendance','{}')",[userId]);
  await query("INSERT INTO notifications(type,salesman_id,payload) VALUES('day_started',$1,'{}')",[userId]);
  await query('COMMIT');
  // Await the push attempt so Start Day and End Day have identical, reliable
  // notification behaviour. notifyDayEvent itself never throws.
  await notifyDayEvent({userId,kind:'start',sessionNumber:nextSession});
  return {ok:true,startedNew:true,sessionNumber:nextSession};
 }catch(e){await query('ROLLBACK');throw e;}finally{c.release();}
}
async function endDay(userId,b){const c=await db.pool.connect(),query=c.query.bind(c);try{await query('BEGIN');const {rows}=await query("SELECT id FROM users WHERE id=$1 AND role='salesman' AND is_active=true FOR UPDATE",[userId]);if(!rows.length)throw bad('Active employee required',403);const a=await activeAttendance(query,userId);if(!a){const previous=await query('SELECT id FROM attendance WHERE salesman_id=$1 AND day=$2 AND end_day_at IS NOT NULL',[userId,day()]);if(previous.rows.length){await query('COMMIT');return {ok:true};}throw bad('No active day found. Start your day first.',409);}if(b.attendanceId&&b.attendanceId!==a.id)throw bad('Your active day changed. Reopen Day Closing.',409);
 const p=await permissions(query,userId),fields=validateClosing(p,b);
 const existing=(await query('SELECT version FROM day_closing_reports WHERE attendance_id=$1',[a.id])).rows[0];if(b.version!==undefined&&b.version!==(existing?.version||0))throw bad('Report changed. Reload before submitting.',409);
 const summary=await metrics(query,userId,a.day);
 await query(`INSERT INTO day_closing_reports(attendance_id,user_id,day,status,outcomes,blockers,priorities,skip_reason,metrics,permissions,submitted_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,now()) ON CONFLICT(attendance_id) DO UPDATE SET status=EXCLUDED.status,outcomes=EXCLUDED.outcomes,blockers=EXCLUDED.blockers,priorities=EXCLUDED.priorities,skip_reason=EXCLUDED.skip_reason,metrics=EXCLUDED.metrics,permissions=EXCLUDED.permissions,submitted_at=now(),updated_at=now(),version=day_closing_reports.version+1`,[a.id,userId,a.day,fields.status,fields.outcomes,fields.blockers,fields.priorities,fields.skip_reason,JSON.stringify(summary),JSON.stringify(p)]);
 const coord=(v,max)=>{if(v==null)return null;if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>max)throw bad('Invalid location');return v;};
 await query('UPDATE attendance SET end_day_at=now(),end_lat=$2,end_lng=$3 WHERE id=$1',[a.id,coord(b.lat,90),coord(b.lng,180)]);
 await query("UPDATE salesman_profiles SET status='offline',last_seen_at=now() WHERE user_id=$1",[userId]);
 await query("INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'attendance.day_end','attendance',$2,$3::jsonb)",[userId,a.id,JSON.stringify({closingStatus:fields.status})]);
 await query("INSERT INTO notifications(type,salesman_id,payload) VALUES('day_ended',$1,$2::jsonb)",[userId,JSON.stringify({closingStatus:fields.status})]);
 await query('COMMIT');
 await notifyDayEvent({userId,kind:'end',sessionNumber:a.session_number,closingStatus:fields.status});
 return {ok:true,ended:true,sessionNumber:a.session_number};}catch(e){await query('ROLLBACK');throw e;}finally{c.release();}}
module.exports={DEFAULTS,permissions,validateClosing,metrics,activeAttendance,startDay,endDay};
