const express=require('express');
const db=require('../db');
const {requireAuth,requireRole}=require('../middleware/auth');
const {getPerformanceReport}=require('../utils/performanceV2');
const router=express.Router();
router.use(requireAuth,requireRole('salesman'));
function today(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function monthBounds(month){const a=/^\d{4}-\d{2}-\d{2}$/.test(month||'')?month:today();const[y,m]=a.split('-').map(Number);return{from:`${y}-${String(m).padStart(2,'0')}-01`,to:new Date(Date.UTC(y,m,0,12)).toISOString().slice(0,10)};}
router.get('/',async(req,res)=>{try{
 const b=monthBounds(req.query.month);
 const v2=await getPerformanceReport(db.query,{...b,salesmanId:req.user.id});
 const e=v2.employees[0]||{results:{won:0,salesValue:0}};
 const {rows}=await db.query(`SELECT coalesce(won_target,0)::int won_target,coalesce(sales_value_target,0)::numeric sales_value_target FROM sales_targets WHERE salesman_id=$1 AND month=$2::date`,[req.user.id,b.from]);
 const t=rows[0]||{won_target:0,sales_value_target:0};
 res.set('Cache-Control','no-store');
 res.json({start_day:b.from,end_day:b.to,won_target:Number(t.won_target||0),sales_value_target:Number(t.sales_value_target||0),won:Number(e.results.won||0),sales_value:Number(e.results.salesValue||0),engineVersion:2});
}catch(err){if(err.status)return res.status(err.status).json({error:err.message});throw err;}});
module.exports=router;
