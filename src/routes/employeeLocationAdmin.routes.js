const express=require('express');
const db=require('../db');
const {requireAuth,requireRole}=require('../middleware/auth');
const {getEmployeeLocationSettings,saveEmployeeLocationSettings}=require('../utils/employeeLocation');
const {logActivity}=require('../utils/logging');

const router=express.Router();
router.use(requireAuth,requireRole('admin'));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad=(message,status=400)=>Object.assign(new Error(message),{status});

async function ensureEmployee(id,query=db.query){
  if(!UUID.test(String(id||''))) throw bad('Invalid employee');
  const {rows}=await query("SELECT id FROM users WHERE id=$1 AND role='salesman'",[id]);
  if(!rows.length) throw bad('Employee not found',404);
}

router.get('/employees/:id/location-policy',async(req,res)=>{
  await ensureEmployee(req.params.id);
  res.json(await getEmployeeLocationSettings(req.params.id));
});

router.put('/employees/:id/location-policy',async(req,res)=>{
  const c=await db.pool.connect();
  try{
    await c.query('BEGIN');
    const query=c.query.bind(c);
    await ensureEmployee(req.params.id,query);
    const saved=await saveEmployeeLocationSettings({userId:req.params.id,actorId:req.user.id,settings:req.body||{}},query);
    await c.query('COMMIT');
    await logActivity({actorId:req.user.id,action:'employee.location_settings_updated',entityType:'user',entityId:req.params.id,metadata:saved});
    res.json(saved);
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
});

module.exports=router;
