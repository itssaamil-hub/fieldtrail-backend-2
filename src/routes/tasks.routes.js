const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
const { nextTaskDue } = require('../utils/taskRecurrence');
const PRIORITIES = ['high','medium','low'];
const RECURRENCES = ['none','daily','weekly','monthly'];
const validDue = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const event = (client, task, actor, action, oldValue, newValue, reason='') => client.query('INSERT INTO task_events(task_id,actor_id,action,old_value,new_value,reason) VALUES($1,$2,$3,$4,$5,$6)',[task,actor,action,oldValue,newValue,reason]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
router.use(requireAuth);
router.use(async (req,res,next) => {
 const {rows} = await db.query('SELECT id FROM users WHERE id=$1 AND is_active=true AND role=$2', [req.user.id,req.user.role]);
 if (!rows.length || !['admin','salesman'].includes(req.user.role)) return res.status(403).json({error:'Active account required'});
 next();
});
const projection = `SELECT t.*, l.business_name, u.full_name AS assignee_name FROM crm_tasks t
 LEFT JOIN leads l ON l.id=t.lead_id JOIN users u ON u.id=t.assigned_to`;
router.get('/', async (req,res) => {
 const filter = req.query.filter || 'all';
 if (!['all','today','upcoming','overdue','completed'].includes(filter)) throw fail('Invalid task filter');
 const offset = Number(req.query.offset || 0);
 if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw fail('Invalid offset');
 const lead = req.query.leadId || null;
 if (lead && (typeof lead!=='string'||!UUID.test(lead))) throw fail('Invalid lead');
 const conditions = {all:'true',today:"t.status IN ('pending','in_progress') AND (t.due_at AT TIME ZONE 'Asia/Kolkata')::date=(now() AT TIME ZONE 'Asia/Kolkata')::date",upcoming:"t.status IN ('pending','in_progress') AND (t.due_at AT TIME ZONE 'Asia/Kolkata')::date>(now() AT TIME ZONE 'Asia/Kolkata')::date",overdue:"t.status IN ('pending','in_progress') AND t.due_at<now()",completed:"t.status='completed'"};
 const taskId=req.query.taskId||null;
 if(taskId && (typeof taskId!=='string'||!UUID.test(taskId))) throw fail('Invalid task');
 const assigned = req.query.assignedTo || null;
 if (assigned && (typeof assigned !== 'string' || !UUID.test(assigned))) throw fail('Invalid employee');
 const priority = req.query.priority || null;
 if (priority && !PRIORITIES.includes(priority)) throw fail('Invalid priority');
 const progress = req.query.status || null;
 if (progress && !['pending','in_progress','completed'].includes(progress)) throw fail('Invalid progress');
 const search = req.query.search || '';
 if (typeof search !== 'string' || search.length > 180) throw fail('Search must be at most 180 characters');
 const from = req.query.from || null, to = req.query.to || null;
 for (const day of [from,to]) if (day && (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0,10)!==day)) throw fail('Invalid date filter');
 if (from && to && from > to) throw fail('From date must be before through date');
 const args = [req.user.role==='admin'?null:req.user.id,lead];
 const access = '($1::uuid IS NULL OR t.assigned_to=$1) AND ($2::uuid IS NULL OR t.lead_id=$2)';
 const {rows} = await db.query(`${projection} WHERE ${access} AND ${conditions[filter]} AND ($4::uuid IS NULL OR t.id=$4)
 AND ($5::uuid IS NULL OR t.assigned_to=$5) AND ($6::text IS NULL OR t.priority=$6)
 AND ($7::text IS NULL OR t.status=$7)
 AND ($8='' OR strpos(lower(t.title || ' ' || coalesce(l.business_name,'')),lower($8))>0)
 AND ($9::date IS NULL OR (t.due_at AT TIME ZONE 'Asia/Kolkata')::date >= $9)
 AND ($10::date IS NULL OR (t.due_at AT TIME ZONE 'Asia/Kolkata')::date <= $10)
 ORDER BY t.due_at,t.id LIMIT 51 OFFSET $3`,[...args,offset,taskId,assigned,priority,progress,search,from,to]);
 const {rows:counts} = await db.query(`SELECT count(*)::integer AS pending FROM crm_tasks t WHERE ${access} AND t.status IN ('pending','in_progress')`,args);
 res.json({tasks:rows.slice(0,50),hasMore:rows.length>50,pending:counts[0].pending,workflowVersion:2});
});
router.get('/notifications',async(req,res)=>{
 const {rows}=await db.query(`SELECT n.id,n.task_id,n.kind,n.created_at,t.title,t.due_at,l.business_name FROM task_notifications n JOIN crm_tasks t ON t.id=n.task_id LEFT JOIN leads l ON l.id=t.lead_id WHERE n.user_id=$1 AND n.read_at IS NULL AND t.status IN ('pending','in_progress') ORDER BY n.created_at DESC,n.id DESC LIMIT 30`,[req.user.id]);
 res.json({notifications:rows});
});
router.post('/notifications/read',async(req,res)=>{
 const ids=req.body?.ids;
 if(!Array.isArray(ids)||ids.length>30||ids.some(id=>typeof id!=='string'||!UUID.test(id))) throw fail('Invalid notification IDs');
 await db.query('UPDATE task_notifications SET read_at=now() WHERE user_id=$1 AND id=ANY($2::uuid[])',[req.user.id,ids]);
 res.json({ok:true});
});
router.post('/',async(req,res)=>{
 const b=req.body||{};
 if (b.priority != null && !PRIORITIES.includes(b.priority)) throw fail('Invalid priority');
 if (b.recurrence != null && !RECURRENCES.includes(b.recurrence)) throw fail('Invalid recurrence');
 if(typeof b.title!=='string'||!b.title.trim()||b.title.trim().length>180) throw fail('Task title must be 1–180 characters');
 if(b.notes!=null&&(typeof b.notes!=='string'||b.notes.length>2000)) throw fail('Notes must be at most 2000 characters');
 if(typeof b.dueAt!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(b.dueAt)||!Number.isFinite(Date.parse(b.dueAt))) throw fail('Choose a valid due date and time');
 const assignee=b.assignedTo||req.user.id;
 if(typeof assignee!=='string'||!UUID.test(assignee)) throw fail('Choose an employee');
 if(req.user.role!=='admin'&&assignee!==req.user.id) throw fail('You can only create your own tasks',403);
 if(b.leadId!=null&&(typeof b.leadId!=='string'||!UUID.test(b.leadId))) throw fail('Invalid lead');
 const client=await db.pool.connect();
 try{
 await client.query('BEGIN');
 const {rows:users}=await client.query("SELECT id FROM users WHERE id=$1 AND role='salesman' AND is_active=true FOR SHARE",[assignee]);
 if(!users.length) throw fail('Choose an active employee');
 let business=null;
 if(b.leadId){
 const {rows}=await client.query('SELECT business_name,salesman_id FROM leads WHERE id=$1 FOR SHARE',[b.leadId]);
 if(!rows.length||rows[0].salesman_id!==assignee) throw fail('The linked lead must belong to the assigned employee');
 business=rows[0].business_name;
 }
 const {rows}=await client.query(`INSERT INTO crm_tasks(title,notes,lead_id,assigned_to,created_by,due_at,priority,recurrence,recurrence_day) VALUES($1,$2,$3,$4,$5,$6,$7,$8,EXTRACT(DAY FROM ($6::timestamptz AT TIME ZONE 'Asia/Kolkata'))::int) RETURNING *`,[b.title.trim(),b.notes||'',b.leadId||null,assignee,req.user.id,b.dueAt,b.priority||'medium',b.recurrence||'none']);
 const task=rows[0];
 await client.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'task.created','task',$2,$3::jsonb)`,[req.user.id,task.id,JSON.stringify({taskTitle:task.title,businessName:business,recipientId:assignee})]);
 await client.query("INSERT INTO task_notifications(user_id,task_id,kind) VALUES($1,$2,'assigned')",[assignee,task.id]);
 await client.query('COMMIT');res.status(201).json({task});
 }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});
router.patch('/:id/complete',async(req,res)=>{
 if(!UUID.test(req.params.id)) throw fail('Invalid task');
 const note=req.body?.note||'';
 if(typeof note!=='string'||note.length>2000) throw fail('Completion note must be at most 2000 characters');
 const client=await db.pool.connect();
 try{
 await client.query('BEGIN');
 const {rows}=await client.query('SELECT * FROM crm_tasks WHERE id=$1 AND ($2::uuid IS NULL OR assigned_to=$2) FOR UPDATE',[req.params.id,req.user.role==='admin'?null:req.user.id]);
 if(!rows.length) throw fail('Task not found',404);
 if(rows[0].status!=='completed'){
 await client.query("UPDATE crm_tasks SET status='completed',completed_at=now(),completion_note=$2 WHERE id=$1",[req.params.id,note]);
 await client.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'task.completed','task',$2,$3::jsonb)`,[req.user.id,req.params.id,JSON.stringify({taskTitle:rows[0].title,recipientId:rows[0].assigned_to})]);
 await client.query('UPDATE task_notifications SET read_at=now() WHERE task_id=$1 AND read_at IS NULL',[req.params.id]);
 await event(client, req.params.id, req.user.id, 'completed', rows[0].status, 'completed', note);
 const previous = rows[0];
 const nextDue = nextTaskDue(previous.due_at, previous.recurrence, previous.recurrence_day);
 if (nextDue) {
  // One child per occurrence plus the locked parent makes retries/concurrent completions safe.
  // Keep the assignment; remove a stale lead link if ownership changed since creation.
  const {rows:next}=await client.query(`INSERT INTO crm_tasks(title,notes,lead_id,assigned_to,created_by,due_at,priority,recurrence,recurrence_day,repeat_of)
   SELECT $1,$2,(SELECT id FROM leads WHERE id=$3 AND salesman_id=$4),$4,$5,$6,$7,$8,$9,$10
   FROM users WHERE id=$4 AND is_active=true AND role='salesman'
   ON CONFLICT(repeat_of) WHERE repeat_of IS NOT NULL DO NOTHING RETURNING id`,
   [previous.title,previous.notes,previous.lead_id,previous.assigned_to,previous.created_by,nextDue,previous.priority,previous.recurrence,previous.recurrence_day,previous.id]);
  if (next.length) await client.query("INSERT INTO task_notifications(user_id,task_id,kind) VALUES($1,$2,'assigned')",[previous.assigned_to,next[0].id]);
 }

 }
 await client.query('COMMIT');res.json({ok:true});
 }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});
