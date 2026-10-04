const router=require('express').Router(),db=require('../db');
const {requireAuth}=require('../middleware/auth');
const {UUID,bad,str,date}=require('../utils/quotations');
const C=require('../utils/collections');

router.use(requireAuth);
router.use(async(req,res,next)=>{res.set('Cache-Control','no-store');const {rows}=await db.query('SELECT id FROM users WHERE id=$1 AND role=$2 AND is_active=true',[req.user.id,req.user.role]);if(!rows.length)throw bad('Active account required',403);next();});

async function quoteLifecycle(id){
 if(!UUID.test(id))throw bad('Invalid quotation');
 const {rows}=await db.query('SELECT cancelled_at,cancel_reason FROM quotations WHERE id=$1',[id]);
 return rows[0]||null;
}

async function financialState(query,q){
 const account=(await query('SELECT id,voided_at FROM collection_accounts WHERE quote_id=$1',[q.id])).rows[0]||null;
 const accountId=account?.id||null;
 const directPayment=(await query(`SELECT EXISTS(
   SELECT 1 FROM lead_payments p
   WHERE ($1::uuid IS NOT NULL AND p.account_id=$1)
      OR ($2::uuid IS NOT NULL AND p.lead_id=$2)
 ) AS found`,[accountId,q.lead_id])).rows[0].found;
 const auditedPayment=accountId?(await query(`SELECT EXISTS(
   SELECT 1 FROM activity_logs
   WHERE action IN ('payment.recorded','payment.corrected','payment.deleted')
     AND metadata->>'accountId'=$1
 ) AS found`,[accountId])).rows[0].found:false;
 return {account,financialActivity:!!(directPayment||auditedPayment||account?.voided_at)};
}

function deletionPolicy(user,q,current,revisions,financial){
 if(user.role==='admin')return {canDelete:true,requiresReason:current.status==='accepted',reason:null};
 if(q.cancelled_at)return {canDelete:false,requiresReason:false,reason:'This historical quotation is locked and cannot be deleted.'};
 if(current.status==='accepted')return {canDelete:false,requiresReason:true,reason:'Only Admin can delete an accepted quotation.'};
 const protectedHistory=revisions.some(v=>v.sent_at||['sent','accepted','rejected'].includes(v.status));
 return protectedHistory?{canDelete:false,requiresReason:false,reason:'Only Admin can delete a quotation that has been sent.'}:{canDelete:true,requiresReason:false,reason:null};
}

router.get('/',async(req,res)=>{
 const from=date(req.query.from,true),to=date(req.query.to,true);if(from&&to&&from>to)throw bad('Start date must be before end date');
 const offset=Number(req.query.offset||0),search=str(req.query.search||'',100),status=req.query.status||'';
 const allowed=['','pending_approval','ready','sent','accepted','rejected','changes_requested','voided'];
 if(!Number.isSafeInteger(offset)||offset<0||offset>100000||!allowed.includes(status))throw bad('Invalid page or status');
 const {rows}=await db.query(`SELECT q.*,r.status AS revision_status,
 CASE WHEN q.cancelled_at IS NOT NULL THEN 'voided'::text ELSE r.status END AS status,
 CASE WHEN q.cancelled_at IS NOT NULL THEN 'voided'::text ELSE r.status END AS effective_status,
 r.version,r.expires_on::text,r.follow_up::text,r.snapshot->'customer'->>'name' AS customer_name,r.snapshot->>'prefix' AS prefix,r.snapshot->>'currency' AS currency,r.snapshot->>'totalMinor' AS total_minor,u.full_name AS owner_name
 FROM quotations q JOIN quotation_revisions r ON r.quote_id=q.id AND r.revision=q.current_revision LEFT JOIN users u ON u.id=q.owner_id
 WHERE ($1::uuid IS NULL OR q.owner_id=$1)
 AND ($2='' OR ($2='voided' AND q.cancelled_at IS NOT NULL) OR ($2<>'voided' AND q.cancelled_at IS NULL AND r.status=$2))
 AND position(lower($3) in lower(r.snapshot->'customer'->>'name'))>0
 AND ($5::date IS NULL OR q.created_at >= ($5::date::timestamp AT TIME ZONE 'Asia/Kolkata'))
 AND ($6::date IS NULL OR q.created_at < (($6::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata'))
 ORDER BY q.updated_at DESC,q.id LIMIT 31 OFFSET $4`,[req.user.role==='admin'?null:req.user.id,status,search,offset,from,to]);
 res.json({quotes:rows.slice(0,30),hasMore:rows.length>30});
});

