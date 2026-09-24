// A durable bell reminder per pending task per IST day; safe when cron repeats.
async function runTaskReminders(query=require('../db').query){
 const {rows}=await query(`INSERT INTO task_notifications(user_id,task_id,kind,day)
 SELECT t.assigned_to,t.id,'reminder',(now() AT TIME ZONE 'Asia/Kolkata')::date
 FROM crm_tasks t JOIN users u ON u.id=t.assigned_to
 WHERE t.status IN ('pending','in_progress') AND u.is_active=true
 AND (t.due_at AT TIME ZONE 'Asia/Kolkata')::date <= (now() AT TIME ZONE 'Asia/Kolkata')::date
 ON CONFLICT(user_id,task_id,kind,day) DO NOTHING RETURNING id`);
 return {taskReminders:rows.length};
}
module.exports={runTaskReminders};
