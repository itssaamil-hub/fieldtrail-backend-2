const express=require('express');
const db=require('../db');
const {requireAuth,requireRole}=require('../middleware/auth');
const {getPerformanceReport}=require('../utils/performanceV2');
const router=express.Router();
router.use(requireAuth,requireRole('admin'));
function today(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function bounds(month){const a=/^\d{4}-\d{2}-\d{2}$/.test(month||'')?month:today();const [y,m]=a.split('-').map(Number);return{from:`${y}-${String(m).padStart(2,'0')}-01`,to:new Date(Date.UTC(y,m,0,12)).toISOString().slice(0,10)};}
router.get('/',async(req,res)=>{try{
 const b=bounds(req.query.month); const v2=await getPerformanceReport(db.query,{...b,salesmanId:req.query.salesmanId||null});
 const rows=v2.employees.map(e=>({
  id:e.id,name:e.name,
  leadsAdded:e.activity.leadsAdded,
  followUpsDue:e.activity.followUpsDue,
  followUpsCompleted:e.activity.followUpsCompleted,
  overdueFollowUps:e.activity.overdueFollowUps,
  demos:e.activity.demosReached,
  negotiations:e.activity.negotiationsReached,
  won:e.results.won,
  lost:e.results.lost,
  salesValue:e.results.salesValue,
  averageDealValue:e.results.averageWonDealValue,
  leadToDemoPct:e.conversion.leadToDemoPct,
  demoToWonPct:e.conversion.demoToWonPct,
  leadToWonPct:e.conversion.leadToWonPct,
  tasksCompleted:e.activity.tasksCompleted,
  tasksOverdue:e.activity.tasksOverdue,
  activeDays:e.activity.activeDays,
  workingDays:e.activity.workingDays,
  dayClosingSubmitted:e.activity.dayClosingSubmitted,
  visits:e.activity.visits,
  averageLeadsPerActiveDay:e.averages.leadsPerActiveDay,
  averageFollowUpsPerActiveDay:e.averages.followUpsPerActiveDay,
  collected:e.results.collected,
  currentOutstanding:e.results.currentOutstanding,
  engineVersion:2
 }));
 res.set('Cache-Control','no-store');res.json({month:b.from,rows,definitions:v2.definitions});
}catch(err){if(err.status)return res.status(err.status).json({error:err.message});throw err;}});
module.exports=router;
