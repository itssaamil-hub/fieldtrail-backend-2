const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { assessReading } = require('../utils/verification');
const { logActivity, notify } = require('../utils/logging');
const { notifyStatusChange } = require('../utils/pushNotifications');
const { getCrmSettings, validateLeadAgainstSettings } = require('../utils/crmSettings');
const { permissions } = require('../utils/dayClosing');
const { findLeadDuplicates } = require('../utils/duplicateProtection');

const router = express.Router();
router.use(requireAuth, requireRole('salesman'));

function locationPolicyFromPermissions(p) {
  return {
    gpsLocation: p.gps_location !== false,
    locationMandatoryForNewLead: p.location_mandatory_for_new_lead !== false,
    continuousGpsTracking: p.continuous_gps_tracking !== false,
  };
}

async function getVerificationSettings() {
  const { rows } = await db.query('SELECT * FROM verification_settings ORDER BY updated_at DESC LIMIT 1');
  return rows[0];
}
async function getLastKnown(salesmanId) {
  const { rows } = await db.query('SELECT latitude AS lat, longitude AS lng, captured_at FROM location_pings WHERE salesman_id=$1 ORDER BY captured_at DESC LIMIT 1',[salesmanId]);
  return rows[0] || null;
}

// Employee-specific replacement for the legacy global Location Settings response.
router.get('/settings', async (req,res) => {
  const settings = await getCrmSettings();
  const p = await permissions(db.query, req.user.id);
  res.json({
    leadSettings: settings.lead_settings,
    locationSettings: locationPolicyFromPermissions(p),
    messageSettings: settings.message_settings || { employeeRepliesEnabled: true },
    employeePermissions: { allowLeadWithoutStartDay: !!p.allow_lead_without_start_day },
  });
});

// Server-side guard: stale clients cannot keep sending pings after tracking is
// disabled for this employee. The existing ping handler remains responsible
// for validation/storage/broadcasting once this policy check passes.
router.post('/location/ping', async (req,res,next) => {
  const p = await permissions(db.query, req.user.id);
  if (p.gps_location === false || p.continuous_gps_tracking === false) {
    return res.status(403).json({ error: 'Continuous GPS tracking is disabled for your account.' });
  }
  next();
});

// Employee-policy-aware lead creation. Mounted before the legacy route so GPS
// requirements are enforced per employee without changing the API contract.
router.post('/leads', async (req,res) => {
  const salesmanId=req.user.id;
  const {
    clientUuid,businessName,subLocation,posName,renewalMonth,renewalDate,
    contactName,phone,whatsapp,address,category,branchCount,estimatedRequirement,
    notes,photoUrl,status,dealValue,nextFollowUpDate,lat,lng,accuracyM,
    isMockSuspected,capturedAt,deviceId,reverseGeocodedAddress,
  }=req.body||{};
  if(!clientUuid) return res.status(400).json({error:'clientUuid is required'});

  const existing=await db.query('SELECT * FROM leads WHERE client_uuid=$1',[clientUuid]);
  if(existing.rows[0]) return res.status(200).json({lead:existing.rows[0],deduped:true});

  const crmSettings=await getCrmSettings();
  const duplicateSettings=crmSettings.lead_settings||{};
  if(duplicateSettings.duplicateProtectionEnabled!==false&&duplicateSettings.duplicateCheckPhone!==false&&phone){
    const duplicates=await findLeadDuplicates({phone});
    const exactPhone=duplicates.find(m=>m.matchType==='phone');
    if(exactPhone&&!(duplicateSettings.allowDuplicateOverride===true&&req.body.allowDuplicate===true)){
      return res.status(409).json({error:`Lead already exists: ${exactPhone.business_name}${exactPhone.salesman_name?` · Assigned to ${exactPhone.salesman_name}`:''}`,code:'DUPLICATE_LEAD',duplicate:exactPhone,canOverride:duplicateSettings.allowDuplicateOverride===true});
    }
  }

  const p=await permissions(db.query,salesmanId);
  const trustedLeadCapture=!!p.allow_lead_without_start_day;
  const employeeLocation=locationPolicyFromPermissions(p);
  if(!trustedLeadCapture){
    const active=await db.query('SELECT id FROM attendance WHERE salesman_id=$1 AND start_day_at IS NOT NULL AND end_day_at IS NULL ORDER BY start_day_at DESC LIMIT 1',[salesmanId]);
    if(!active.rows.length) return res.status(409).json({error:'Start your day before adding a lead.'});
  }

  const effectiveLocation=trustedLeadCapture
    ? {...employeeLocation,locationMandatoryForNewLead:false}
    : employeeLocation;
  const check=validateLeadAgainstSettings(
    {businessName,subLocation,posName,contactName,phone,status,notes,dealValue,nextFollowUpDate,lat,lng},
    {...crmSettings,location_settings:effectiveLocation}
  );
  if(!check.ok) return res.status(400).json({error:check.error});

  const hasLocation=!trustedLeadCapture&&effectiveLocation.gpsLocation&&lat!=null&&lng!=null;
  let verification_status=null;
  if(hasLocation){
    const verificationSettings=await getVerificationSettings();
    const lastKnown=await getLastKnown(salesmanId);
    ({verification_status}=assessReading({lat,lng,accuracyM,isMockSuspected,capturedAt,lastKnown,settings:verificationSettings}));
  }

  const {rows}=await db.query(`INSERT INTO leads (
    client_uuid,salesman_id,business_name,sub_location,pos_name,renewal_month,renewal_date,
    contact_name,phone,whatsapp,address,category,branch_count,estimated_requirement,notes,photo_url,
    status,deal_value,latitude,longitude,accuracy_m,reverse_geocoded_address,captured_at,device_id,
    is_mock_suspected,verification_status,next_follow_up_date,synced_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($17,'cold')::lead_status,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,now()) RETURNING *`,[
    clientUuid,salesmanId,businessName,subLocation,posName,renewalMonth,renewalDate||null,
    contactName,phone,whatsapp,address,category,branchCount,estimatedRequirement,notes,photoUrl,status,dealValue||null,
    hasLocation?lat:null,hasLocation?lng:null,hasLocation?accuracyM:null,hasLocation?reverseGeocodedAddress:null,
    hasLocation?capturedAt:null,hasLocation?deviceId:null,hasLocation?!!isMockSuspected:false,
    hasLocation?verification_status:null,nextFollowUpDate||null,
  ]);
  const lead=rows[0];
  await notify({type:'new_lead',salesmanId,leadId:lead.id,payload:{businessName,verification_status}});
  await logActivity({actorId:salesmanId,action:'lead.created',entityType:'lead',entityId:lead.id,metadata:{verification_status,businessName:lead.business_name}});
  if(lead.status&&lead.status!=='cold') notifyStatusChange(lead,{isNew:true}).catch(err=>console.error('push notify failed:',err.message));
  res.status(201).json({lead,deduped:false});
});

module.exports=router;
