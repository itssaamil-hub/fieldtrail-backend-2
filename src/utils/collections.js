const db=require('../db');
const {bad,UUID,str,date,day}=require('./quotations');
const methods=['unspecified','upi','bank','cash','cheque','card','other'];
const cents=value=>{const n=Number(value);if(!Number.isFinite(n)||n<0||n>10000000000000||Math.abs(n*100-Math.round(n*100))>0.000001)throw bad('Enter a valid amount with at most two decimals.');return Math.round(n*100);};
async function transaction(fn){const c=await db.pool.connect();try{await c.query('BEGIN');const r=await fn(c.query.bind(c));await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
const source=`SELECT a.id::text AS key,a.id,a.lead_id,a.quote_id,a.owner_id,a.customer,a.snapshot,a.quote_number,a.quote_revision,CASE WHEN a.quote_number IS NULL THEN COALESCE(l.deal_value,a.total) ELSE a.total END AS total,a.currency,a.due_date,a.version,a.created_at,COALESCE(l.salesman_id,a.owner_id) AS assigned_to FROM collection_accounts a LEFT JOIN leads l ON l.id=a.lead_id
 UNION ALL SELECT 'lead:'||l.id::text AS key,NULL::uuid AS id,l.id AS lead_id,NULL::uuid AS quote_id,l.salesman_id AS owner_id,
 jsonb_build_object('name',l.business_name,'contact',l.contact_name,'phone',l.phone) AS customer,'{}'::jsonb AS snapshot,NULL::text AS quote_number,NULL::integer AS quote_revision,
 l.deal_value AS total,'INR'::text AS currency,NULL::date AS due_date,0 AS version,l.created_at,l.salesman_id AS assigned_to
 FROM leads l WHERE l.status='won' AND l.deal_value>=0 AND NOT EXISTS(SELECT 1 FROM collection_accounts a WHERE a.lead_id=l.id)`;
function keyId(key){const id=key.startsWith('lead:')?key.slice(5):key;if(!UUID.test(id))throw bad('Invalid payment account');return id;}
async function getAccount(query,user,key,lock=false){
 const id=keyId(key);let leadId=key.startsWith('lead:')?id:null;
 if(!leadId){const a=(await query('SELECT lead_id FROM collection_accounts WHERE id=$1',[id])).rows[0];if(!a)throw bad('Payment account not found',404);leadId=a.lead_id;}
 // All writers (including the legacy admin endpoints) take the same lead lock.
 if(lock&&leadId)await query('SELECT id FROM leads WHERE id=$1 FOR UPDATE',[leadId]);
 if(lock&&!key.startsWith('lead:'))await query('SELECT id FROM collection_accounts WHERE id=$1 FOR UPDATE',[id]);
 const {rows}=await query(`SELECT c.*,u.full_name AS owner_name FROM (${source}) c LEFT JOIN users u ON u.id=c.assigned_to WHERE ${key.startsWith('lead:')?'c.lead_id=$1':'c.id=$1'} AND ($2::uuid IS NULL OR c.assigned_to=$2)`,[id,user.role==='admin'?null:user.id]);
 if(!rows.length)throw bad('Payment account not found or not assigned to you',404);return rows[0];
}
async function materialize(query,a){if(a.id)return a;const cfg=(await query('SELECT config FROM quotation_settings WHERE id=1')).rows[0]?.config||{};const r=await query(`INSERT INTO collection_accounts(lead_id,owner_id,customer,snapshot,total,currency) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,'INR') RETURNING *`,[a.lead_id,a.assigned_to,JSON.stringify(a.customer),JSON.stringify({company:cfg.company||'Swirl',logo:cfg.logo||'',companyContact:cfg.companyContact||'',supportContact:cfg.supportContact||''}),a.total]);return {...r.rows[0],key:r.rows[0].id,assigned_to:a.assigned_to};}
async function paid(query,a,except=null){const r=await query('SELECT COALESCE(sum(amount),0) AS paid FROM lead_payments WHERE (account_id=$1 OR lead_id=$2) AND ($3::uuid IS NULL OR id<>$3)',[a.id,a.lead_id,except]);return cents(r.rows[0].paid);}
async function record(user,key,b){return transaction(async query=>{
 let a=await getAccount(query,user,key,true);a=await materialize(query,a);
 if(b.requestId&&!UUID.test(b.requestId))throw bad('Invalid payment request');
 if(b.requestId){const old=(await query('SELECT * FROM lead_payments WHERE recorded_by=$1 AND request_id=$2',[user.id,b.requestId])).rows[0];if(old){if(old.account_id!==a.id)throw bad('Request already used for another account',409);return old;}}
 const amount=cents(b.amount);if(amount<=0)throw bad('Payment must be greater than zero.');
 if(amount>cents(a.total)-await paid(query,a))throw bad('Amount exceeds the outstanding balance.',409);
 const method=b.method||'unspecified';if(!methods.includes(method))throw bad('Invalid payment method');
 const paymentDate=date(b.paymentDate||day());if(paymentDate>day())throw bad('Payment date cannot be in the future');
 const r=await query(`INSERT INTO lead_payments(lead_id,account_id,amount,note,recorded_by,paid_at,method,reference,request_id) VALUES($1,$2,$3,$4,$5,($6::date::timestamp AT TIME ZONE 'Asia/Kolkata'),$7,$8,$9) RETURNING *`,[a.lead_id,a.id,amount/100,str(b.note||'',1000),user.id,paymentDate,method,str(b.reference||'',100),b.requestId||null]);
 await query("INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'payment.recorded','payment',$2,$3::jsonb)",[user.id,r.rows[0].id,JSON.stringify({accountId:a.id,amount:amount/100,currency:a.currency})]);return r.rows[0];
});}
async function correct(user,key,paymentId,b,remove=false){if(user.role!=='admin')throw bad('Admin access required',403);if(!UUID.test(paymentId))throw bad('Invalid payment');return transaction(async query=>{
 const a=await getAccount(query,user,key,true);const p=(await query('SELECT * FROM lead_payments WHERE id=$1 AND (account_id=$2 OR lead_id=$3) FOR UPDATE',[paymentId,a.id,a.lead_id])).rows[0];if(!p)throw bad('Payment not found',404);
 if(b.version!==undefined&&b.version!==p.version)throw bad('Payment changed. Refresh before editing.',409);
 await query("INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'payment',$3,$4::jsonb)",[user.id,remove?'payment.deleted':'payment.corrected',p.id,JSON.stringify({previousAmount:p.amount,accountId:a.id})]);
 if(remove){await query('DELETE FROM lead_payments WHERE id=$1',[p.id]);return {ok:true};}
 const amount=cents(b.amount);if(amount<=0||amount>cents(a.total)-await paid(query,a,p.id))throw bad('Amount exceeds available balance or is invalid.');
 const r=await query('UPDATE lead_payments SET amount=$2,note=$3,version=version+1 WHERE id=$1 RETURNING *',[p.id,amount/100,str(b.note||'',1000)]);return r.rows[0];
});}
async function convert(user,quoteId,b){if(!UUID.test(quoteId))throw bad('Invalid quotation');return transaction(async query=>{
 const q=(await query('SELECT * FROM quotations WHERE id=$1 AND ($2::uuid IS NULL OR owner_id=$2) FOR UPDATE',[quoteId,user.role==='admin'?null:user.id])).rows[0];if(!q)throw bad('Quotation not found',404);
 const old=(await query('SELECT id FROM collection_accounts WHERE quote_id=$1',[q.id])).rows[0];if(old)return {key:old.id,existing:true};
 const r=(await query('SELECT * FROM quotation_revisions WHERE quote_id=$1 AND revision=$2',[q.id,q.current_revision])).rows[0];
 if(!r||r.status!=='accepted')throw bad('Accept the current quotation revision first.',409);
 if(b.revision!==r.revision||b.version!==r.version)throw bad('Quotation changed. Refresh before converting.',409);
 const s=r.snapshot,total=cents(s.totalMinor/100)/100;
 if(q.lead_id){const l=(await query('SELECT * FROM leads WHERE id=$1 FOR UPDATE',[q.lead_id])).rows[0];if(!l||user.role!=='admin'&&l.salesman_id!==user.id)throw bad('Lead is no longer assigned to you',403);
 if(l.status!=='won')throw bad('Mark the linked lead Won before creating its payment account.',409);
 if(s.currency!=='INR')throw bad('Linked CRM leads use INR. Use an INR quotation for this lead.',409);
 if(cents(l.deal_value)!==cents(total))throw bad('Set the linked lead deal value to the accepted quotation total before linking.',409);
 const existing=(await query('SELECT * FROM collection_accounts WHERE lead_id=$1 FOR UPDATE',[l.id])).rows[0];
 if(existing?.quote_number)throw bad('This lead already has a quotation-linked payment account.',409);
 const prior=(await query('SELECT COALESCE(sum(amount),0) AS paid FROM lead_payments WHERE lead_id=$1',[l.id])).rows[0];if(cents(prior.paid)>cents(total))throw bad('Existing payments exceed this quotation total.',409);
 if(existing){const updated=(await query(`UPDATE collection_accounts SET quote_id=$2,quote_number=$3,quote_revision=$4,snapshot=$5::jsonb,customer=$6::jsonb,total=$7,due_date=$8,version=version+1 WHERE id=$1 RETURNING id`,[existing.id,q.id,`${s.prefix}-${String(q.number).padStart(5,'0')}`,r.revision,JSON.stringify(s),JSON.stringify(s.customer),total,date(b.dueDate,true)])).rows[0];return {key:updated.id};}
 }
 const result=await query(`INSERT INTO collection_accounts(lead_id,quote_id,owner_id,customer,snapshot,quote_number,quote_revision,total,currency,due_date) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10) RETURNING id`,[q.lead_id,q.id,q.owner_id,JSON.stringify(s.customer),JSON.stringify(s),`${s.prefix}-${String(q.number).padStart(5,'0')}`,r.revision,total,s.currency,date(b.dueDate,true)]);return {key:result.rows[0].id};
});}
module.exports={source,cents,transaction,getAccount,materialize,paid,record,correct,convert};
