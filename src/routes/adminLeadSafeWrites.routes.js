const express=require('express');
const db=require('../db');
const {requireAuth,requireRole}=require('../middleware/auth');
const {notifyStatusChange}=require('../utils/pushNotifications');

const router=express.Router();
router.use(requireAuth,requireRole('admin'));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad=(message,status=400)=>Object.assign(new Error(message),{status});
const has=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
const isoDay=v=>v?String(v).slice(0,10):null;

async function tx(fn){const c=await db.pool.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}

router.patch('/leads/:id',async(req,res)=>{
 if(!UUID.test(req.params.id)) throw bad('Invalid lead');
 const {subLocation,posName,renewalMonth,renewalDate,contactName,phone,notes,dealValue,nextFollowUpDate}=req.body||{};
 const lead=await tx(async c=>{
  const found=await c.query('SELECT * FROM leads WHERE id=$1 FOR UPDATE',[req.params.id]);
  const before=found.rows[0];if(!before) throw bad('Lead not found',404);
  const updated=await c.query(`UPDATE leads SET sub_location=COALESCE($2,sub_location),pos_name=COALESCE($3,pos_name),renewal_month=COALESCE($4,renewal_month),renewal_date=COALESCE($5,renewal_date),contact_name=COALESCE($6,contact_name),phone=COALESCE($7,phone),notes=COALESCE($8,notes),deal_value=COALESCE($9,deal_value),next_follow_up_date=CASE WHEN $11 THEN $10::date ELSE next_follow_up_date END WHERE id=$1 RETURNING *`,
   [req.params.id,subLocation,posName,renewalMonth,renewalDate,contactName,phone,notes,dealValue,nextFollowUpDate,has(req.body,'nextFollowUpDate')]);
  const after=updated.rows[0],businessName=after.business_name;
  if(has(req.body,'nextFollowUpDate')){const oldF=isoDay(before.next_follow_up_date),newF=isoDay(after.next_follow_up_date);if(oldF!==newF){const action=oldF&&!newF?'lead.follow_up_done':!oldF&&newF?'lead.follow_up_scheduled':'lead.follow_up_rescheduled';await c.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'lead',$3,$4::jsonb)`,[req.user.id,action,after.id,JSON.stringify({businessName,from:oldF,to:newF})]);}}
  if(notes!=null&&String(before.notes||'')!==String(after.notes||'')) await c.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'lead.comment_updated','lead',$2,$3::jsonb)`,[req.user.id,after.id,JSON.stringify({businessName,from:before.notes||'',to:after.notes||''})]);
  const map={subLocation:'sub_location',posName:'pos_name',renewalMonth:'renewal_month',renewalDate:'renewal_date',contactName:'contact_name',phone:'phone',dealValue:'deal_value'};const changes={};
  for(const [a,d] of Object.entries(map)) if(req.body[a]!=null&&String(before[d]??'')!==String(after[d]??'')) changes[a]={from:before[d],to:after[d]};
  if(Object.keys(changes).length) await c.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'lead.edited','lead',$2,$3::jsonb)`,[req.user.id,after.id,JSON.stringify({businessName,changes})]);
  return after;
 });
 res.json({lead});
});

router.patch('/leads/:id/status',async(req,res)=>{
 if(!UUID.test(req.params.id)) throw bad('Invalid lead');
 const status=req.body?.status;if(!status) throw bad('Status is required');
 const result=await tx(async c=>{
  const found=await c.query('SELECT * FROM leads WHERE id=$1 FOR UPDATE',[req.params.id]);const before=found.rows[0];if(!before) throw bad('Lead not found',404);
  if(before.status===status) return {lead:before,changed:false};
  const updated=await c.query('UPDATE leads SET status=$2 WHERE id=$1 RETURNING *',[before.id,status]);const after=updated.rows[0];
  await c.query('INSERT INTO lead_status_history(lead_id,changed_by,old_status,new_status) VALUES($1,$2,$3,$4)',[after.id,req.user.id,before.status,status]);
  await c.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'lead.status_changed','lead',$2,$3::jsonb)`,[req.user.id,after.id,JSON.stringify({from:before.status,to:status,businessName:after.business_name})]);
  return {lead:after,changed:true};
 });
 if(result.changed) notifyStatusChange(result.lead).catch(err=>console.error('push notify failed:',err.message));
 res.json({lead:result.lead});
});

module.exports=router;
