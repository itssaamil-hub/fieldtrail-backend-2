const express=require('express');
const db=require('../db');
const {requireAuth,requireRole}=require('../middleware/auth');
const {getPerformanceReport}=require('../utils/performanceV2');
const router=express.Router();
router.use(requireAuth,requireRole('salesman'));
function today(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function monthBounds(month){const a=/^\d{4}-\d{2}-\d{2}$/.test(month||'')?month:today();const[y,m]=a.split('-').map(Number);return{from:`${y}-${String(m).padStart(2,'0')}-01`,to:new Date(Date.UTC(y,m,0,12)).toISOString().slice(0,10)};}
function isWeekday(day){const d=new Date(`${day}T12:00:00Z`);const dow=d.getUTCDay();return dow!==0&&dow!==6;}
router.get('/',async(req,res)=>{try{
 const b=monthBounds(req.query.month);
 const v2=await getPerformanceReport(db.query,{...b,salesmanId:req.user.id});
 const e=v2.employees[0]||{activity:{},results:{},conversion:{}};
 const [{rows:targetRows},{rows:todayRows}]=await Promise.all([
  db.query(`SELECT coalesce(won_target,0)::int won_target,coalesce(sales_value_target,0)::numeric sales_value_target FROM sales_targets WHERE salesman_id=$1 AND month=$2::date`,[req.user.id,b.from]),
  db.query(`SELECT start_day_at,end_day_at FROM attendance WHERE salesman_id=$1 AND day=$2::date LIMIT 1`,[req.user.id,today()])
 ]);
 const t=targetRows[0]||{won_target:0,sales_value_target:0};
 const todayDay=today();
 const todayInRange=todayDay>=b.from&&todayDay<=b.to;
 const todayWorking=todayInRange&&isWeekday(todayDay);
 const todayStarted=!!todayRows[0]?.start_day_at;
 const todayEnded=!!todayRows[0]?.end_day_at;
 const activeDays=Number(e.activity?.activeDays||0);
 const workingDays=Number(e.activity?.workingDays||0);
 const completedWorkingDays=Math.max(0,workingDays-(todayWorking?1:0));
 const completedActiveDays=Math.max(0,activeDays-(todayStarted?1:0));
 const absentDays=Math.max(0,completedWorkingDays-completedActiveDays);
 const notStartedToday=todayWorking&&!todayStarted;
 const closingDays=Number(e.activity?.dayClosingSubmitted||0);
 const closingPending=Math.max(0,activeDays-closingDays);
 const attendancePct=workingDays>0?Math.round((activeDays/workingDays)*1000)/10:0;
 const closingPct=activeDays>0?Math.round((closingDays/activeDays)*1000)/10:0;
 res.set('Cache-Control','no-store');
 res.json({
  start_day:b.from,
  end_day:b.to,
  won_target:Number(t.won_target||0),
  sales_value_target:Number(t.sales_value_target||0),
  won:Number(e.results?.won||0),
  sales_value:Number(e.results?.salesValue||0),
  leads_added:Number(e.activity?.leadsAdded||0),
  lead_to_won_pct:Number(e.conversion?.leadToWonPct||0),
  followups_completed:Number(e.activity?.followUpsCompleted||0),
  overdue_followups:Number(e.activity?.overdueFollowUps||0),
  attendance:{
   active_days:activeDays,
   working_days:workingDays,
   percent:attendancePct,
   absent_days:absentDays,
   not_started_today:notStartedToday,
   today_started:todayStarted,
   today_ended:todayEnded,
   basis:'Weekdays (Mon-Fri); approved leave/holiday exceptions are not currently configured.'
  },
  day_closing:{submitted:closingDays,pending:closingPending,percent:closingPct},
  engineVersion:2
 });
}catch(err){if(err.status)return res.status(err.status).json({error:err.message});throw err;}});
module.exports=router;