// Lead lookup is scoped to the current salesman, or the admin-selected assignee.
router.get('/leads',async(req,res)=>{
 const assigned=req.user.role==='admin'?req.query.assignedTo:req.user.id;
 if (typeof assigned!=='string'||!UUID.test(assigned)) throw fail('Choose an employee first');
 const search=req.query.search||'';
 if(typeof search!=='string'||search.length>180) throw fail('Invalid search');
 const {rows}=await db.query(`SELECT id,business_name FROM leads WHERE salesman_id=$1
  AND ($2='' OR strpos(lower(business_name),lower($2))>0) ORDER BY business_name,id LIMIT 50`,[assigned,search]);
 res.json({leads:rows});
});
router.get('/:id',async(req,res)=>{
 if(!UUID.test(req.params.id)) throw fail('Invalid task');
 const {rows}=await db.query(`${projection} WHERE t.id=$1 AND ($2::uuid IS NULL OR t.assigned_to=$2)`,[req.params.id,req.user.role==='admin'?null:req.user.id]);
 if(!rows.length) throw fail('Task not found',404);
 const {rows:events}=await db.query(`SELECT e.*,u.full_name AS actor_name FROM task_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.task_id=$1 ORDER BY e.created_at DESC,e.id DESC LIMIT 100`,[req.params.id]);
 res.json({task:rows[0],events});
});
router.patch('/:id/status',async(req,res)=>{
 if(!UUID.test(req.params.id)) throw fail('Invalid task');
 const status=req.body?.status;
 if(!['pending','in_progress'].includes(status)) throw fail('Choose To do or In progress');
 const client=await db.pool.connect();
 try {
  await client.query('BEGIN');
  const {rows}=await client.query('SELECT * FROM crm_tasks WHERE id=$1 AND ($2::uuid IS NULL OR assigned_to=$2) FOR UPDATE',[req.params.id,req.user.role==='admin'?null:req.user.id]);
  if(!rows.length) throw fail('Task not found',404);
  const t=rows[0];
  if(t.status==='completed') throw fail('Completed tasks cannot be reopened',409);
  if(t.status!==status){
   await client.query('UPDATE crm_tasks SET status=$2 WHERE id=$1',[t.id,status]);
   await event(client,t.id,req.user.id,'status_changed',t.status,status);
  }
  await client.query('COMMIT');res.json({ok:true});
 }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});
