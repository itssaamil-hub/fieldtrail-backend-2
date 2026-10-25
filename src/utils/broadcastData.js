const crypto = require('crypto');
const {bad,UUID,date} = require('./quotations');
const C = require('./collections');
const fields = {
 leads:{business:'Business name',employee:'Salesman',status:'Status',created:'Created date',followup:'Next follow-up',value:'Deal value'},
 won:{business:'Business name',employee:'Salesman',won:'Won date',value:'Deal value'},
 payments:{business:'Business name',employee:'Salesman',total:'Total',paid:'Paid',remaining:'Remaining',due:'Due date',status:'Payment status'}
};
function validate(b={}) {
 if(!Object.hasOwn(fields,b.type))throw bad('Choose a report type');
 const title=typeof b.title==='string'?b.title.trim():'';
 if(!title||title.length>100)throw bad('Enter a report name (up to 100 characters)');
 if(!Array.isArray(b.columns)||!b.columns.length||b.columns.length>8||b.columns.some(k=>!Object.hasOwn(fields[b.type],k)))throw bad('Choose valid report columns');
 if(!['all','month','custom'].includes(b.period))throw bad('Choose a report period');
 const from=b.period==='custom'?date(b.from):null,to=b.period==='custom'?date(b.to):null;
 if(b.period==='custom'&&(!from||!to||from>to))throw bad('Choose a valid date range');
 const employee=b.employee||null;if(employee&&!UUID.test(employee))throw bad('Invalid employee');
 const statuses=b.type==='payments'?['all','pending','partial','overdue','paid']:b.type==='won'?['all']:['all','cold','conversation','hot','demo','negotiation','won','lost','nurture'];
 if(!statuses.includes(b.status))throw bad('Invalid status');
 if(!['INR','AED','SAR'].includes(b.currency))throw bad('Invalid currency');
 if(![1,7,30,0].includes(b.expiryDays))throw bad('Invalid expiry');
 return {title,type:b.type,columns:[...new Set(b.columns)],period:b.period,from,to,employee,status:b.status,currency:b.type==='payments'?b.currency:'INR',expiryDays:b.expiryDays};
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
async function report(query,c,offset=0){
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
 SELECT * FROM data WHERE $5='all' OR ($5='pending' AND remaining>0 AND paid=0) OR ($5='partial' AND remaining>0 AND paid>0) OR ($5='overdue' AND status='overdue') OR ($5='paid' AND remaining=0) ORDER BY key LIMIT 51 OFFSET $6`;
 }else{
 const when=c.type==='won'?'m.occurred_at':'l.created_at';
 sql=`SELECT l.id AS key,l.business_name AS business,u.full_name AS employee,l.status,
 (l.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS created,l.next_follow_up_date::text AS followup,l.deal_value AS value,
 (m.occurred_at AT TIME ZONE 'Asia/Kolkata')::date::text AS won
 FROM leads l LEFT JOIN users u ON u.id=l.salesman_id
 LEFT JOIN lead_stage_milestones m ON m.lead_id=l.id AND m.stage='won'
 WHERE ($1::uuid IS NULL OR l.salesman_id=$1) AND ($2::date IS NULL OR (${when} AT TIME ZONE 'Asia/Kolkata')::date >=$2)
 AND ($3::date IS NULL OR (${when} AT TIME ZONE 'Asia/Kolkata')::date <=$3)
 AND $4::text='INR' AND ($5='all' OR l.status=$5) ${c.type==='won'?"AND l.status='won'":''}
 ORDER BY l.id LIMIT 51 OFFSET $6`;
 }
 const {rows}=await query(sql,[c.employee,from,to,c.currency,c.status,offset]);
 return {title:c.title,type:c.type,currency:c.currency,columns:c.columns.map(key=>({key,label:fields[c.type][key]})),rows:rows.slice(0,50).map(row=>Object.fromEntries(c.columns.map(key=>[key,row[key]??null]))),hasMore:rows.length>50,offset,from,to,dateBasis:c.type==='payments'?'Account creation date; balances include all payments':c.type==='won'?'First won date; currently Won deals only':'Lead creation date',updatedAt:new Date().toISOString()};
}
module.exports={fields,validate,tokenFor,tokenId,bounds,report};
