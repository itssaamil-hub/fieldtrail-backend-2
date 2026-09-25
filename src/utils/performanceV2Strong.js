const base = require('./performanceV2');

function pct(a,b){return b>0?Math.round((a/b)*1000)/10:0;}

async function getPerformanceReport(query,input){
  const report=await base.getPerformanceReport(query,input);
  const {from,to}=report.range;
  const salesmanId=input.salesmanId||null;
  const {rows}=await query(`
    WITH creation_owner AS (
      SELECT DISTINCT ON (h.lead_id) h.lead_id,h.salesman_id
      FROM lead_owner_history h ORDER BY h.lead_id,h.assigned_at,h.id
    )
    SELECT co.salesman_id,
      count(*) FILTER (
        WHERE dm.id IS NOT NULL AND wm.id IS NOT NULL AND wm.occurred_at>=dm.occurred_at
      )::int AS demo_then_won
    FROM leads l
    JOIN creation_owner co ON co.lead_id=l.id
    LEFT JOIN lead_stage_milestones dm ON dm.lead_id=l.id AND dm.stage='demo'
      AND (dm.occurred_at AT TIME ZONE 'Asia/Kolkata')::date <= $2::date
    LEFT JOIN lead_stage_milestones wm ON wm.lead_id=l.id AND wm.stage='won'
      AND (wm.occurred_at AT TIME ZONE 'Asia/Kolkata')::date <= $2::date
    WHERE (l.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
      AND ($3::uuid IS NULL OR co.salesman_id=$3)
    GROUP BY co.salesman_id
  `,[from,to,salesmanId]);
  const map=new Map(rows.map(r=>[r.salesman_id,Number(r.demo_then_won||0)]));
  let totalDemoWon=0;
  for(const e of report.employees){
    const demoWon=map.get(e.id)||0;
    e.conversion.cohortDemoThenWon=demoWon;
    e.conversion.demoToWonPct=pct(demoWon,e.conversion.cohortDemo);
    totalDemoWon+=demoWon;
  }
  report.totals.conversion.cohortDemoThenWon=totalDemoWon;
  report.totals.conversion.demoToWonPct=pct(totalDemoWon,report.totals.conversion.cohortDemo);
  report.definitions.demoToWon='Among selected-range leads that reached Demo, the share that subsequently reached Won by the range end.';
  return report;
}

module.exports={getPerformanceReport,getDataHealth:base.getDataHealth,validateRange:base.validateRange};
