const bad = (message,status=400) => Object.assign(new Error(message),{status});
const validStepId = id => typeof id==='string' && /^[a-zA-Z0-9-]{1,60}$/.test(id);
const STAGES=['','setup','training','go_live'];
function validateTemplate(body) {
 if (!Number.isSafeInteger(body?.version)||body.version<1) throw bad('Invalid template version');
 if (!Array.isArray(body.steps)||body.steps.length<1||body.steps.length>30) throw bad('Keep between 1 and 30 checklist steps');
 const ids=new Set();
 return body.steps.map(s=>{
  if(!s||!validStepId(s.id)||ids.has(s.id)) throw bad('Step IDs must be unique');
  if(typeof s.title!=='string'||!s.title.trim()||s.title.trim().length>160) throw bad('Each step needs a name of 1–160 characters');
  const stage=s.stage==null?'':String(s.stage);
  if(!STAGES.includes(stage)) throw bad('Invalid onboarding stage');
  ids.add(s.id);return {id:s.id,title:s.title.trim(),...(stage?{stage}:{})};
 });
}
const DEFAULT_SHARING = {
 title:'Your restaurant is now live on Swirl!',
 intro:'Hello {owner},\n\nYour setup is complete, and {restaurant} is now live on Swirl.',
 closing:'Thank you for choosing Swirl. Please contact our team if you need assistance.\n\nTeam Swirl'
};
function validateSharing(value) {
 if(!value||typeof value!=='object'||Array.isArray(value))throw bad('Invalid sharing message');
 const result={};
 for(const [key,max] of [['title',120],['intro',1000],['closing',1000]]){
  if(typeof value[key]!=='string'||!value[key].trim()||value[key].trim().length>max)throw bad(`${key} must contain 1–${max} characters`);
  if(/\{(?!owner\}|restaurant\})[^}]*\}/.test(value[key]))throw bad('Use only {owner} and {restaurant} as placeholders');
  result[key]=value[key].trim();
 }
 return result;
}
function renderMessage(value,row){return value.replace(/\{(owner|restaurant)\}/g,(_,key)=>key==='owner'?(row.contact_name?.trim()||'there'):row.business_name);}
const formatDate = date => new Date(date).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+' IST';
function buildSummary(row) {
 if(!row.steps?.length||row.steps.some(s=>!s.done||!s.completedAt)) throw bad('Complete every checklist step before sharing',409);
 const completedAt=row.steps.reduce((latest,s)=>s.completedAt>latest?s.completedAt:latest,'');
 const sharing=row.sharing||DEFAULT_SHARING;
 const title=renderMessage(sharing.title,row),intro=renderMessage(sharing.intro,row),closing=renderMessage(sharing.closing,row);
 const text=`${title}\n\n${intro}\n\n${row.steps.map(s=>`✓ ${s.title}`).join('\n')}\n\nCompleted: ${formatDate(completedAt)}\n\n${closing}`;
 return {businessName:row.business_name,assigneeName:row.assignee_name||'',contactName:row.contact_name||'',phone:row.phone||'',completedAt,text,title,intro,closing,
  steps:row.steps.map(s=>({title:s.title,completedAt:s.completedAt,stage:s.stage||''})),version:row.version};
}
function snapshotSteps(template) { return template.map(s=>({id:s.id,title:s.title,...(s.stage?{stage:s.stage}:{}),done:false,note:'',completedAt:null,completedBy:null})); }
module.exports={DEFAULT_SHARING,validateSharing,bad,validStepId,validateTemplate,buildSummary,snapshotSteps,formatDate};
