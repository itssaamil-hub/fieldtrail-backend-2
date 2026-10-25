const express=require('express'),bcrypt=require('bcryptjs'),db=require('../db'),path=require('path');
const {requireAuth,requireRole}=require('../middleware/auth');
const {bad,UUID}=require('../utils/quotations');
const B=require('../utils/broadcastData');
const admin=express.Router(),publicRouter=express.Router();
const reads=new Map();
publicRouter.use((req,res,next)=>{
 const now=Date.now(),key=req.ip||'unknown';
 for(const [ip,b] of reads)if(b.until<=now)reads.delete(ip);
 if(!reads.has(key)&&reads.size>=10000)return res.status(429).json({error:'Please try again shortly.'});
 const b=reads.get(key)||{count:0,until:now+60000};b.count++;reads.set(key,b);
 if(b.count>120)return res.status(429).json({error:'Too many requests. Try again in a minute.'});
 next();
});
admin.use(requireAuth,requireRole('admin'));
const safe=r=>({id:r.id,config:r.config,created_at:r.created_at,expires_at:r.expires_at,revoked_at:r.revoked_at,protected:!!r.pin_hash,token:r.revoked_at||r.expires_at&&new Date(r.expires_at)<=new Date()?null:B.tokenFor(r.id)});
admin.get('/',async(req,res)=>{const offset=Number(req.query.offset||0);if(!Number.isSafeInteger(offset)||offset<0)throw bad('Invalid page');const {rows}=await db.query('SELECT * FROM broadcast_links ORDER BY created_at DESC,id LIMIT 51 OFFSET $1',[offset]);res.json({links:rows.slice(0,50).map(safe),hasMore:rows.length>50});});
admin.get('/employees',async(req,res)=>res.json({employees:(await db.query("SELECT id,full_name FROM users WHERE role='salesman' ORDER BY full_name,id")).rows}));
admin.post('/preview',async(req,res)=>res.json(await B.reportView(db.query,B.validate(req.body),req.body)));
admin.post('/',async(req,res)=>{
 const c=B.validate(req.body),id=req.body.requestId,pin=req.body.pin||'';
 if(!UUID.test(id||''))throw bad('Request identifier required');
 if(typeof pin!=='string'||pin&&!/^\d{6}$/.test(pin))throw bad('PIN must contain exactly 6 digits');
 if(c.employee&&!(await db.query("SELECT id FROM users WHERE id=$1 AND role='salesman'",[c.employee])).rows.length)throw bad('Employee not found');
 const hash=pin?await bcrypt.hash(pin,10):null;
 const result=await db.query(`INSERT INTO broadcast_links(id,created_by,config,pin_hash,expires_at) VALUES($1,$2,$3::jsonb,$4,CASE WHEN $5::int=0 THEN NULL ELSE now()+($5::int*interval '1 day') END) ON CONFLICT(id) DO NOTHING RETURNING *`,[id,req.user.id,JSON.stringify(c),hash,c.expiryDays]);
 let row=result.rows[0];
 if(!row){row=(await db.query('SELECT * FROM broadcast_links WHERE id=$1 AND created_by=$2',[id,req.user.id])).rows[0];if(!row||JSON.stringify(B.validate(row.config))!==JSON.stringify(c)||!!row.pin_hash!==!!pin||pin&&!await bcrypt.compare(pin,row.pin_hash))throw bad('Request identifier already used. Refresh and try again.',409);}
 res.status(result.rows.length?201:200).json({link:safe(row)});
});
admin.post('/:id/revoke',async(req,res)=>{if(!UUID.test(req.params.id))throw bad('Invalid link');const r=await db.query('UPDATE broadcast_links SET revoked_at=COALESCE(revoked_at,now()),revoked_by=COALESCE(revoked_by,$2) WHERE id=$1 RETURNING id',[req.params.id,req.user.id]);if(!r.rows.length)throw bad('Link not found',404);res.json({ok:true});});
publicRouter.get('/view',(req,res)=>{
 res.set({'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow, noarchive','Referrer-Policy':'no-referrer'});
 res.sendFile(path.join(__dirname,'../public/broadcast.html'));
});
// Tokens and PINs are in the request body, never URLs or application logs.
publicRouter.post('/read',async(req,res)=>{
 res.set({'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow, noarchive'});
 const id=B.tokenId(req.body.token);if(!id)throw bad('This report link is unavailable.',404);
 const client=await db.pool.connect();let row;
 try{
  await client.query('BEGIN');
  row=(await client.query(`SELECT b.* FROM broadcast_links b JOIN users u ON u.id=b.created_by AND u.role='admin' AND u.is_active=true WHERE b.id=$1 AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now()) FOR UPDATE OF b`,[id])).rows[0];
  if(!row)throw bad('This report link has expired or been revoked.',404);
  if(row.pin_hash){
   if(row.locked_until&&new Date(row.locked_until)>new Date())throw bad('Too many incorrect PIN attempts. Try again in 15 minutes.',429);
   const pin=req.body.pin;
   if(pin===undefined||pin==='')throw bad('Enter the report PIN.',401);
   if(typeof pin!=='string'||!/^\d{6}$/.test(pin)||!await bcrypt.compare(pin,row.pin_hash)){
    await client.query(`UPDATE broadcast_links SET failed_attempts=CASE WHEN locked_until IS NOT NULL AND locked_until<=now() THEN 1 ELSE failed_attempts+1 END, locked_until=CASE WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until<=now() THEN 0 ELSE failed_attempts END)>=9 THEN now()+interval '15 minutes' ELSE NULL END WHERE id=$1`,[id]);
    await client.query('COMMIT');return res.status(401).json({error:'Incorrect PIN.'});
   }
   await client.query('UPDATE broadcast_links SET failed_attempts=0,locked_until=NULL WHERE id=$1',[id]);
  }
  const result=await B.reportView(client.query.bind(client),row.config,req.body);
  await client.query('COMMIT');res.json(result);
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
module.exports={admin,publicRouter};
