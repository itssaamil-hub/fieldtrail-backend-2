const express = require('express');
const db = require('../db');
const {requireAuth, requireRole} = require('../middleware/auth');
const {download, queueDeletion, flushDeletions, fail} = require('../utils/leadPhotos');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const salesmanRouter = express.Router();
const adminRouter = express.Router();
salesmanRouter.use(requireAuth, requireRole('salesman'));
adminRouter.use(requireAuth, requireRole('admin'));

async function send(req, res, admin) {
  if (!UUID.test(req.params.id)) throw fail('Invalid lead');
  const args = admin ? [req.params.id] : [req.params.id,req.user.id];
  const row = (await db.query(`SELECT photo_url FROM leads WHERE id=$1 ${admin?'':'AND salesman_id=$2'}`,args)).rows[0];
  if (!row) throw fail('Lead not found',404);
  if (!row.photo_url) throw fail('Lead photo not found',404);
  const buffer = await download(row.photo_url);
  res.set({'Content-Type':'image/webp','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
  res.send(buffer);
}
salesmanRouter.get('/leads/:id/photo', async(req,res)=>send(req,res,false));
adminRouter.get('/leads/:id/photo', async(req,res)=>send(req,res,true));

adminRouter.delete('/leads/:id/photo',async(req,res)=>{
  if (!UUID.test(req.params.id)) throw fail('Invalid lead');
  const client=await db.pool.connect();
  let path=null;
  try {
    await client.query('BEGIN');
    const lead=(await client.query('SELECT photo_url FROM leads WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
    if(!lead) throw fail('Lead not found',404);
    path=lead.photo_url;
    if(path) {
      await queueDeletion((...args)=>client.query(...args),path);
      await client.query('UPDATE leads SET photo_url=NULL,updated_at=now() WHERE id=$1',[req.params.id]);
      await client.query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
        VALUES($1,'lead.photo_deleted','lead',$2,'{}'::jsonb)`,[req.user.id,req.params.id]);
    }
    await client.query('COMMIT');
  } catch(err){ await client.query('ROLLBACK');throw err; }
  finally{client.release();}
  if(path) await flushDeletions(db,path).catch(err=>console.error('Lead photo deletion retry queued:',err.message));
  res.set('Cache-Control','no-store').json({ok:true,deleted:!!path});
});

module.exports={salesmanRouter,adminRouter};
