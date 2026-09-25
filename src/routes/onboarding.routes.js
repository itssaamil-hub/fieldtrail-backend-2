const express=require('express');
const crypto=require('crypto');
const {renderOnboardingPDF}=require('../utils/onboardingPDF');
const db=require('../db');
const {requireAuth,requireRole}=require('../middleware/auth');
const {bad,validStepId,validateTemplate,validateSharing,buildSummary,snapshotSteps,DEFAULT_SHARING}=require('../utils/onboarding');
const router=express.Router();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN=/^[a-f0-9]{48}$/i;
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const publicOrigin=req=>process.env.PUBLIC_BACKEND_URL||`${req.get('x-forwarded-proto')||req.protocol}://${req.get('host')}`;
const stageLabel=stage=>({setup:'Setup',training:'Training',go_live:'Go Live'}[stage]||'Checklist');

router.get('/public/:token',async(req,res)=>{
 if(!TOKEN.test(req.params.token))return res.status(404).send('Progress link not found');
 const {rows}=await db.query(`SELECT c.steps,c.updated_at,l.business_name,u.full_name AS assignee_name,tpl.sharing
 FROM customer_onboarding c JOIN leads l ON l.id=c.lead_id LEFT JOIN users u ON u.id=l.salesman_id CROSS JOIN onboarding_template tpl
 WHERE tpl.id=1 AND c.share_token=$1 AND c.share_enabled=true LIMIT 1`,[req.params.token]);
 const row=rows[0];
 if(!row)return res.status(404).send('Progress link not found');
 const sharing={...DEFAULT_SHARING,...(row.sharing||{})};
 const onboardingName=sharing.onboardingName||DEFAULT_SHARING.onboardingName;
 const steps=Array.isArray(row.steps)?row.steps:[];
 const completed=steps.filter(s=>s.done).length,total=steps.length,pct=total?Math.round(completed/total*100):0;
 const next=steps.find(s=>!s.done);
 const groups=[];
 for(const step of steps){const key=step.stage||'';let group=groups.find(g=>g.key===key);if(!group){group={key,items:[]};groups.push(group)}group.items.push(step)}
 const renderStep=s=>`<li class="step ${s.done?'done':''}"><span class="check">${s.done?'✓':'○'}</span><div><strong>${esc(s.title)}</strong>${s.done&&s.completedAt?`<small>Completed ${esc(new Date(s.completedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}))} IST</small>`:''}</div></li>`;
 const checklist=groups.map(g=>`<div class="section"><h2>${esc(stageLabel(g.key))}</h2><ul class="steps">${g.items.map(renderStep).join('')}</ul></div>`).join('');
 res.set('Cache-Control','no-store');
 res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(row.business_name)} onboarding progress</title><style>
 *{box-sizing:border-box}body{margin:0;background:#f4f6f7;color:#172128;font-family:Inter,system-ui,-apple-system,sans-serif}.wrap{max-width:720px;margin:auto;padding:28px 16px 40px}.brand{font-weight:800;color:#145c5d;font-size:18px;margin-bottom:16px}.card{background:#fff;border:1px solid #e4e9e8;border-radius:18px;padding:20px;box-shadow:0 8px 28px rgba(27,63,64,.06)}h1{margin:0 0 6px;font-size:25px}.muted{color:#6f7b7d;font-size:13px}.progressTop{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:22px 0 10px}.big{font-size:20px;font-weight:800}.pct{font-size:22px;font-weight:800;color:#12805c}.bar{height:10px;background:#edf1f1;border-radius:999px;overflow:hidden}.bar i{display:block;height:100%;width:${pct}%;background:#12805c;border-radius:999px}.next{margin:18px 0;padding:14px 16px;background:#fff8e9;border:1px solid #f3e1b9;border-radius:14px}.next small{display:block;color:#9a6a13;font-weight:700;margin-bottom:4px}.section{margin-top:18px}.section h2{font-size:15px;margin:0 0 10px}.steps{list-style:none;margin:0;padding:0;border:1px solid #e8ecec;border-radius:14px;overflow:hidden}.step{display:flex;gap:10px;padding:13px 14px;border-bottom:1px solid #edf0f0;background:#fff}.step:last-child{border-bottom:0}.step.done{background:#fbfefd}.check{width:24px;height:24px;display:grid;place-items:center;border-radius:7px;background:#edf7f3;color:#12805c;font-weight:900;flex:none}.step small{display:block;color:#7d898b;margin-top:3px;font-size:11px}.footer{margin-top:16px;color:#879193;font-size:11px;text-align:center}@media(max-width:520px){.wrap{padding:18px 12px 28px}.card{padding:16px;border-radius:16px}h1{font-size:21px}.progressTop{align-items:flex-end}}
 </style></head><body><main class="wrap"><div class="brand">${esc(onboardingName)}</div><section class="card"><h1>${esc(row.business_name)}</h1><div class="muted">Assigned to ${esc(row.assignee_name||'Team')} · Last updated ${esc(new Date(row.updated_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}))} IST</div><div class="progressTop"><div><div class="big">${completed} of ${total} completed</div><div class="muted">Live onboarding progress</div></div><div class="pct">${pct}%</div></div><div class="bar"><i></i></div>${next?`<div class="next"><small>Next action</small><strong>${esc(next.title)}</strong></div>`:`<div class="next"><small>Status</small><strong>Go Live Ready ✓</strong></div>`}${checklist}<div class="footer">This is a read-only live progress page. Internal notes are never shown.</div></section></main></body></html>`);
});

router.use(requireAuth);
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
router.use(async(req,res,next)=>{const {rows}=await db.query('SELECT id FROM users WHERE id=$1 AND role=$2 AND is_active=true',[req.user.id,req.user.role]);if(!rows.length||!['admin','salesman'].includes(req.user.role))throw bad('Active account required',403);next();});
router.get('/template',requireRole('admin'),async(req,res)=>{const {rows}=await db.query('SELECT version,steps,sharing FROM onboarding_template WHERE id=1');res.json(rows[0]);});
router.put('/template',requireRole('admin'),async(req,res)=>{
 const steps=validateTemplate(req.body);
 const sharing=req.body.sharing===undefined?null:validateSharing(req.body.sharing);
 const {rows}=await db.query('UPDATE onboarding_template SET steps=$1::jsonb,sharing=COALESCE($3::jsonb,sharing),version=version+1,updated_at=now() WHERE id=1 AND version=$2 RETURNING version,steps,sharing',[JSON.stringify(steps),req.body.version,sharing?JSON.stringify(sharing):null]);
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
 const {rows}=await query(`SELECT c.*,tpl.sharing,u.full_name AS assignee_name,l.id,l.business_name,l.contact_name,l.phone,l.salesman_id,l.status
 FROM customer_onboarding c JOIN leads l ON l.id=c.lead_id LEFT JOIN users u ON u.id=l.salesman_id CROSS JOIN onboarding_template tpl
 WHERE tpl.id=1 AND c.lead_id=$1 AND ($2::uuid IS NULL OR l.salesman_id=$2)`,[id,user.role==='admin'?null:user.id]);
 if(!rows.length)throw bad('Checklist not found or unavailable to your account',404);
 return rows[0];
}
async function shareLink(req,item){
 let token=item.share_token;
 if(!token){token=crypto.randomBytes(24).toString('hex');await db.query('UPDATE customer_onboarding SET share_token=$2,share_enabled=true,share_created_at=now() WHERE lead_id=$1',[req.params.leadId,token]);}
 else if(!item.share_enabled)await db.query('UPDATE customer_onboarding SET share_enabled=true WHERE lead_id=$1',[req.params.leadId]);
 return `${publicOrigin(req)}/onboarding/public/${token}`;
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
router.post('/:leadId/share-link',async(req,res)=>{
 const item=await record(db.query,req.user,req.params.leadId);
 const shareUrl=await shareLink(req,item);
 res.json({shareUrl,businessName:item.business_name,phone:item.phone||'',completed:item.steps.filter(s=>s.done).length,total:item.steps.length});
});
router.get('/:leadId/summary',requireRole('admin'),async(req,res)=>{
 const item=await record(db.query,req.user,req.params.leadId);
 const summary=buildSummary(item);
 res.json({summary:{...summary,shareUrl:await shareLink(req,item)}});
});
router.get('/:leadId/pdf',requireRole('admin'),async(req,res)=>{
 const summary=buildSummary(await record(db.query,req.user,req.params.leadId));
 const buffer=await renderOnboardingPDF(summary);
 res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="swirl-onboarding-summary.pdf"','Cache-Control':'no-store'});res.send(buffer);
});
router.use((err,req,res,next)=>{if(err.status)return res.status(err.status).json({error:err.message});next(err);});
module.exports=router;
