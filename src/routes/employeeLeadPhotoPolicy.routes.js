const express=require('express');
const db=require('../db');
const {requireAuth,requireRole}=require('../middleware/auth');
const {fail}=require('../utils/leadPhotos');
const router=express.Router();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.use(requireAuth,requireRole('admin'));
router.get('/employees/:id/photo-policy',async(req,res)=>{
 if(!UUID.test(req.params.id))throw fail('Invalid employee');
 const result=await db.query(`SELECT sp.require_lead_photo FROM salesman_profiles sp
   JOIN users u ON u.id=sp.user_id WHERE sp.user_id=$1 AND u.role='salesman'`,[req.params.id]);
 if(!result.rows.length)throw fail('Employee not found',404);
 res.set('Cache-Control','no-store').json({required:result.rows[0].require_lead_photo});
});
router.put('/employees/:id/photo-policy',async(req,res)=>{
 if(!UUID.test(req.params.id))throw fail('Invalid employee');
 if(typeof req.body?.required!=='boolean')throw fail('Select ON or OFF for Photo Required');
 const client=await db.pool.connect();
 try{
   await client.query('BEGIN');
   const previous=(await client.query(`SELECT sp.require_lead_photo FROM salesman_profiles sp
       JOIN users u ON u.id=sp.user_id WHERE sp.user_id=$1 AND u.role='salesman' FOR UPDATE OF sp`,[req.params.id])).rows[0];
   if(!previous)throw fail('Employee not found',404);
   await client.query('UPDATE salesman_profiles SET require_lead_photo=$2 WHERE user_id=$1',[req.params.id,req.body.required]);
   if(previous.require_lead_photo!==req.body.required){
     await client.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
       VALUES($1,'settings.updated','user',$2,$3::jsonb)`,[req.user.id,req.params.id,
       JSON.stringify({setting:'requireLeadPhoto',from:previous.require_lead_photo,to:req.body.required})]);
   }
   await client.query('COMMIT');
   res.set('Cache-Control','no-store').json({required:req.body.required});
 }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});
module.exports=router;