router.patch('/:id/reschedule',async(req,res)=>{
 if(!UUID.test(req.params.id)) throw fail('Invalid task');
 const {dueAt,reason}=req.body||{};
 if(!validDue(dueAt)) throw fail('Choose a valid due date and time');
 if(typeof reason!=='string'||!reason.trim()||reason.trim().length>2000) throw fail('A reschedule reason is required (up to 2000 characters)');
 const client=await db.pool.connect();
 try {
  await client.query('BEGIN');
  const {rows}=await client.query('SELECT * FROM crm_tasks WHERE id=$1 AND ($2::uuid IS NULL OR assigned_to=$2) FOR UPDATE',[req.params.id,req.user.role==='admin'?null:req.user.id]);
  if(!rows.length) throw fail('Task not found',404);
  const t=rows[0];
  if(t.status==='completed') throw fail('Completed tasks cannot be rescheduled',409);
  if(new Date(t.due_at).getTime()!==Date.parse(dueAt)){
   await client.query("UPDATE crm_tasks SET due_at=$2,recurrence_day=EXTRACT(DAY FROM ($2::timestamptz AT TIME ZONE 'Asia/Kolkata'))::int WHERE id=$1",[t.id,dueAt]);
   await event(client,t.id,req.user.id,'rescheduled',new Date(t.due_at).toISOString(),new Date(dueAt).toISOString(),reason.trim());
   await client.query("UPDATE task_notifications SET read_at=now() WHERE task_id=$1 AND kind='reminder' AND read_at IS NULL",[t.id]);
  }
  await client.query('COMMIT');res.json({ok:true});
 }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});
