const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify, logActivity } = require('../utils/logging');
const { notifyStatusChange } = require('../utils/pushNotifications');

const router = express.Router();
router.use(requireAuth, requireRole('salesman'));

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad=(message,status=400)=>Object.assign(new Error(message),{status});
const has=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
const isoDay=v=>v?String(v).slice(0,10):null;

function coord(value,max,label){
  if(value==null) return null;
  if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>max) throw bad(`Invalid ${label}`);
  return value;
}

async function tx(fn){
  const c=await db.pool.connect();
  try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

// Same URL/response as the existing salesman lead edit route, but all database
// changes and audit rows commit atomically and the lead row is locked first.
router.patch('/leads/:id',async(req,res)=>{
  if(!UUID.test(req.params.id)) throw bad('Invalid lead');
  const {status,notes,subLocation,posName,renewalMonth,renewalDate,contactName,phone,dealValue,nextFollowUpDate}=req.body||{};
  const outcome=await tx(async c=>{
    const found=await c.query('SELECT * FROM leads WHERE id=$1 AND salesman_id=$2 FOR UPDATE',[req.params.id,req.user.id]);
    const before=found.rows[0];
    if(!before) throw bad('Lead not found',404);

    const updated=await c.query(`UPDATE leads SET
      status=COALESCE($3,status),notes=COALESCE($4,notes),sub_location=COALESCE($5,sub_location),
      pos_name=COALESCE($6,pos_name),renewal_month=COALESCE($7,renewal_month),renewal_date=COALESCE($8,renewal_date),
      contact_name=COALESCE($9,contact_name),phone=COALESCE($10,phone),deal_value=COALESCE($11,deal_value),
      next_follow_up_date=CASE WHEN $13 THEN $12::date ELSE next_follow_up_date END
      WHERE id=$1 AND salesman_id=$2 RETURNING *`,
      [req.params.id,req.user.id,status,notes,subLocation,posName,renewalMonth,renewalDate,contactName,phone,dealValue,nextFollowUpDate,has(req.body,'nextFollowUpDate')]);
    const after=updated.rows[0];
    const businessName=after.business_name;
    const statusChanged=!!status&&status!==before.status;

    if(statusChanged){
      await c.query('INSERT INTO lead_status_history(lead_id,changed_by,old_status,new_status) VALUES($1,$2,$3,$4)',[after.id,req.user.id,before.status,status]);
      await c.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
        VALUES($1,'lead.status_changed','lead',$2,$3::jsonb)`,[req.user.id,after.id,JSON.stringify({from:before.status,to:status,businessName})]);
      if(status==='won') await c.query(`INSERT INTO notifications(type,salesman_id,lead_id,payload) VALUES('lead_converted',$1,$2,'{}'::jsonb)`,[req.user.id,after.id]);
    }

    if(has(req.body,'nextFollowUpDate')){
      const oldFollowUp=isoDay(before.next_follow_up_date),newFollowUp=isoDay(after.next_follow_up_date);
      if(oldFollowUp!==newFollowUp){
        const action=oldFollowUp&&!newFollowUp?'lead.follow_up_done':!oldFollowUp&&newFollowUp?'lead.follow_up_scheduled':'lead.follow_up_rescheduled';
        await c.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'lead',$3,$4::jsonb)`,
          [req.user.id,action,after.id,JSON.stringify({businessName,from:oldFollowUp,to:newFollowUp})]);
      }
    }

    if(notes!=null&&String(before.notes||'')!==String(after.notes||'')){
      await c.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'lead.comment_updated','lead',$2,$3::jsonb)`,
        [req.user.id,after.id,JSON.stringify({businessName,from:before.notes||'',to:after.notes||''})]);
    }

    const map={subLocation:'sub_location',posName:'pos_name',renewalMonth:'renewal_month',renewalDate:'renewal_date',contactName:'contact_name',phone:'phone',dealValue:'deal_value'};
    const changes={};
    for(const [apiField,dbField] of Object.entries(map)) if(req.body[apiField]!=null&&String(before[dbField]??'')!==String(after[dbField]??'')) changes[apiField]={from:before[dbField],to:after[dbField]};
    if(Object.keys(changes).length) await c.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'lead.edited','lead',$2,$3::jsonb)`,
      [req.user.id,after.id,JSON.stringify({businessName,changes})]);

    return {lead:after,statusChanged};
  });

  if(outcome.statusChanged) notifyStatusChange(outcome.lead).catch(err=>console.error('push notify failed:',err.message));
  res.json({lead:outcome.lead});
});

// Idempotent visit start: concurrent retries with the same client UUID return
// the same visit rather than producing an error or duplicate visit.
router.post('/visits/start',async(req,res)=>{
  const {clientUuid,businessName,lat,lng,accuracyM,leadId}=req.body||{};
  if(!clientUuid||!UUID.test(String(clientUuid))) throw bad('clientUuid is required');
  if(leadId&& !UUID.test(String(leadId))) throw bad('Invalid lead');
  const latitude=coord(lat,90,'latitude'),longitude=coord(lng,180,'longitude');
  if(latitude==null||longitude==null) throw bad('clientUuid, lat and lng are required');
  if(accuracyM!=null&&(!Number.isFinite(Number(accuracyM))||Number(accuracyM)<0)) throw bad('Invalid accuracy');

  const result=await tx(async c=>{
    if(leadId){
      const lead=await c.query('SELECT id FROM leads WHERE id=$1 AND salesman_id=$2 FOR SHARE',[leadId,req.user.id]);
      if(!lead.rows.length) throw bad('Lead not found',404);
    }
    const inserted=await c.query(`INSERT INTO visits(client_uuid,salesman_id,lead_id,business_name,latitude,longitude,accuracy_m,arrived_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(client_uuid) DO NOTHING RETURNING *`,
      [clientUuid,req.user.id,leadId||null,businessName,latitude,longitude,accuracyM]);
    let visit=inserted.rows[0],deduped=false;
    if(!visit){
      const existing=await c.query('SELECT * FROM visits WHERE client_uuid=$1 AND salesman_id=$2',[clientUuid,req.user.id]);
      visit=existing.rows[0];deduped=true;
      if(!visit) throw bad('Visit already exists for another user',409);
    }
    await c.query("UPDATE salesman_profiles SET status='on_visit',last_seen_at=now() WHERE user_id=$1",[req.user.id]);
    return {visit,deduped};
  });
  res.status(result.deduped?200:201).json(result);
});

// Idempotent visit end. A repeated tap/retry keeps the original end time.
router.post('/visits/:id/end',async(req,res)=>{
  if(!UUID.test(req.params.id)) throw bad('Invalid visit');
  const {notes,photoUrls,leadCreated}=req.body||{};
  const visit=await tx(async c=>{
    const locked=await c.query('SELECT * FROM visits WHERE id=$1 AND salesman_id=$2 FOR UPDATE',[req.params.id,req.user.id]);
    if(!locked.rows.length) throw bad('Visit not found',404);
    let row=locked.rows[0];
    if(!row.left_at){
      const updated=await c.query(`UPDATE visits SET left_at=now(),notes=COALESCE($3,notes),photo_urls=COALESCE($4,photo_urls),lead_created=COALESCE($5,lead_created)
        WHERE id=$1 AND salesman_id=$2 RETURNING *`,[req.params.id,req.user.id,notes,photoUrls,leadCreated]);
      row=updated.rows[0];
    }
    await c.query("UPDATE salesman_profiles SET status='online',last_seen_at=now() WHERE user_id=$1",[req.user.id]);
    return row;
  });
  res.json({visit});
});

module.exports=router;
