const express=require('express');
const db=require('../db');
const {requireAuth,requireRole}=require('../middleware/auth');
const {notifyStatusChange}=require('../utils/pushNotifications');
const {getCrmSettings}=require('../utils/crmSettings');
const {normalizePhone}=require('../utils/duplicateProtection');
const {validateWonDate}=require('../utils/wonDate');

const router=express.Router();
router.use(requireAuth,requireRole('admin'));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad=(message,status=400)=>Object.assign(new Error(message),{status});
const has=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
const isoDay=v=>v?String(v).slice(0,10):null;

async function tx(fn){const c=await db.pool.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}

// Same admin-create behaviour, but the lead and its audit event now commit
// together. A phone-scoped advisory lock closes the concurrent duplicate race.
router.post('/leads',async(req,res)=>{
 const {salesmanId,businessName,subLocation,posName,renewalMonth,renewalDate,contactName,phone,category,notes,status,dealValue,nextFollowUpDate}=req.body||{};
 if(!salesmanId||!UUID.test(String(salesmanId))) throw bad('Choose which employee this lead belongs to.');
 if(!businessName||!String(businessName).trim()) throw bad('Business name is required.');
 const settings=await getCrmSettings();
 const duplicateSettings=settings.lead_settings||{};
 if(settings.lead_settings.requireFollowUpDate&&!nextFollowUpDate) throw bad('Next Follow-up Date is required.');
 const phoneKey=normalizePhone(phone);
 const outcome=await tx(async c=>{
  if(phoneKey.length>=7) await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`lead-phone:${phoneKey}`]);
  const owner=await c.query("SELECT id FROM users WHERE id=$1 AND role='salesman' FOR SHARE",[salesmanId]);
  if(!owner.rows.length) throw bad("That employee doesn't exist.");
  if(duplicateSettings.duplicateProtectionEnabled!==false&&duplicateSettings.duplicateCheckPhone!==false&&phoneKey.length>=7){
    const dup=await c.query(`SELECT l.id,l.business_name,l.status,l.salesman_id,u.full_name AS salesman_name
      FROM leads l LEFT JOIN users u ON u.id=l.salesman_id
      WHERE right(regexp_replace(coalesce(l.phone,''),'[^0-9]','','g'),10)=$1
      ORDER BY l.created_at DESC LIMIT 1`,[phoneKey]);
    const d=dup.rows[0];
    if(d&&!(duplicateSettings.allowDuplicateOverride===true&&req.body.allowDuplicate===true))
      throw Object.assign(bad(`Lead already exists: ${d.business_name}${d.salesman_name?` · Assigned to ${d.salesman_name}`:''}`,409),{code:'DUPLICATE_LEAD'});
  }
  const inserted=await c.query(`INSERT INTO leads(client_uuid,salesman_id,business_name,sub_location,pos_name,renewal_month,renewal_date,contact_name,phone,category,notes,status,deal_value,next_follow_up_date,synced_at)
    VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'cold')::lead_status,$12,$13,now()) RETURNING *`,
    [salesmanId,String(businessName).trim(),subLocation||null,posName||null,renewalMonth||null,renewalDate||null,contactName||null,phone||null,category||null,notes||null,status,dealValue||null,nextFollowUpDate||null]);
  const lead=inserted.rows[0];
  await c.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'lead.created_by_admin','lead',$2,$3::jsonb)`,[req.user.id,lead.id,JSON.stringify({salesmanId,businessName:lead.business_name})]);
  return lead;
 });
 if(outcome.status&&outcome.status!=='cold') notifyStatusChange(outcome,{isNew:true}).catch(err=>console.error('push notify failed:',err.message));
 res.status(201).json({lead:outcome});
});

// Won Date is the date of the unique first-Won milestone. It is read separately
// so normal lead-list queries stay fast and no duplicate source of truth is added.
router.get('/leads/:id/won-date',async(req,res)=>{
 if(!UUID.test(req.params.id)) throw bad('Invalid lead');
 const {rows}=await db.query(`SELECT l.status,
   (m.occurred_at AT TIME ZONE 'Asia/Kolkata')::date::text AS won_date
   FROM leads l
   LEFT JOIN lead_stage_milestones m ON m.lead_id=l.id AND m.stage='won'
   WHERE l.id=$1`,[req.params.id]);
 const row=rows[0];
 if(!row) throw bad('Lead not found',404);
 if(row.status!=='won') return res.json({wonDate:null});
 if(!row.won_date) throw bad('Won history is missing for this deal.',409);
 res.json({wonDate:row.won_date});
});

router.patch('/leads/:id',async(req,res)=>{
 if(!UUID.test(req.params.id)) throw bad('Invalid lead');
 const {businessName,subLocation,posName,renewalMonth,renewalDate,contactName,phone,notes,dealValue,nextFollowUpDate,wonDate}=req.body||{};
 const hasBusinessName=has(req.body,'businessName');
 const hasWonDate=has(req.body,'wonDate');
 const cleanBusinessName=hasBusinessName?String(businessName??'').trim():null;
 if(hasBusinessName&&!cleanBusinessName) throw bad('Business name is required.');
 const result=await tx(async c=>{
  const found=await c.query('SELECT * FROM leads WHERE id=$1 FOR UPDATE',[req.params.id]);
  const before=found.rows[0];if(!before) throw bad('Lead not found',404);

  let wonDateValue=null;
  if(hasWonDate){
    const milestoneResult=await c.query(`SELECT m.occurred_at,
      (m.occurred_at AT TIME ZONE 'Asia/Kolkata')::date::text AS old_day,
      (l.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS created_day,
      (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS today
      FROM lead_stage_milestones m
      JOIN leads l ON l.id=m.lead_id
      WHERE m.lead_id=$1 AND m.stage='won'
      FOR UPDATE OF m`,[req.params.id]);
    const milestone=milestoneResult.rows[0];
    if(!milestone) throw bad('Won history is missing for this deal.',409);
    wonDateValue=validateWonDate({wonDate:String(wonDate||''),status:before.status,createdDay:milestone.created_day,today:milestone.today});
    if(milestone.old_day!==wonDateValue){
      await c.query(`UPDATE lead_stage_milestones
        SET occurred_at=($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        WHERE lead_id=$1 AND stage='won'`,[req.params.id,wonDateValue]);
      await c.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
        VALUES($1,'lead.won_date_changed','lead',$2,$3::jsonb)`,
        [req.user.id,req.params.id,JSON.stringify({businessName:before.business_name,from:milestone.old_day,to:wonDateValue})]);
    }
  }

  const updated=await c.query(`UPDATE leads SET
    business_name=CASE WHEN $12 THEN $11 ELSE business_name END,
    sub_location=COALESCE($2,sub_location),pos_name=COALESCE($3,pos_name),renewal_month=COALESCE($4,renewal_month),renewal_date=COALESCE($5,renewal_date),contact_name=COALESCE($6,contact_name),phone=COALESCE($7,phone),notes=COALESCE($8,notes),deal_value=COALESCE($9,deal_value),next_follow_up_date=CASE WHEN $13 THEN $10::date ELSE next_follow_up_date END WHERE id=$1 RETURNING *`,
   [req.params.id,subLocation,posName,renewalMonth,renewalDate,contactName,phone,notes,dealValue,nextFollowUpDate,cleanBusinessName,hasBusinessName,has(req.body,'nextFollowUpDate')]);
  const after=updated.rows[0],currentBusinessName=after.business_name;
  if(has(req.body,'nextFollowUpDate')){const oldF=isoDay(before.next_follow_up_date),newF=isoDay(after.next_follow_up_date);if(oldF!==newF){const action=oldF&&!newF?'lead.follow_up_done':!oldF&&newF?'lead.follow_up_scheduled':'lead.follow_up_rescheduled';await c.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'lead',$3,$4::jsonb)`,[req.user.id,action,after.id,JSON.stringify({businessName:currentBusinessName,from:oldF,to:newF})]);}}
  if(notes!=null&&String(before.notes||'')!==String(after.notes||'')) await c.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'lead.comment_updated','lead',$2,$3::jsonb)`,[req.user.id,after.id,JSON.stringify({businessName:currentBusinessName,from:before.notes||'',to:after.notes||''})]);
  const map={businessName:'business_name',subLocation:'sub_location',posName:'pos_name',renewalMonth:'renewal_month',renewalDate:'renewal_date',contactName:'contact_name',phone:'phone',dealValue:'deal_value'};const changes={};
  for(const [a,d] of Object.entries(map)) if(has(req.body,a)&&req.body[a]!=null&&String(before[d]??'')!==String(after[d]??'')) changes[a]={from:before[d],to:after[d]};
  if(Object.keys(changes).length) await c.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'lead.edited','lead',$2,$3::jsonb)`,[req.user.id,after.id,JSON.stringify({businessName:currentBusinessName,changes})]);
  return {lead:after,wonDate:hasWonDate?wonDateValue:null};
 });
 res.json(result);
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