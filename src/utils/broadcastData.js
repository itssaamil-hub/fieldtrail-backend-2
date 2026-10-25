const crypto = require('crypto');
const {bad,UUID,date} = require('./quotations');
const C = require('./collections');
const fields = {
 leads:{business:'Business name',employee:'Employee',status:'Status',created:'Created date',followup:'Next follow-up',value:'Deal value'},
 won:{business:'Business name',employee:'Employee',won:'Won date',value:'Deal value'},
 payments:{business:'Business name',employee:'Employee',total:'Total',paid:'Paid',remaining:'Remaining',due:'Due date',status:'Payment status'}
};
function validate(b={}) {
 const combined=b.type==='combined';
 if(!combined&&!Object.hasOwn(fields,b.type))throw bad('Choose a report type');
 const title=typeof b.title==='string'?b.title.trim():'';
 if(!title||title.length>100)throw bad('Enter a report name (up to 100 characters)');
 const validColumns=(columns,type)=>Array.isArray(columns)&&columns.length>0&&columns.length<=8&&columns.every(k=>typeof k==='string'&&Object.hasOwn(fields[type],k));
 if(combined){
  if(!validColumns(b.dealColumns,'leads')||!validColumns(b.paymentColumns,'payments'))throw bad('Choose valid report columns');
 }else if(!validColumns(b.columns,b.type))throw bad('Choose valid report columns');
 if(!['all','month','custom'].includes(b.period))throw bad('Choose a report period');
 const from=b.period==='custom'?date(b.from):null,to=b.period==='custom'?date(b.to):null;
 if(b.period==='custom'&&(!from||!to||from>to))throw bad('Choose a valid date range');
 const employee=b.employee||null;if(employee&&!UUID.test(employee))throw bad('Invalid employee');
 const statuses=b.type==='combined'||b.type==='won'?['all']:b.type==='payments'?['all','pending','partial','overdue','paid']:['all','cold','conversation','hot','demo','negotiation','won','lost','nurture'];
 if(!statuses.includes(b.status))throw bad('Invalid status');
 if(!['INR','AED','SAR'].includes(b.currency))throw bad('Invalid currency');
 if(![1,7,30,0].includes(b.expiryDays))throw bad('Invalid expiry');
 return {title,type:b.type,...(combined?{dealColumns:[...new Set(b.dealColumns)],paymentColumns:[...new Set(b.paymentColumns)]}:{columns:[...new Set(b.columns)]}),period:b.period,from,to,employee,status:b.status,currency:b.type==='payments'||combined?b.currency:'INR',expiryDays:b.expiryDays};
}
function tokenFor(id){
 if(!process.env.JWT_SECRET)throw new Error('JWT_SECRET is not configured');
 return id+'.'+crypto.createHmac('sha256',process.env.JWT_SECRET).update('engage:broadcast:v1:'+id).digest('hex');
}
function tokenId(token){
 if(typeof token!=='string'||!/^[-0-9a-f]{36}\.[0-9a-f]{64}$/.test(token))return null;
 const id=token.slice(0,36);if(!UUID.test(id))return null;
 const expected=tokenFor(id);return crypto.timingSafeEqual(Buffer.from(token),Buffer.from(expected))?id:null;
}
function bounds(c,now=new Date()){
 if(c.period==='custom')return [c.from,c.to];
 if(c.period==='all')return [null,null];
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit'}).formatToParts(now);
 const year=Number(parts.find(p=>p.type==='year').value),month=Number(parts.find(p=>p.type==='month').value);
 const prefix=year+'-'+String(month).padStart(2,'0');return [prefix+'-01',prefix+'-'+new Date(Date.UTC(year,month,0)).getUTCDate()];
}
async function report(query,c,offset=0,search='',includeCombinedSummary=false){
 if(!Number.isSafeInteger(offset)||offset<0||offset>10000000)throw bad('Invalid page');
 const [from,to]=bounds(c);let sql;
 if(c.type==='payments'){
 sql=`WITH accounts AS (${C.source}), data AS (
 SELECT c.key,c.customer->>'name' AS business,u.full_name AS employee,c.total,
 COALESCE(p.paid,0) AS paid,GREATEST(c.total-COALESCE(p.paid,0),0) AS remaining,c.due_date::text AS due,
 CASE WHEN c.total-COALESCE(p.paid,0)<=0 THEN 'paid' WHEN c.due_date<(now() AT TIME ZONE 'Asia/Kolkata')::date THEN 'overdue' WHEN COALESCE(p.paid,0)>0 THEN 'partial' ELSE 'pending' END AS status
 FROM accounts c LEFT JOIN collection_accounts a ON a.id=c.id LEFT JOIN users u ON u.id=c.assigned_to
 LEFT JOIN LATERAL (SELECT sum(amount) AS paid FROM lead_payments WHERE account_id=c.id OR lead_id=c.lead_id) p ON true
 WHERE a.voided_at IS NULL AND a.archived_at IS NULL AND c.currency=$4
 AND ($1::uuid IS NULL OR c.assigned_to=$1)
 AND ($2::date IS NULL OR (c.created_at AT TIME ZONE 'Asia/Kolkata')::date >=$2)
 AND ($3::date IS NULL OR (c.created_at AT TIME ZONE 'Asia/Kolkata')::date <=$3))
 SELECT * FROM data WHERE ($5='all' OR ($5='pending' AND remaining>0 AND paid=0) OR ($5='partial' AND remaining>0 AND paid>0) OR ($5='overdue' AND status='overdue') OR ($5='paid' AND remaining=0))
 AND ($7::text='' OR POSITION(LOWER($7::text) IN LOWER(COALESCE(business,'')||' '||COALESCE(employee,'')))>0)
 ORDER BY key LIMIT 51 OFFSET $6`;
 }else{
 const when=c.type==='won'?'m.occurred_at':'l.created_at';
 sql=`SELECT l.id AS key,l.business_name AS business,u.full_name AS employee,l.status,
 (l.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS created,l.next_follow_up_date::text AS followup,l.deal_value AS value,
 (m.occurred_at AT TIME ZONE 'Asia/Kolkata')::date::text AS won
 FROM leads l LEFT JOIN users u ON u.id=l.salesman_id
 LEFT JOIN lead_stage_milestones m ON m.lead_id=l.id AND m.stage='won'
 WHERE ($1::uuid IS NULL OR l.salesman_id=$1) AND ($2::date IS NULL OR (${when} AT TIME ZONE 'Asia/Kolkata')::date >=$2)
 AND ($3::date IS NULL OR (${when} AT TIME ZONE 'Asia/Kolkata')::date <=$3)
 AND $4::text='INR' AND ($5='all' OR l.status::text=$5) ${c.type==='won'?"AND l.status='won'":''}
 AND ($7::text='' OR POSITION(LOWER($7::text) IN LOWER(COALESCE(l.business_name,'')||' '||COALESCE(u.full_name,'')))>0)
 ORDER BY l.id LIMIT 51 OFFSET $6`;
 }
 const params=[c.employee,from,to,c.currency,c.status,offset,search];
 const {rows}=await query(sql,params);
 // The summary is calculated from the identical SELECT and filters as the
 // paginated payment report, not from a separate payment calculation engine.
 // Only amounts explicitly selected by the admin can be summarized.
 let summary=null;
 if(includeCombinedSummary&&c.type==='payments'){
  const select='SELECT * FROM data WHERE',tail=' ORDER BY key LIMIT 51 OFFSET $6';
  if(!sql.includes(select)||!sql.endsWith(tail))throw new Error('Broadcast payment query layout changed');
  const rollup='SELECT COUNT(*)::int AS accounts, COALESCE(SUM(total),0)::text AS total, COALESCE(SUM(paid),0)::text AS paid, COALESCE(SUM(remaining),0)::text AS remaining FROM data WHERE';
  // The paginated query uses $6 for offset and $7 for search. The rollup
  // does not paginate, so bind the search parameter consecutively as $6.
  const aggregateSql=sql.replace(select,rollup).slice(0,-tail.length).replaceAll('$7','$6');
  const totals=(await query(aggregateSql,[c.employee,from,to,c.currency,c.status,search])).rows[0];
  summary={accounts:totals.accounts};
  for(const key of ['total','paid','remaining'])if(c.columns.includes(key))summary[key]=totals[key];
 }
 if(includeCombinedSummary&&c.type==='leads'){
  // Summarize exactly the recipient's authorized Deals scope: employee,
  // period, stage and search. Count once per lead across all pages.
  // The existing deal amounts are read only; no financial writes occur.
  const tail=' ORDER BY l.id LIMIT 51 OFFSET $6';
  if(!sql.endsWith(tail))throw new Error('Broadcast deals query layout changed');
  const scoped=sql.slice(0,-tail.length).replaceAll('$7','$6');
  const aggregateSql='WITH scoped AS ('+scoped+') SELECT COUNT(*)::int AS deals, COALESCE(SUM(value),0)::text AS value FROM (SELECT DISTINCT key,value FROM scoped) unique_deals';
  const totals=(await query(aggregateSql,[c.employee,from,to,c.currency,c.status,search])).rows[0];
  summary={deals:totals.deals};
  if(c.columns.includes('value'))summary.value=totals.value;
 }
 return {title:c.title,type:c.type,currency:c.currency,columns:c.columns.map(key=>({key,label:fields[c.type][key]})),rows:rows.slice(0,50).map(row=>Object.fromEntries(c.columns.map(key=>[key,row[key]??null]))),hasMore:rows.length>50,offset,from,to,dateBasis:c.type==='payments'?'Account creation date; balances include all payments':c.type==='won'?'First won date; currently Won deals only':'Lead creation date',updatedAt:new Date().toISOString(),...(summary?{summary}:{})};
}
async function reportView(query,c,options={}){
 const offset=Number(options.offset||0);
 if(c.type!=='combined')return report(query,c,offset);
 const tab=options.tab===undefined?'deals':options.tab;
 if(tab!=='deals'&&tab!=='payments')throw bad('Invalid report tab');
 const status=options.status===undefined?'all':options.status;
 const stages=tab==='deals'?['all','cold','conversation','hot','demo','negotiation','won','lost','nurture']:['all','pending','partial','overdue','paid'];
 if(typeof status!=='string'||!stages.includes(status))throw bad('Invalid report status');
 const search=options.search===undefined?'':options.search;
 if(typeof search!=='string'||search.trim().length>100)throw bad('Search is too long');
 const type=tab==='deals'?'leads':'payments';
 const columns=tab==='deals'?c.dealColumns:c.paymentColumns;
 const data=await report(query,{...c,type,columns,status,currency:tab==='deals'?'INR':c.currency},offset,search.trim(),true);
 return {...data,sharedType:'combined'};
}
module.exports={fields,validate,tokenFor,tokenId,bounds,report,reportView};
