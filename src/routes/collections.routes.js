const router=require('express').Router(),db=require('../db');
const {requireAuth}=require('../middleware/auth');
const {UUID,bad,str,date,day,money}=require('../utils/quotations');
const C=require('../utils/collections');
router.use(requireAuth);
router.use(async(req,res,next)=>{res.set('Cache-Control','no-store');const {rows}=await db.query('SELECT id FROM users WHERE id=$1 AND role=$2 AND is_active=true',[req.user.id,req.user.role]);if(!rows.length)throw bad('Active account required',403);next();});
router.get('/',async(req,res)=>{
 const currency=req.query.currency||'INR',owner=req.user.role==='admin'?(req.query.owner||null):req.user.id,offset=Number(req.query.offset||0),search=str(req.query.search||'',100);
 const from=date(req.query.from||day().slice(0,7)+'-01'),to=date(req.query.to||day());
 if(!['INR','AED','SAR'].includes(currency)||owner&&!UUID.test(owner)||!Number.isInteger(offset)||offset<0||from>to)throw bad('Invalid collection filters');
 const {rows}=await db.query(`WITH accounts AS (${C.source}), totals AS (
 SELECT c.key,c.customer,c.total,c.currency,c.due_date::text,c.assigned_to,u.full_name AS owner_name,c.quote_number,
 COALESCE(p.paid,0) AS paid,GREATEST(c.total-COALESCE(p.paid,0),0) AS pending,
 COALESCE(p.collected,0) AS collected,
 CASE WHEN c.due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date THEN GREATEST(c.total-COALESCE(p.paid,0),0) ELSE 0 END AS overdue
 FROM accounts c LEFT JOIN users u ON u.id=c.assigned_to LEFT JOIN LATERAL(
 SELECT sum(amount) AS paid,sum(amount) FILTER(WHERE paid_at>=($4::date::timestamp AT TIME ZONE 'Asia/Kolkata') AND paid_at<(($5::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata')) AS collected
 FROM lead_payments WHERE account_id=c.id OR lead_id=c.lead_id) p ON true
 WHERE c.currency=$1 AND ($2::uuid IS NULL OR c.assigned_to=$2) AND position(lower($3) in lower(COALESCE(c.customer->>'name','')||' '||COALESCE(c.customer->>'phone','')))>0)
 SELECT COALESCE((SELECT jsonb_agg(r) FROM(SELECT * FROM totals ORDER BY overdue DESC,pending DESC,key LIMIT 51 OFFSET $6)r),'[]'::jsonb) AS accounts,
 (SELECT jsonb_build_object('collected',COALESCE(sum(collected),0),'pending',COALESCE(sum(pending),0),'overdue',COALESCE(sum(overdue),0)) FROM totals) AS summary,
 COALESCE((SELECT jsonb_agg(r) FROM(SELECT assigned_to,owner_name,sum(collected) AS collected,sum(pending) AS pending,sum(overdue) AS overdue FROM totals GROUP BY assigned_to,owner_name ORDER BY owner_name)r),'[]'::jsonb) AS employees`,[currency,owner,search,from,to,offset]);
 const r=rows[0];res.json({accounts:r.accounts.slice(0,50),hasMore:r.accounts.length>50,summary:r.summary,employees:req.user.role==='admin'?r.employees:[],currency});
});
router.post('/from-quotation/:id',async(req,res)=>res.json(await C.convert(req.user,req.params.id,req.body)));
router.get('/:key',async(req,res)=>{
 const a=await C.getAccount(db.query,req.user,req.params.key);
 const {rows}=await db.query(`SELECT p.*,p.paid_at AT TIME ZONE 'Asia/Kolkata' AS local_paid_at,to_char(p.paid_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS payment_date,u.full_name AS recorded_by_name FROM lead_payments p LEFT JOIN users u ON u.id=p.recorded_by WHERE p.account_id=$1 OR p.lead_id=$2 ORDER BY p.paid_at DESC,p.receipt_number DESC LIMIT 101`,[a.id,a.lead_id]);
 const paid=await C.paid(db.query,a);res.json({account:{...a,paid:paid/100,pending:Math.max(C.cents(a.total)-paid,0)/100},payments:rows.slice(0,100),historyLimited:rows.length>100});
});
router.put('/:key/due-date',async(req,res)=>{if(req.user.role!=='admin')throw bad('Admin access required',403);return res.json(await C.transaction(async query=>{let a=await C.getAccount(query,req.user,req.params.key,true);if(req.body.version!==a.version)throw bad('Account changed. Refresh before saving.',409);a=await C.materialize(query,a);await query('UPDATE collection_accounts SET due_date=$2,version=version+1 WHERE id=$1',[a.id,date(req.body.dueDate,true)]);return {key:a.id};}));});
router.post('/:key/payments',async(req,res)=>{if(req.user.role!=='admin')throw bad('Admin access required',403);if(!UUID.test(req.body.requestId))throw bad('Payment request identifier required');res.status(201).json({payment:await C.record(req.user,req.params.key,req.body)});});
router.patch('/:key/payments/:id',async(req,res)=>res.json({payment:await C.correct(req.user,req.params.key,req.params.id,req.body)}));
router.delete('/:key/payments/:id',async(req,res)=>res.json(await C.correct(req.user,req.params.key,req.params.id,req.body,true)));
router.get('/:key/payments/:id/receipt',async(req,res)=>{
 if(!UUID.test(req.params.id))throw bad('Invalid payment');const a=await C.getAccount(db.query,req.user,req.params.key);
 const p=(await db.query(`SELECT p.*,to_char(p.paid_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS payment_date,u.full_name AS recorded_by_name FROM lead_payments p LEFT JOIN users u ON u.id=p.recorded_by WHERE p.id=$1 AND (p.account_id=$2 OR p.lead_id=$3)`,[req.params.id,a.id,a.lead_id])).rows[0];if(!p)throw bad('Payment not found',404);
 const cfg=(await db.query('SELECT config FROM quotation_settings WHERE id=1')).rows[0]?.config||{};
 const receipt={number:'SW-R-'+String(p.receipt_number).padStart(5,'0'),version:p.version,company:a.snapshot.company||cfg.company||'Swirl',companyContact:a.snapshot.companyContact||cfg.companyContact||'',customer:a.customer,quoteNumber:a.quote_number,quoteRevision:a.quote_revision,amount:Number(p.amount),currency:a.currency,date:p.payment_date,method:p.method,reference:p.reference,recordedBy:p.recorded_by_name||'Former employee'};
 if(req.query.format==='pdf'){const bytes=await require('../utils/paymentReceiptPDF').renderReceipt(receipt);res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${receipt.number}.pdf"`});return res.send(bytes);}
 receipt.text=`Hello ${receipt.customer.name}, we have recorded your payment of ${money(Math.round(receipt.amount*100),receipt.currency)} on ${receipt.date}. Receipt ${receipt.number}. Thank you — ${receipt.company}.`;
 res.json({receipt});
});
router.use((e,req,res,next)=>{if(e.status)return res.status(e.status).json({error:e.message});next(e);});module.exports=router;
