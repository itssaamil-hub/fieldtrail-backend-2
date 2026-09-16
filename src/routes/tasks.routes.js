const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
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
 const conditions = {all:'true',today:"t.status='pending' AND (t.due_at AT TIME ZONE 'Asia/Kolkata')::date=(now() AT TIME ZONE 'Asia/Kolkata')::date",upcoming:"t.status='pending' AND (t.due_at AT TIME ZONE 'Asia/Kolkata')::date>(now() AT TIME ZONE 'Asia/Kolkata')::date",overdue:"t.status='pending' AND t.due_at<now()",completed:"t.status='completed'"};
 const taskId=req.query.taskId||null;
 if(taskId && (typeof taskId!=='string'||!UUID.test(taskId))) throw fail('Invalid task');
 const args = [req.user.role==='admin'?null:req.user.id,lead];
 const access = '($1::uuid IS NULL OR t.assigned_to=$1) AND ($2::uuid IS NULL OR t.lead_id=$2)';
 const {rows} = await db.query(`${projection} WHERE ${access} AND ${conditions[filter]} AND ($4::uuid IS NULL OR t.id=$4) ORDER BY t.due_at,t.id LIMIT 51 OFFSET $3`,[...args,offset,taskId]);
 const {rows:counts} = await db.query(`SELECT count(*)::integer AS pending FROM crm_tasks t WHERE ${access} AND t.status='pending'`,args);
 res.json({tasks:rows.slice(0,50),hasMore:rows.length>50,pending:counts[0].pending});
});
router.get('/notifications',async(req,res)=>{
 const {rows}=await db.query(`SELECT n.id,n.task_id,n.kind,n.created_at,t.title,t.due_at,l.business_name FROM task_notifications n JOIN crm_tasks t ON t.id=n.task_id LEFT JOIN leads l ON l.id=t.lead_id WHERE n.user_id=$1 AND n.read_at IS NULL AND t.status='pending' ORDER BY n.created_at DESC,n.id DESC LIMIT 30`,[req.user.id]);
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
 const {rows}=await client.query(`INSERT INTO crm_tasks(title,notes,lead_id,assigned_to,created_by,due_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[b.title.trim(),b.notes||'',b.leadId||null,assignee,req.user.id,b.dueAt]);
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
 }
 await client.query('COMMIT');res.json({ok:true});
 }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});
router.use((err,req,res,next)=>{if(err.status) return res.status(err.status).json({error:err.message});next(err);});
module.exports=router;
