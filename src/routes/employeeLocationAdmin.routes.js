const express=require('express');
const db=require('../db');
const {requireAuth,requireRole}=require('../middleware/auth');
const {permissions}=require('../utils/dayClosing');

const router=express.Router();
router.use(requireAuth,requireRole('admin'));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad=(message,status=400)=>Object.assign(new Error(message),{status});

function shape(p){
  return {
    gpsLocation:p.gps_location!==false,
    locationMandatoryForNewLead:p.location_mandatory_for_new_lead!==false,
    continuousGpsTracking:p.continuous_gps_tracking!==false,
    version:Number(p.version||0),
  };
}

router.get('/employees/:id/location-policy',async(req,res)=>{
  if(!UUID.test(req.params.id)) throw bad('Invalid employee');
  const user=await db.query("SELECT id FROM users WHERE id=$1 AND role='salesman'",[req.params.id]);
  if(!user.rows.length) throw bad('Employee not found',404);
  res.json(shape(await permissions(db.query,req.params.id)));
});

router.put('/employees/:id/location-policy',async(req,res)=>{
  if(!UUID.test(req.params.id)) throw bad('Invalid employee');
  const b=req.body||{};
  if(typeof b.gpsLocation!=='boolean'||typeof b.locationMandatoryForNewLead!=='boolean'||typeof b.continuousGpsTracking!=='boolean'||!Number.isInteger(b.version)) throw bad('Invalid location policy');
  const c=await db.pool.connect();
  try{
    await c.query('BEGIN');
    const user=await c.query("SELECT id FROM users WHERE id=$1 AND role='salesman' FOR UPDATE",[req.params.id]);
    if(!user.rows.length) throw bad('Employee not found',404);
    const p=await permissions(c.query.bind(c),req.params.id);
    if(Number(p.version||0)!==b.version) throw bad('Settings changed. Reload before saving.',409);
    const result=await c.query(`INSERT INTO employee_day_closing_permissions(user_id,gps_location,location_mandatory_for_new_lead,continuous_gps_tracking)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(user_id) DO UPDATE SET
        gps_location=$2,
        location_mandatory_for_new_lead=$3,
        continuous_gps_tracking=$4,
        version=employee_day_closing_permissions.version+1
      RETURNING *`,[req.params.id,b.gpsLocation,b.locationMandatoryForNewLead,b.continuousGpsTracking]);
    await c.query('COMMIT');
    res.json(shape(result.rows[0]));
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
});

module.exports=router;
