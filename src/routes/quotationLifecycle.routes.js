const router=require('express').Router(),db=require('../db');
const {requireAuth}=require('../middleware/auth');
const {UUID,bad,str}=require('../utils/quotations');
const C=require('../utils/collections');

router.use(requireAuth);
router.use(async(req,res,next)=>{res.set('Cache-Control','no-store');const {rows}=await db.query('SELECT id FROM users WHERE id=$1 AND role=$2 AND is_active=true',[req.user.id,req.user.role]);if(!rows.length)throw bad('Active account required',403);next();});

async function quoteLifecycle(id){
 if(!UUID.test(id))throw bad('Invalid quotation');
 const {rows}=await db.query('SELECT cancelled_at,cancel_reason FROM quotations WHERE id=$1',[id]);
 return rows[0]||null;
}

router.delete('/:id',async(req,res,next)=>{
 if(!UUID.test(req.params.id))throw bad('Invalid quotation');
 const preview=(await db.query(`SELECT q.id,q.number,q.lead_id,q.current_revision,q.cancelled_at,r.status,r.version
 FROM quotations q JOIN quotation_revisions r ON r.quote_id=q.id AND r.revision=q.current_revision
 WHERE q.id=$1`,[req.params.id])).rows[0];
 if(!preview)return next();
 if(preview.cancelled_at)throw bad('Voided quotations are permanent audit records and cannot be deleted.',409);
 if(preview.status!=='accepted')return next();
 if(req.user.role!=='admin')throw bad('Only Admin can delete an accepted quotation.',403);
 const reason=str(req.body?.reason||'',500,true);if(reason.length<5)throw bad('Enter a deletion reason of at least 5 characters');
 if(req.body?.revision!==undefined&&req.body.revision!==preview.current_revision)throw bad('Quotation changed. Reload before deleting.',409);
 if(req.body?.version!==undefined&&req.body.version!==preview.version)throw bad('Quotation changed. Reload before deleting.',409);
 const result=await C.transaction(async query=>{
  const q=(await query('SELECT * FROM quotations WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!q)throw bad('Quotation not found',404);
  const r=(await query('SELECT revision,status,version,snapshot,sent_at FROM quotation_revisions WHERE quote_id=$1 AND revision=$2 FOR UPDATE',[q.id,q.current_revision])).rows[0];if(!r)throw bad('Quotation revision not found',404);
  if(q.cancelled_at)throw bad('Voided quotations are permanent audit records and cannot be deleted.',409);
  if(r.status!=='accepted')throw bad('Quotation status changed. Reload before deleting.',409);
  if(req.body?.revision!==undefined&&req.body.revision!==r.revision)throw bad('Quotation changed. Reload before deleting.',409);
  if(req.body?.version!==undefined&&req.body.version!==r.version)throw bad('Quotation changed. Reload before deleting.',409);
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
  if(directPayment||auditedPayment||account?.voided_at)throw bad('Financial activity exists for this accepted quotation. Void the quotation instead; it must remain in audit history.',409);
  const customerName=r.snapshot?.customer?.name||null;
  await query(`INSERT INTO quotation_deletion_audit
    (quote_id,quote_number,revision,customer_name,status,reason,deleted_by,financial_activity_found,snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,false,$8::jsonb)`,[q.id,q.number,r.revision,customerName,r.status,reason,req.user.id,JSON.stringify(r.snapshot||{})]);
  if(accountId)await query('DELETE FROM collection_accounts WHERE id=$1',[accountId]);
  await query('DELETE FROM quotations WHERE id=$1',[q.id]);
  return {ok:true,deletedAccepted:true};
 });
 return res.json(result);
});

router.post('/:id/revise',async(req,res,next)=>{const q=await quoteLifecycle(req.params.id);if(q?.cancelled_at)throw bad('This quotation has been voided and is locked for audit history.',409);next();});
router.post('/:id/action',async(req,res,next)=>{const q=await quoteLifecycle(req.params.id);if(q?.cancelled_at)throw bad('This quotation has been voided. No further quotation status changes are allowed.',409);next();});
router.get('/:id/summary',async(req,res,next)=>{const q=await quoteLifecycle(req.params.id);if(q?.cancelled_at)throw bad('This quotation has been voided. Customer sharing is closed.',409);next();});

async function voidQuotation(req,res){
 if(req.user.role!=='admin')throw bad('Admin access required',403);
 if(!UUID.test(req.params.id))throw bad('Invalid quotation');
 const reason=str(req.body?.reason||'',500,true);if(reason.length<5)throw bad('Enter a void reason of at least 5 characters');
 const result=await C.transaction(async query=>{
  const q=(await query('SELECT * FROM quotations WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!q)throw bad('Quotation not found',404);
  const r=(await query('SELECT revision,status,version FROM quotation_revisions WHERE quote_id=$1 AND revision=$2 FOR UPDATE',[q.id,q.current_revision])).rows[0];if(!r)throw bad('Quotation revision not found',404);
  if(r.status!=='accepted')throw bad('Only an accepted quotation can be voided.',409);
  if(req.body?.revision!==undefined&&req.body.revision!==r.revision)throw bad('Quotation changed. Refresh before voiding.',409);
  if(req.body?.version!==undefined&&req.body.version!==r.version)throw bad('Quotation changed. Refresh before voiding.',409);
  if(q.cancelled_at)return {ok:true,alreadyVoided:true};
  await query('UPDATE quotations SET cancelled_at=now(),cancel_reason=$2,cancelled_by=$3,updated_at=now() WHERE id=$1',[q.id,reason,req.user.id]);
  await query('UPDATE quotation_public_links SET revoked_at=COALESCE(revoked_at,now()) WHERE quote_id=$1',[q.id]);
  const account=(await query('SELECT id,version,voided_at FROM collection_accounts WHERE quote_id=$1 FOR UPDATE',[q.id])).rows[0];
  let accountVoided=false;
  if(account&&!account.voided_at){await query('UPDATE collection_accounts SET voided_at=now(),void_reason=$2,voided_by=$3,version=version+1 WHERE id=$1',[account.id,reason,req.user.id]);accountVoided=true;await query("INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'payment_account.voided','payment_account',$2,$3::jsonb)",[req.user.id,account.id,JSON.stringify({reason,quoteId:q.id})]);}
  await query("INSERT INTO quotation_events(quote_id,revision,actor_id,action,note) VALUES($1,$2,$3,'quotation_voided',$4)",[q.id,r.revision,req.user.id,reason]);
  await query("INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'quotation.voided','quotation',$2,$3::jsonb)",[req.user.id,q.id,JSON.stringify({reason,revision:r.revision,accountVoided})]);
  return {ok:true,accountVoided};
 });
 res.json(result);
}

router.post('/:id/void',voidQuotation);
router.post('/:id/cancel-deal',voidQuotation);

router.use((e,req,res,next)=>{if(e.status)return res.status(e.status).json({error:e.message});next(e);});
module.exports=router;
