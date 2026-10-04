const router=require('express').Router(),db=require('../db');
const {requireAuth}=require('../middleware/auth');
const {UUID,bad,str,date}=require('../utils/quotations');
const C=require('../utils/collections');

router.use(requireAuth);
router.use(async(req,res,next)=>{res.set('Cache-Control','no-store');const {rows}=await db.query('SELECT id FROM users WHERE id=$1 AND role=$2 AND is_active=true',[req.user.id,req.user.role]);if(!rows.length)throw bad('Active account required',403);next();});

async function lifecycleRow(query,key,lock=false){
 const id=String(key||'').startsWith('lead:')?String(key).slice(5):String(key||'');
 if(!UUID.test(id))throw bad('Invalid payment account');
 if(String(key).startsWith('lead:'))return null;
 const {rows}=await query(`SELECT a.id,a.quote_id,a.version,a.voided_at,a.void_reason,a.voided_by,u.full_name AS voided_by_name,a.archived_at,a.archive_reason
 FROM collection_accounts a LEFT JOIN users u ON u.id=a.voided_by
 WHERE a.id=$1${lock?' FOR UPDATE OF a':''}`,[id]);
 if(!rows.length)throw bad('Payment account not found',404);
 return rows[0];
}
async function guardActive(req,res,next){
 const row=await lifecycleRow(db.query,req.params.key,false);
 if(row?.voided_at)throw bad('This payment account is voided. No further payment changes are allowed.',409);
 if(row?.archived_at)throw bad('This payment account is archived because the deal is no longer Won. Move the deal back to Won to reactivate it.',409);
 next();
}
async function guardWonPayment(req,res,next){
 const a=await C.getAccount(db.query,req.user,req.params.key);
 if(!a.lead_id)throw bad('Move the linked Deal to Won before recording payment.',409);
 const {rows}=await db.query('SELECT status FROM leads WHERE id=$1',[a.lead_id]);
 if(!rows.length||rows[0].status!=='won')throw bad('Move the Deal to Won before recording payment.',409);
 next();
}

router.get('/',async(req,res)=>{
 const currency=req.query.currency||'INR',owner=req.user.role==='admin'?(req.query.owner||null):req.user.id,offset=Number(req.query.offset||0),search=str(req.query.search||'',100);
 const status=req.user.role==='admin'?(req.query.status||'all'):'outstanding';
 if(!['all','pending','partial','overdue','paid','outstanding','archived','voided'].includes(status))throw bad('Invalid payment status');
 const from=date(req.query.from,true),to=date(req.query.to,true);
 if((from==null)!==(to==null))throw bad('Choose both dates for a custom range');
 if(!['INR','AED','SAR'].includes(currency)||owner&&!UUID.test(owner)||!Number.isInteger(offset)||offset<0||(from&&to&&from>to))throw bad('Invalid collection filters');
 const {rows}=await db.query(`WITH accounts AS (${C.source}), enriched AS (
 SELECT c.*,a.voided_at,a.void_reason,a.voided_by,vu.full_name AS voided_by_name,a.archived_at,a.archive_reason
 FROM accounts c LEFT JOIN collection_accounts a ON a.id=c.id LEFT JOIN users vu ON vu.id=a.voided_by
 ), totals AS (
 SELECT c.key,c.customer,c.total,c.currency,c.due_date::text,c.assigned_to,u.full_name AS owner_name,c.quote_number,c.voided_at,c.void_reason,c.voided_by_name,c.archived_at,c.archive_reason,
 COALESCE(p.paid,0) AS paid,
 CASE WHEN c.voided_at IS NOT NULL THEN 0 ELSE GREATEST(c.total-COALESCE(p.paid,0),0) END AS pending,
 CASE WHEN c.voided_at IS NOT NULL OR c.archived_at IS NOT NULL THEN 0 ELSE COALESCE(p.collected,0) END AS collected,
 CASE WHEN c.voided_at IS NOT NULL OR c.archived_at IS NOT NULL THEN 0 WHEN c.due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date THEN GREATEST(c.total-COALESCE(p.paid,0),0) ELSE 0 END AS overdue
 FROM enriched c LEFT JOIN users u ON u.id=c.assigned_to LEFT JOIN LATERAL(
 SELECT sum(amount) AS paid,sum(amount) FILTER(WHERE ($4::date IS NULL OR paid_at>=($4::date::timestamp AT TIME ZONE 'Asia/Kolkata')) AND ($5::date IS NULL OR paid_at<(($5::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata'))) AS collected
 FROM lead_payments WHERE account_id=c.id OR lead_id=c.lead_id) p ON true
 WHERE c.currency=$1 AND ($2::uuid IS NULL OR c.assigned_to=$2) AND position(lower($3) in lower(COALESCE(c.customer->>'name','')||' '||COALESCE(c.customer->>'phone','')))>0)
 SELECT COALESCE((SELECT jsonb_agg(r) FROM(SELECT * FROM totals WHERE (($7='all' AND voided_at IS NULL AND archived_at IS NULL) OR ($7='archived' AND voided_at IS NULL AND archived_at IS NOT NULL) OR ($7='voided' AND voided_at IS NOT NULL) OR ($7='pending' AND voided_at IS NULL AND archived_at IS NULL AND pending>0 AND paid=0) OR ($7='partial' AND voided_at IS NULL AND archived_at IS NULL AND paid>0 AND pending>0) OR ($7='outstanding' AND voided_at IS NULL AND archived_at IS NULL AND pending>0) OR ($7='overdue' AND voided_at IS NULL AND archived_at IS NULL AND overdue>0) OR ($7='paid' AND voided_at IS NULL AND archived_at IS NULL AND pending=0)) ORDER BY archived_at DESC NULLS LAST,voided_at DESC NULLS LAST,overdue DESC,pending DESC,key LIMIT 51 OFFSET $6)r),'[]'::jsonb) AS accounts,
 (SELECT jsonb_build_object('collected',COALESCE(sum(collected) FILTER(WHERE voided_at IS NULL AND archived_at IS NULL),0),'pending',COALESCE(sum(pending) FILTER(WHERE voided_at IS NULL AND archived_at IS NULL),0),'overdue',COALESCE(sum(overdue) FILTER(WHERE voided_at IS NULL AND archived_at IS NULL),0)) FROM totals) AS summary,
 COALESCE((SELECT jsonb_agg(r) FROM(SELECT assigned_to,owner_name,sum(collected) AS collected,sum(pending) AS pending,sum(overdue) AS overdue FROM totals WHERE voided_at IS NULL AND archived_at IS NULL GROUP BY assigned_to,owner_name ORDER BY owner_name)r),'[]'::jsonb) AS employees`,[currency,owner,search,from,to,offset,status]);
 const r=rows[0];res.json({accounts:r.accounts.slice(0,50),hasMore:r.accounts.length>50,summary:r.summary,employees:req.user.role==='admin'?r.employees:[],currency});
});

