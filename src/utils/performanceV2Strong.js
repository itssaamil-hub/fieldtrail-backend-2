const base = require('./performanceV2');

function pct(a,b){return b>0?Math.round((a/b)*1000)/10:0;}

async function getPerformanceReport(query,input){
  const report=await base.getPerformanceReport(query,input);
  const {from,to}=report.range;
  const salesmanId=input.salesmanId||null;

  const [{rows:conversionRows},{rows:currentWonRows}]=await Promise.all([
    query(`
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
    `,[from,to,salesmanId]),
    query(`
      SELECT m.salesman_id,
        count(*)::int AS won,
        coalesce(sum(coalesce(l.deal_value,0)),0)::numeric AS sales_value
      FROM lead_stage_milestones m
      JOIN leads l ON l.id=m.lead_id
      WHERE m.stage='won'
        AND l.status='won'
        AND (m.occurred_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
        AND ($3::uuid IS NULL OR m.salesman_id=$3)
      GROUP BY m.salesman_id
    `,[from,to,salesmanId])
  ]);

  const conversionMap=new Map(conversionRows.map(r=>[r.salesman_id,Number(r.demo_then_won||0)]));
  const currentWonMap=new Map(currentWonRows.map(r=>[r.salesman_id,{won:Number(r.won||0),salesValue:Number(r.sales_value||0)}]));
  let totalDemoWon=0,totalWon=0,totalSalesValue=0;

  for(const e of report.employees){
    const demoWon=conversionMap.get(e.id)||0;
    const currentWon=currentWonMap.get(e.id)||{won:0,salesValue:0};

    // Funnel conversion remains historical (reached Won). Results are current-state:
    // a deal only contributes while it is still Won, using its canonical Won milestone date.
    e.conversion.cohortDemoThenWon=demoWon;
    e.conversion.demoToWonPct=pct(demoWon,e.conversion.cohortDemo);
    e.results.won=currentWon.won;
    e.results.salesValue=currentWon.salesValue;
    e.results.averageWonDealValue=currentWon.won?Math.round(currentWon.salesValue/currentWon.won):0;

    totalDemoWon+=demoWon;
    totalWon+=currentWon.won;
    totalSalesValue+=currentWon.salesValue;
  }

  report.totals.conversion.cohortDemoThenWon=totalDemoWon;
  report.totals.conversion.demoToWonPct=pct(totalDemoWon,report.totals.conversion.cohortDemo);
  report.totals.results.won=totalWon;
  report.totals.results.salesValue=totalSalesValue;
  report.totals.results.averageWonDealValue=totalWon?Math.round(totalSalesValue/totalWon):0;

  report.definitions.demoToWon='Among selected-range leads that reached Demo, the share that subsequently reached Won by the range end.';
  report.definitions.won='Deals whose canonical Won Date is in the selected range and whose current status is still Won.';
  report.definitions.salesValue='Current Deal Value for those currently Won deals, attributed by the canonical Won milestone. Moving a deal out of Won removes it from Won count and sales value.';
  return report;
}

module.exports={getPerformanceReport,getDataHealth:base.getDataHealth,validateRange:base.validateRange};
