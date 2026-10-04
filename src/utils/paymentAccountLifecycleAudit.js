async function logPaymentAccountLifecycle({query,actorId,leadId,fromStatus,toStatus}){
 if(!query||!actorId||!leadId||!fromStatus||!toStatus||fromStatus===toStatus)return null;
 const archiving=fromStatus==='won'&&toStatus!=='won';
 const reactivating=fromStatus!=='won'&&toStatus==='won';
 if(!archiving&&!reactivating)return null;
 const {rows}=await query(`SELECT id,archived_at,voided_at
   FROM collection_accounts
   WHERE lead_id=$1
   ORDER BY created_at DESC
   LIMIT 1`,[leadId]);
 const account=rows[0];
 if(!account||account.voided_at)return null;
 if(archiving&&!account.archived_at)return null;
 if(reactivating&&account.archived_at)return null;
 const action=archiving?'payment_account.archived':'payment_account.reactivated';
 const state=archiving?'archived':'reactivated';
 await query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
   VALUES($1,$2,'payment_account',$3,$4::jsonb)`,[
   actorId,action,account.id,JSON.stringify({leadId,fromStatus,toStatus,state})
 ]);
 return {action,accountId:account.id};
}

module.exports={logPaymentAccountLifecycle};
