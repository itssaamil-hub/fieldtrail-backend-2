const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getPerformanceReport } = require('../utils/performanceV2');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

function istToday(){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}
function validDay(v){ return /^\d{4}-\d{2}-\d{2}$/.test(v||''); }
function addDays(day,n){ const d=new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function monthBounds(anchor){
  const a=validDay(anchor)?anchor:istToday();
  const [y,m]=a.split('-').map(Number);
  const end=new Date(Date.UTC(y,m,0,12)).toISOString().slice(0,10);
  return {from:`${y}-${String(m).padStart(2,'0')}-01`,to:end};
}
function weekBounds(anchor){
  const a=validDay(anchor)?anchor:istToday();
  const d=new Date(`${a}T12:00:00Z`);
  const mondayOffset=(d.getUTCDay()+6)%7;
  return {from:addDays(a,-mondayOffset),to:addDays(a,6-mondayOffset)};
}

router.get('/', async(req,res)=>{
  try{
    const period=req.query.period==='week'?'week':'month';
    const bounds=period==='week'?weekBounds(req.query.anchor):monthBounds(req.query.anchor);
    const v2=await getPerformanceReport(db.query,{...bounds,salesmanId:req.query.salesmanId||null});
    const rows=v2.employees.map(e=>({
      id:e.id,full_name:e.name,
      leads:e.activity.leadsAdded,
      visits:e.activity.visits,
      demos:e.activity.demosReached,
      followups:e.activity.followUpsCompleted,
      quotes:0,
      won:e.results.won,
      sales_value:e.results.salesValue,
      collected:e.results.collected,
      tasks_completed:e.activity.tasksCompleted,
      outstanding:e.results.currentOutstanding,
    }));
    const totals=rows.reduce((a,r)=>{for(const k of ['leads','visits','demos','followups','quotes','won','sales_value','collected','tasks_completed','outstanding'])a[k]+=Number(r[k]||0);return a;},{leads:0,visits:0,demos:0,followups:0,quotes:0,won:0,sales_value:0,collected:0,tasks_completed:0,outstanding:0});
    res.set('Cache-Control','no-store');
    res.json({period,start:bounds.from,end:bounds.to,rows,totals,engineVersion:2,definitions:v2.definitions});
  }catch(err){if(err.status)return res.status(err.status).json({error:err.message});throw err;}
});

module.exports=router;