router.patch('/:id/options',async(req,res)=>{
 if(!UUID.test(req.params.id)) throw fail('Invalid task');
 const {priority,recurrence}=req.body||{};
 if(!PRIORITIES.includes(priority)||!RECURRENCES.includes(recurrence)) throw fail('Choose a valid priority and recurrence');
 const client=await db.pool.connect();
 try {
  await client.query('BEGIN');
  const {rows}=await client.query(`SELECT * FROM crm_tasks WHERE id=$1 AND ($2::uuid IS NULL OR (assigned_to=$2 AND created_by=$2)) FOR UPDATE`,[req.params.id,req.user.role==='admin'?null:req.user.id]);
  if(!rows.length) throw fail('Task not found or you cannot edit its settings',404);
  const t=rows[0];
  if(t.status==='completed') throw fail('Edit the next occurrence instead of a completed task',409);
  await client.query("UPDATE crm_tasks SET priority=$2,recurrence=$3,recurrence_day=coalesce(recurrence_day,EXTRACT(DAY FROM (due_at AT TIME ZONE 'Asia/Kolkata'))::int) WHERE id=$1",[t.id,priority,recurrence]);
  if(t.priority!==priority) await event(client,t.id,req.user.id,'priority_changed',t.priority,priority);
  if(t.recurrence!==recurrence) await event(client,t.id,req.user.id,'recurrence_changed',t.recurrence,recurrence);
  await client.query('COMMIT');res.json({ok:true});
 }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});

router.delete('/:id', async (req,res) => {
 if (!UUID.test(req.params.id)) throw fail('Invalid task');
 const client=await db.pool.connect();
 try {
  await client.query('BEGIN');
  const {rows}=await client.query(`SELECT * FROM crm_tasks WHERE id=$1 AND
   ($2::uuid IS NULL OR (assigned_to=$2 AND created_by=$2)) FOR UPDATE`,
   [req.params.id,req.user.role==='admin'?null:req.user.id]);
  if (!rows.length) throw fail('Task not found or you cannot delete it',404);
  await client.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
   VALUES($1,'task.deleted','task',$2,$3::jsonb)`,
   [req.user.id,req.params.id,JSON.stringify({taskTitle:rows[0].title,recipientId:rows[0].assigned_to})]);
  // Associated task alerts are removed by the foreign-key cascade.
  await client.query('DELETE FROM crm_tasks WHERE id=$1',[req.params.id]);
  await client.query('COMMIT');
  res.json({ok:true});
 } catch(err) { await client.query('ROLLBACK'); throw err; }
 finally { client.release(); }
});
router.use((err,req,res,next)=>{if(err.status) return res.status(err.status).json({error:err.message});next(err);});
module.exports=router;