router.get('/:id',async(req,res,next)=>{
 if(!UUID.test(req.params.id))return next();
 const q=(await db.query(`SELECT q.*,u.full_name AS cancelled_by_name FROM quotations q LEFT JOIN users u ON u.id=q.cancelled_by WHERE q.id=$1 AND ($2::uuid IS NULL OR q.owner_id=$2)`,[req.params.id,req.user.role==='admin'?null:req.user.id])).rows[0];
 if(!q)return next();
 const current=(await db.query('SELECT *,expires_on::text AS expires_on,follow_up::text AS follow_up FROM quotation_revisions WHERE quote_id=$1 AND revision=$2',[q.id,q.current_revision])).rows[0];if(!current)throw bad('Revision not found',404);
 const {rows:revisions}=await db.query('SELECT revision,status,sent_at,created_at,snapshot->>\'totalMinor\' AS total_minor,snapshot->>\'currency\' AS currency FROM quotation_revisions WHERE quote_id=$1 ORDER BY revision DESC',[q.id]);
 const {rows:events}=await db.query('SELECT e.*,u.full_name AS actor_name FROM quotation_events e LEFT JOIN users u ON u.id=e.actor_id WHERE quote_id=$1 ORDER BY e.id DESC LIMIT 200',[q.id]);
 const financial=await financialState(db.query,q),deletion=deletionPolicy(req.user,q,current,revisions,financial);
 res.json({quote:q,current,revisions,events,lifecycle:{effectiveStatus:q.cancelled_at?'voided':current.status,canVoid:false,canDelete:deletion.canDelete,deleteRequiresReason:deletion.requiresReason,deleteBlockReason:deletion.reason,hasPaymentAccount:!!financial.account,financialActivity:financial.financialActivity,paymentAccountVoided:!!financial.account?.voided_at}});
});

router.delete('/:id',async(req,res,next)=>{
 if(!UUID.test(req.params.id))throw bad('Invalid quotation');
 const preview=(await db.query(`SELECT q.id,q.number,q.lead_id,q.current_revision,q.cancelled_at,r.status,r.version
 FROM quotations q JOIN quotation_revisions r ON r.quote_id=q.id AND r.revision=q.current_revision
 WHERE q.id=$1`,[req.params.id])).rows[0];
 if(!preview)return next();
 if(req.user.role!=='admin'){
  if(preview.cancelled_at)throw bad('This historical quotation is locked and cannot be deleted.',409);
  if(preview.status==='accepted')throw bad('Only Admin can delete an accepted quotation.',403);
  return next();
 }
 const reason=str(req.body?.reason||'',500,true);
 if(preview.status==='accepted'&&reason.length<5)throw bad('Enter a deletion reason of at least 5 characters');
 if(req.body?.revision!==undefined&&req.body.revision!==preview.current_revision)throw bad('Quotation changed. Reload before deleting.',409);
 if(req.body?.version!==undefined&&req.body.version!==preview.version)throw bad('Quotation changed. Reload before deleting.',409);
 const result=await C.transaction(async query=>{
  const q=(await query('SELECT * FROM quotations WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!q)throw bad('Quotation not found',404);
  const r=(await query('SELECT revision,status,version,snapshot,sent_at FROM quotation_revisions WHERE quote_id=$1 AND revision=$2 FOR UPDATE',[q.id,q.current_revision])).rows[0];if(!r)throw bad('Quotation revision not found',404);
  if(req.body?.revision!==undefined&&req.body.revision!==r.revision)throw bad('Quotation changed. Reload before deleting.',409);
  if(req.body?.version!==undefined&&req.body.version!==r.version)throw bad('Quotation changed. Reload before deleting.',409);
  const finalReason=r.status==='accepted'?str(req.body?.reason||'',500,true):str(req.body?.reason||'Admin deleted quotation',500,true);
  if(r.status==='accepted'&&finalReason.length<5)throw bad('Enter a deletion reason of at least 5 characters');
  const account=(await query('SELECT id,voided_at FROM collection_accounts WHERE quote_id=$1 FOR UPDATE',[q.id])).rows[0]||null;
  const accountId=account?.id||null;
  const directPayment=(await query(`SELECT EXISTS(
    SELECT 1 FROM lead_payments p
    WHERE ($1::uuid IS NOT NULL AND p.account_id=$1)
       OR ($2::uuid IS NOT NULL AND p.lead_id=$2)
  ) AS found`,[accountId,q.lead_id])).rows[0].found;
  const auditedPayment=accountId?(await query(`SELECT EXISTS(
    SELECT 1 FROM activity_logs
    WHERE action IN ('payment.recorded','payment.corrected','payment.deleted')
      AND metadata->>'accountId'=$1
  ) AS found`,[accountId])).rows[0].found:false;
  const financialActivity=!!(directPayment||auditedPayment||account?.voided_at);
  const customerName=r.snapshot?.customer?.name||null;
  await query(`INSERT INTO quotation_deletion_audit
    (quote_id,quote_number,revision,customer_name,status,reason,deleted_by,financial_activity_found,snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[q.id,q.number,r.revision,customerName,r.status,finalReason,req.user.id,financialActivity,JSON.stringify(r.snapshot||{})]);
  await query('DELETE FROM quotations WHERE id=$1',[q.id]);
  return {ok:true,preservedPaymentAccount:!!accountId,financialActivityPreserved:financialActivity};
 });
 return res.json(result);
});

router.post('/:id/revise',async(req,res,next)=>{const q=await quoteLifecycle(req.params.id);if(q?.cancelled_at)throw bad('This historical quotation is locked.',409);next();});
router.post('/:id/action',async(req,res,next)=>{const q=await quoteLifecycle(req.params.id);if(q?.cancelled_at)throw bad('This historical quotation is locked. No further quotation status changes are allowed.',409);next();});
router.get('/:id/summary',async(req,res,next)=>{const q=await quoteLifecycle(req.params.id);if(q?.cancelled_at)throw bad('This historical quotation is locked. Customer sharing is closed.',409);next();});

router.use((e,req,res,next)=>{if(e.status)return res.status(e.status).json({error:e.message});next(e);});
module.exports=router;