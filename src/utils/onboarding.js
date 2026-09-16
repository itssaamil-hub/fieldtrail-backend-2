const bad = (message,status=400) => Object.assign(new Error(message),{status});
const validStepId = id => typeof id==='string' && /^[a-zA-Z0-9-]{1,60}$/.test(id);
function validateTemplate(body) {
 if (!Number.isSafeInteger(body?.version)||body.version<1) throw bad('Invalid template version');
 if (!Array.isArray(body.steps)||body.steps.length<1||body.steps.length>30) throw bad('Keep between 1 and 30 checklist steps');
 const ids=new Set();
 return body.steps.map(s=>{
  if(!s||!validStepId(s.id)||ids.has(s.id)) throw bad('Step IDs must be unique');
  if(typeof s.title!=='string'||!s.title.trim()||s.title.trim().length>160) throw bad('Each step needs a name of 1–160 characters');
  ids.add(s.id);return {id:s.id,title:s.title.trim()};
 });
}
const formatDate = date => new Date(date).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+' IST';
function buildSummary(row) {
 if(!row.steps?.length||row.steps.some(s=>!s.done||!s.completedAt)) throw bad('Complete every checklist step before sharing',409);
 const completedAt=row.steps.reduce((latest,s)=>s.completedAt>latest?s.completedAt:latest,'');
 const greeting=row.contact_name?.trim()?`Hello ${row.contact_name.trim()},`:'Hello,';
 const text=`${greeting}\n\nYour ${row.business_name} Swirl setup checklist is complete.\n\n${row.steps.map(s=>`✓ ${s.title}`).join('\n')}\n\nCompleted: ${formatDate(completedAt)}\n\nPlease confirm a suitable go-live date.\nYour Swirl team`;
 return {businessName:row.business_name,contactName:row.contact_name||'',phone:row.phone||'',completedAt,text,
  steps:row.steps.map(s=>({title:s.title,completedAt:s.completedAt})),version:row.version};
}
function snapshotSteps(template) { return template.map(s=>({id:s.id,title:s.title,done:false,note:'',completedAt:null,completedBy:null})); }
module.exports={bad,validStepId,validateTemplate,buildSummary,snapshotSteps,formatDate};
