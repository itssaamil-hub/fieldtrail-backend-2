const express=require('express');
const db=require('../db');
const {requireAuth,requireRole}=require('../middleware/auth');
const {getPerformanceReport}=require('../utils/performanceV2');
const router=express.Router();
router.use(requireAuth,requireRole('salesman'));
const DAY_RE=/^\d{4}-\d{2}-\d{2}$/;
function today(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function validDay(value){if(!DAY_RE.test(value||''))return false;const d=new Date(`${value}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;}
function monthBounds(month){const a=validDay(month)?month:today();const[y,m]=a.split('-').map(Number);return{from:`${y}-${String(m).padStart(2,'0')}-01`,to:new Date(Date.UTC(y,m,0,12)).toISOString().slice(0,10)};}
function resolveRange(query){
 if(query.from||query.to){if(!validDay(query.from)||!validDay(query.to))throw Object.assign(new Error('Choose a valid from and to date.'),{status:400});if(query.from>query.to)throw Object.assign(new Error('From date must be before through date.'),{status:400});return{from:query.from,to:query.to};}
 return monthBounds(query.month);
}
function isWeekday(day){const d=new Date(`${day}T12:00:00Z`);const dow=d.getUTCDay();return dow!==0&&dow!==6;}
function weekdayCount(from,to){let n=0;const d=new Date(`${from}T12:00:00Z`),end=new Date(`${to}T12:00:00Z`);while(d<=end){const dow=d.getUTCDay();if(dow!==0&&dow!==6)n++;d.setUTCDate(d.getUTCDate()+1);}return n;}
function monthStart(day){return `${day.slice(0,7)}-01`;}
function monthEnd(day){const[y,m]=day.slice(0,7).split('-').map(Number);return new Date(Date.UTC(y,m,0,12)).toISOString().slice(0,10);}
function nextMonth(day){const[y,m]=day.slice(0,7).split('-').map(Number);return new Date(Date.UTC(y,m,1,12)).toISOString().slice(0,10);}
function rangeMonths(from,to){const out=[];let m=monthStart(from);while(m<=to){out.push(m);m=nextMonth(m);}return out;}
async function proratedTargets(salesmanId,from,to){
 const months=rangeMonths(from,to);
 const {rows}=await db.query(`SELECT month,coalesce(won_target,0)::numeric won_target,coalesce(sales_value_target,0)::numeric sales_value_target FROM sales_targets WHERE salesman_id=$1 AND month=ANY($2::date[])`,[salesmanId,months]);
 const byMonth=new Map(rows.map(r=>[String(r.month).slice(0,10),r]));
 let won=0,sales=0;
 for(const m of months){const row=byMonth.get(m);if(!row)continue;const fullFrom=m,fullTo=monthEnd(m);const partFrom=from>fullFrom?from:fullFrom;const partTo=to<fullTo?to:fullTo;const fullDays=weekdayCount(fullFrom,fullTo);const partDays=weekdayCount(partFrom,partTo);const ratio=fullDays>0?partDays/fullDays:0;won+=Number(row.won_target||0)*ratio;sales+=Number(row.sales_value_target||0)*ratio;}
 return{won_target:Math.round(won*10)/10,sales_value_target:Math.round(sales),basis:'Monthly targets prorated by Mon-Fri working days inside the selected range.'};
}
router.get('/',async(req,res)=>{try{
 const b=resolveRange(req.query);
 const v2=await getPerformanceReport(db.query,{...b,salesmanId:req.user.id});
 const e=v2.employees[0]||{activity:{},results:{},conversion:{}};
 const [t,{rows:todayRows}]=await Promise.all([
  proratedTargets(req.user.id,b.from,b.to),
  db.query(`SELECT start_day_at,end_day_at FROM attendance WHERE salesman_id=$1 AND day=$2::date LIMIT 1`,[req.user.id,today()])
 ]);
 const todayDay=today();
 const todayInRange=todayDay>=b.from&&todayDay<=b.to;
 const todayWorking=todayInRange&&isWeekday(todayDay);
 const todayStarted=todayInRange&&!!todayRows[0]?.start_day_at;
 const todayEnded=todayInRange&&!!todayRows[0]?.end_day_at;
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
  effective_to:v2.range?.effectiveTo||b.to,
  won_target:Number(t.won_target||0),
  sales_value_target:Number(t.sales_value_target||0),
  target_basis:t.basis,
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