router.get('/:key',async(req,res,next)=>{
 if(req.params.key==='from-quotation')return next();
 const a=await C.getAccount(db.query,req.user,req.params.key);
 const lifecycle=a.id?await lifecycleRow(db.query,a.id,false):null;
 const {rows}=await db.query(`SELECT p.*,p.paid_at AT TIME ZONE 'Asia/Kolkata' AS local_paid_at,to_char(p.paid_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS payment_date,u.full_name AS recorded_by_name FROM lead_payments p LEFT JOIN users u ON u.id=p.recorded_by WHERE p.account_id=$1 OR p.lead_id=$2 ORDER BY p.paid_at DESC,p.receipt_number DESC LIMIT 101`,[a.id,a.lead_id]);
 const paid=await C.paid(db.query,a),voided=!!lifecycle?.voided_at;
 res.json({account:{...a,...(lifecycle||{}),paid:paid/100,pending:voided?0:Math.max(C.cents(a.total)-paid,0)/100},payments:rows.slice(0,100),historyLimited:rows.length>100});
});

router.post('/from-quotation/:id',async(req,res,next)=>{
 if(!UUID.test(req.params.id))throw bad('Invalid quotation');
 const {rows}=await db.query('SELECT cancelled_at,cancel_reason FROM quotations WHERE id=$1',[req.params.id]);
 if(rows[0]?.cancelled_at)throw bad('This quotation has been voided and cannot create or reopen a payment account.',409);
 next();
});

router.post('/:key/void',async(req,res)=>{
 if(req.user.role!=='admin')throw bad('Admin access required',403);
 const reason=str(req.body?.reason||'',500,true);if(reason.length<5)throw bad('Enter a void reason of at least 5 characters');
 const result=await C.transaction(async query=>{
  const a=await lifecycleRow(query,req.params.key,true);if(!a)throw bad('Create the payment account before voiding it.',409);
  if(req.body?.version!==a.version)throw bad('Account changed. Refresh before voiding.',409);
  if(a.voided_at)return {ok:true,alreadyVoided:true};
  const updated=(await query(`UPDATE collection_accounts SET voided_at=now(),void_reason=$2,voided_by=$3,archived_at=NULL,archive_reason=NULL,version=version+1 WHERE id=$1 RETURNING id,version,voided_at,void_reason`,[a.id,reason,req.user.id])).rows[0];
  await query("INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'payment_account.voided','payment_account',$2,$3::jsonb)",[req.user.id,a.id,JSON.stringify({reason,quoteId:a.quote_id||null})]);
  if(a.quote_id){
   await query('UPDATE quotations SET cancelled_at=COALESCE(cancelled_at,now()),cancel_reason=COALESCE(cancel_reason,$2),cancelled_by=COALESCE(cancelled_by,$3),updated_at=now() WHERE id=$1',[a.quote_id,reason,req.user.id]);
   await query('UPDATE quotation_public_links SET revoked_at=COALESCE(revoked_at,now()) WHERE quote_id=$1',[a.quote_id]);
   const q=(await query('SELECT current_revision FROM quotations WHERE id=$1',[a.quote_id])).rows[0];
   if(q)await query("INSERT INTO quotation_events(quote_id,revision,actor_id,action,note) VALUES($1,$2,$3,'quotation_voided',$4)",[a.quote_id,q.current_revision,req.user.id,reason]);
   await query("INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'quotation.voided','quotation',$2,$3::jsonb)",[req.user.id,a.quote_id,JSON.stringify({reason,accountId:a.id})]);
  }
  return {ok:true,...updated};
 });
 res.json(result);
});

router.put('/:key/due-date',guardActive);
router.post('/:key/payments',guardActive,guardWonPayment);
router.patch('/:key/payments/:id',guardActive);
router.delete('/:key/payments/:id',guardActive);

router.use((e,req,res,next)=>{if(e.status)return res.status(e.status).json({error:e.message});next(e);});
module.exports=router;