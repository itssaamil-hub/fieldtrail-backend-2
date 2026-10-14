// Durable bell reminders for pending tasks due today or overdue in IST.
// Safe to call repeatedly: the UNIQUE(user_id,task_id,kind,day) constraint dedupes per day.
async function ensureTaskRemindersForUser(userId, query=require('../db').query){
 if(!userId) return {taskReminders:0};
 const {rows}=await query(`INSERT INTO task_notifications(user_id,task_id,kind,day)
 SELECT t.assigned_to,t.id,'reminder',(now() AT TIME ZONE 'Asia/Kolkata')::date
 FROM crm_tasks t JOIN users u ON u.id=t.assigned_to
 WHERE t.assigned_to=$1 AND t.status IN ('pending','in_progress') AND u.is_active=true
 AND (t.due_at AT TIME ZONE 'Asia/Kolkata')::date <= (now() AT TIME ZONE 'Asia/Kolkata')::date
 ON CONFLICT(user_id,task_id,kind,day) DO NOTHING RETURNING id`,[userId]);
 return {taskReminders:rows.length};
}

async function runTaskReminders(query=require('../db').query){
 const {rows}=await query(`INSERT INTO task_notifications(user_id,task_id,kind,day)
 SELECT t.assigned_to,t.id,'reminder',(now() AT TIME ZONE 'Asia/Kolkata')::date
 FROM crm_tasks t JOIN users u ON u.id=t.assigned_to
 WHERE t.status IN ('pending','in_progress') AND u.is_active=true
 AND (t.due_at AT TIME ZONE 'Asia/Kolkata')::date <= (now() AT TIME ZONE 'Asia/Kolkata')::date
 ON CONFLICT(user_id,task_id,kind,day) DO NOTHING RETURNING id`);
 return {taskReminders:rows.length};
}
module.exports={runTaskReminders,ensureTaskRemindersForUser};
