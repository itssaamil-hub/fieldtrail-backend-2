const express=require('express');
const db=require('../db');
const {requireAuth,requireRole}=require('../middleware/auth');

const router=express.Router();
router.use(requireAuth,requireRole('admin'));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad=(message,status=400)=>Object.assign(new Error(message),{status});

router.delete('/leads/:id',async(req,res)=>{
 const leadId=String(req.params.id||'');
 if(!UUID.test(leadId))throw bad('Invalid lead');
 const client=await db.pool.connect();
 try{
  await client.query('BEGIN');
  const existing=(await client.query('SELECT id,business_name,status FROM leads WHERE id=$1 FOR UPDATE',[leadId])).rows[0];
  if(!existing)throw bad('Lead not found',404);

  const accounts=(await client.query('SELECT id FROM collection_accounts WHERE lead_id=$1 FOR UPDATE',[leadId])).rows.map(r=>r.id);
  const accountIds=accounts.length?accounts:null;

  // Narrow, transaction-local escape hatch for permanent Deal purge only.
  await client.query("SELECT set_config('app.deal_purge','on',true)");

  const ledgerDeleted=await client.query(`DELETE FROM payment_request_ledger
    WHERE lead_id=$1
       OR ($2::uuid[] IS NOT NULL AND account_id=ANY($2::uuid[]))
       OR payment_id IN (
         SELECT id FROM lead_payments
         WHERE lead_id=$1 OR ($2::uuid[] IS NOT NULL AND account_id=ANY($2::uuid[]))
       )`,[leadId,accountIds]);

  const paymentsDeleted=await client.query(`DELETE FROM lead_payments
    WHERE lead_id=$1 OR ($2::uuid[] IS NOT NULL AND account_id=ANY($2::uuid[]))`,[leadId,accountIds]);

  const accountsDeleted=await client.query('DELETE FROM collection_accounts WHERE lead_id=$1',[leadId]);
  const leadDeleted=await client.query('DELETE FROM leads WHERE id=$1',[leadId]);
  if(leadDeleted.rowCount!==1)throw bad('Lead could not be deleted',409);

  await client.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
    VALUES($1,'lead.permanently_deleted','lead',$2,$3::jsonb)`,[
      req.user.id,
      leadId,
      JSON.stringify({
        businessName:existing.business_name,
        previousStatus:existing.status,
        paymentRequestsDeleted:ledgerDeleted.rowCount,
        paymentsDeleted:paymentsDeleted.rowCount,
        paymentAccountsDeleted:accountsDeleted.rowCount
      })
    ]);

  await client.query('COMMIT');
  res.json({ok:true});
 }catch(err){
  await client.query('ROLLBACK');
  throw err;
 }finally{
  client.release();
 }
});

module.exports=router;
