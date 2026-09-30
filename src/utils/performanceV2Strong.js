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
      WITH latest_won AS (
        SELECT al.entity_id AS lead_id, MAX(al.created_at) AS won_at
        FROM activity_logs al
        WHERE al.action='lead.status_changed'
          AND al.metadata->>'to'='won'
        GROUP BY al.entity_id
      )
      SELECT l.salesman_id,
        count(*) FILTER (
          WHERE l.status='won'
            AND lw.won_at IS NOT NULL
            AND (lw.won_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
        )::int AS won,
        coalesce(sum(
          CASE WHEN l.status='won'
            AND lw.won_at IS NOT NULL
            AND (lw.won_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
          THEN coalesce(l.deal_value,0) ELSE 0 END
        ),0)::numeric AS sales_value
      FROM leads l
      LEFT JOIN latest_won lw ON lw.lead_id=l.id
      WHERE ($3::uuid IS NULL OR l.salesman_id=$3)
      GROUP BY l.salesman_id
    `,[from,to,salesmanId])
  ]);

  const conversionMap=new Map(conversionRows.map(r=>[r.salesman_id,Number(r.demo_then_won||0)]));
  const currentWonMap=new Map(currentWonRows.map(r=>[r.salesman_id,{won:Number(r.won||0),salesValue:Number(r.sales_value||0)}]));
  let totalDemoWon=0,totalWon=0,totalSalesValue=0;

  for(const e of report.employees){
    const demoWon=conversionMap.get(e.id)||0;
    const currentWon=currentWonMap.get(e.id)||{won:0,salesValue:0};

    // Funnel conversion remains historical (reached Won). Results are current-state:
    // a deal only contributes while it is still Won.
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
  report.definitions.won='Deals whose latest move to Won is in the selected range and whose current status is still Won.';
  report.definitions.salesValue='Current deal value for those currently Won deals. Moving a deal out of Won removes it from Won count and sales value.';
  return report;
}

module.exports={getPerformanceReport,getDataHealth:base.getDataHealth,validateRange:base.validateRange};
