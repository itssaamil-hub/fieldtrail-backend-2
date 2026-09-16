const express=require('express');
const PDFDocument=require('pdfkit');
const db=require('../db');
const {requireAuth,requireRole}=require('../middleware/auth');
const {bad,validStepId,validateTemplate,buildSummary,snapshotSteps,formatDate}=require('../utils/onboarding');
const router=express.Router();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.use(requireAuth);
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
router.use(async(req,res,next)=>{const {rows}=await db.query('SELECT id FROM users WHERE id=$1 AND role=$2 AND is_active=true',[req.user.id,req.user.role]);if(!rows.length||!['admin','salesman'].includes(req.user.role))throw bad('Active account required',403);next();});
router.get('/template',requireRole('admin'),async(req,res)=>{const {rows}=await db.query('SELECT version,steps FROM onboarding_template WHERE id=1');res.json(rows[0]);});
router.put('/template',requireRole('admin'),async(req,res)=>{
 const steps=validateTemplate(req.body);
 const {rows}=await db.query('UPDATE onboarding_template SET steps=$1::jsonb,version=version+1,updated_at=now() WHERE id=1 AND version=$2 RETURNING version,steps',[JSON.stringify(steps),req.body.version]);
 if(!rows.length)throw bad('The template changed. Reload it before saving again.',409);
 res.json(rows[0]);
});
router.get('/customers',async(req,res)=>{
 const offset=Number(req.query.offset||0),search=req.query.search||'';
 if(!Number.isSafeInteger(offset)||offset<0||offset>100000||typeof search!=='string'||search.length>100)throw bad('Invalid search or page');
 const {rows}=await db.query(`SELECT l.id,l.business_name,l.contact_name,l.status,u.full_name AS assignee_name,
 c.lead_id IS NOT NULL AS started,
 CASE WHEN c.lead_id IS NULL THEN 0 ELSE jsonb_array_length(c.steps) END AS total,
 (SELECT count(*)::integer FROM jsonb_array_elements(COALESCE(c.steps,'[]'::jsonb)) step WHERE step->>'done'='true') AS completed
 FROM leads l LEFT JOIN customer_onboarding c ON c.lead_id=l.id LEFT JOIN users u ON u.id=l.salesman_id
 WHERE (l.status='won' OR c.lead_id IS NOT NULL) AND ($1::uuid IS NULL OR l.salesman_id=$1)
 AND position(lower($2) in lower(l.business_name))>0
 ORDER BY c.updated_at DESC NULLS LAST,l.created_at DESC,l.id LIMIT 31 OFFSET $3`,[req.user.role==='admin'?null:req.user.id,search,offset]);
 res.json({customers:rows.slice(0,30),hasMore:rows.length>30});
});
router.param('leadId',(req,res,next,id)=>{if(!UUID.test(id))return next(bad('Invalid customer'));next();});
async function customer(query,user,id,lock=false){
 const {rows}=await query(`SELECT id,business_name,contact_name,phone,salesman_id,status FROM leads WHERE id=$1 AND ($2::uuid IS NULL OR salesman_id=$2)${lock?' FOR SHARE':''}`,[id,user.role==='admin'?null:user.id]);
 if(!rows.length)throw bad('Customer not found',404);
 return rows[0];
}
async function record(query,user,id){
 const {rows}=await query(`SELECT c.*,l.id,l.business_name,l.contact_name,l.phone,l.salesman_id,l.status
 FROM customer_onboarding c JOIN leads l ON l.id=c.lead_id
 WHERE c.lead_id=$1 AND ($2::uuid IS NULL OR l.salesman_id=$2)`,[id,user.role==='admin'?null:user.id]);
 if(!rows.length)throw bad('Checklist not found or unavailable to your account',404);
 return rows[0];
}
router.post('/:leadId/start',async(req,res)=>{
 const client=await db.pool.connect(),query=client.query.bind(client);
 try{await query('BEGIN');const lead=await customer(query,req.user,req.params.leadId,true);
 const existing=await query('SELECT lead_id FROM customer_onboarding WHERE lead_id=$1',[lead.id]);
 if(!existing.rows.length){if(lead.status!=='won')throw bad('Mark the deal Won before starting onboarding',409);
 const {rows}=await query('SELECT version,steps FROM onboarding_template WHERE id=1 FOR SHARE');
 const template=rows[0];if(!template)throw bad('Checklist template not configured',409);
 await query('INSERT INTO customer_onboarding(lead_id,template_version,steps,created_by) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(lead_id) DO NOTHING',[lead.id,template.version,JSON.stringify(snapshotSteps(template.steps)),req.user.id]);}
 await query('COMMIT');res.json({ok:true});
 }catch(e){await query('ROLLBACK');throw e;}finally{client.release();}
});
router.get('/:leadId',async(req,res)=>res.json({onboarding:await record(db.query,req.user,req.params.leadId)}));
router.patch('/:leadId/steps/:stepId',async(req,res)=>{
 const b=req.body||{};
 if(!validStepId(req.params.stepId)||!Number.isSafeInteger(b.version)||b.version<1||typeof b.done!=='boolean'||typeof b.note!=='string'||b.note.length>1000)throw bad('Invalid checklist update');
 const client=await db.pool.connect(),query=client.query.bind(client);
 try{await query('BEGIN');const lead=await customer(query,req.user,req.params.leadId,true);
 const {rows}=await query('SELECT * FROM customer_onboarding WHERE lead_id=$1 FOR UPDATE',[lead.id]);
 const current=rows[0];if(!current)throw bad('Checklist not found',404);
 if(current.version!==b.version)throw bad('This checklist changed. Refresh before updating it.',409);
 const step=current.steps.find(s=>s.id===req.params.stepId);if(!step)throw bad('Step not found',404);
 if(step.done!==b.done){step.completedAt=b.done?new Date().toISOString():null;step.completedBy=b.done?req.user.id:null;}
 step.done=b.done;step.note=b.note.trim();
 const result=await query('UPDATE customer_onboarding SET steps=$2::jsonb,version=version+1,updated_at=now() WHERE lead_id=$1 RETURNING *',[lead.id,JSON.stringify(current.steps)]);
 await query(`INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'onboarding.updated','lead',$2,$3::jsonb)`,[req.user.id,lead.id,JSON.stringify({businessName:lead.business_name,stepTitle:step.title})]);
 await query('COMMIT');res.json({onboarding:{...result.rows[0],...lead}});
 }catch(e){await query('ROLLBACK');throw e;}finally{client.release();}
});
router.get('/:leadId/summary',requireRole('admin'),async(req,res)=>res.json({summary:buildSummary(await record(db.query,req.user,req.params.leadId))}));
router.get('/:leadId/pdf',requireRole('admin'),async(req,res)=>{
 const summary=buildSummary(await record(db.query,req.user,req.params.leadId));
 // Build before sending headers, so failures still produce a useful JSON error.
 const buffer=await new Promise((resolve,reject)=>{const doc=new PDFDocument({size:'A4',margin:48}),chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
 doc.font(require('path').join(__dirname,'../assets/DejaVuSans.ttf'));
 doc.fillColor('#145456').fontSize(24).text('SWIRL');doc.fillColor('#253135').fontSize(15).text('Customer onboarding completion');doc.moveDown();doc.fontSize(18).text(summary.businessName);if(summary.contactName)doc.fontSize(11).text(`Contact: ${summary.contactName}`);doc.fontSize(10).fillColor('#59696e').text(`Completed: ${formatDate(summary.completedAt)}`);doc.moveDown();
 for(const step of summary.steps){const height=doc.fontSize(12).heightOfString(`[Done] ${step.title}`)+42;if(doc.y+height>doc.page.height-70)doc.addPage();doc.fillColor('#253135').fontSize(12).text(`[Done] ${step.title}`);doc.fillColor('#59696e').fontSize(9).text(formatDate(step.completedAt));doc.moveDown();}
 doc.moveDown().fillColor('#253135').fontSize(11).text('All required checklist steps are complete. Please confirm a suitable go-live date.');doc.moveDown().fontSize(10).text('Prepared by your Swirl team.');doc.end();});
 res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="swirl-onboarding-summary.pdf"','Cache-Control':'no-store'});res.send(buffer);
});
router.use((err,req,res,next)=>{if(err.status)return res.status(err.status).json({error:err.message});next(err);});
module.exports=router;
