const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function bad(message,status=400){return Object.assign(new Error(message),{status});}
function str(v,max,required=false){if(typeof v!=='string'||v.length>max||(required&&!v.trim()))throw bad('Missing or invalid text field');return v.trim();}
function num(v,min,max){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||Math.abs(v*100-Math.round(v*100))>.000001)throw bad('Invalid amount or percentage');return v;}
function day(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function date(v,optional=false){if(optional&&(v===''||v==null))return null;if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)throw bad('Invalid date');return v;}
function validateConfig(b){
 if(!b||typeof b!=='object')throw bad('Invalid quotation settings');
 const list=(items,packages)=>{if(!Array.isArray(items)||items.length>30)throw bad('Use at most 30 packages or add-ons');const ids=new Set();return items.map(x=>{if(!x||!UUID.test(x.id)||ids.has(x.id))throw bad('Invalid or duplicate item');ids.add(x.id);const item={id:x.id,name:str(x.name,100,true),price:num(x.price,0,100000000),period:x.period};if(!['monthly','yearly','one_time'].includes(item.period))throw bad('Invalid billing period');if(packages)item.features=str(x.features,1500);return item;});};
 const c={companyContact:str(b.companyContact||'',240),supportContact:str(b.supportContact||'',240),company:str(b.company,120,true),prefix:str(b.prefix,12,true),currency:b.currency,logo:str(b.logo||'',300000),packages:list(b.packages,true),addons:list(b.addons,false),discountLimit:num(b.discountLimit,0,100),validDays:num(b.validDays,1,365),advancePercent:num(b.advancePercent,0,100),taxPercent:num(b.taxPercent,0,100),terms:str(b.terms,2000),footer:str(b.footer,1000),whatsapp:str(b.whatsapp,1500,true)};
 if(!Number.isInteger(c.validDays)||!['INR','AED','SAR'].includes(c.currency)||! /^[A-Z0-9-]+$/.test(c.prefix))throw bad('Invalid currency, quote prefix or validity');
 if((c.whatsapp.match(/\{[^}]*\}/g)||[]).some(x=>!['{restaurant}','{total}','{expiry}','{quote}'].includes(x)))throw bad('Unknown WhatsApp placeholder');
 if(c.logo){if(!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(c.logo))throw bad('Upload a PNG or JPEG logo');try{const PDF=require('pdfkit'),doc=new PDF({autoFirstPage:false}),img=doc.openImage(Buffer.from(c.logo.split(',')[1],'base64'));if(img.width>2000||img.height>2000)throw Error();doc.end();}catch{throw bad('Logo must be a valid PNG or JPEG, at most 2000 × 2000 pixels');}}
 return c;
}
function buildSnapshot(c,b,customer){
 if(!b||typeof b!=='object')throw bad('Invalid quotation');const pack=c.packages.find(x=>x.id===b.packageId);if(!pack)throw bad('Select an available package');
 if(!Array.isArray(b.addonIds)||b.addonIds.length>30||new Set(b.addonIds).size!==b.addonIds.length)throw bad('Invalid add-ons');const addons=b.addonIds.map(id=>{const a=c.addons.find(x=>x.id===id);if(!a)throw bad('Add-on no longer available');return a;});
 if(!customer||typeof customer!=='object')throw bad('Enter customer details');
 const phone=str(customer.phone,30,true);if(!/^[+\d ()-]+$/.test(phone)||!/^\d{8,15}$/.test(phone.replace(/\D/g,'')))throw bad('Enter a valid customer phone number');
 const discount=num(b.discount,0,100),reason=str(b.reason||'',1000);if(discount>c.discountLimit&&!reason)throw bad('Explain the extra discount for admin approval');
 const packageMinor=Math.round(pack.price*100),discountMinor=Math.round(packageMinor*discount/100),subtotalMinor=packageMinor+addons.reduce((n,a)=>n+Math.round(a.price*100),0),taxMinor=Math.round((subtotalMinor-discountMinor)*c.taxPercent/100);
 const issuedOn=day(),expires=new Date(issuedOn+'T00:00:00Z');expires.setUTCDate(expires.getUTCDate()+c.validDays);
 return {companyContact:c.companyContact||'',supportContact:c.supportContact||'',company:c.company,logo:c.logo,currency:c.currency,prefix:c.prefix,package:{...pack},addons:addons.map(a=>({...a})),customer:{name:str(customer.name,180,true),contact:str(customer.contact||'',120),phone:str(customer.phone,30,true)},discount,reason,discountLimit:c.discountLimit,subtotalMinor,discountMinor,taxMinor,taxPercent:c.taxPercent,totalMinor:subtotalMinor-discountMinor+taxMinor,advancePercent:c.advancePercent,terms:c.terms,footer:c.footer,whatsapp:c.whatsapp,issuedOn,expiresOn:expires.toISOString().slice(0,10)};
}
const money=(minor,currency)=>new Intl.NumberFormat('en-IN',{style:'currency',currency}).format(minor/100);
const number=(q,s)=>`${s.prefix}-${String(q.number).padStart(5,'0')}`;
function canShare(r){if(!['ready','sent','accepted'].includes(r.status))throw bad('This quotation is not approved for sharing',409);if(String(r.expires_on).slice(0,10)<day()&&r.status!=='accepted')throw bad('Quotation expired. Create a revision before sharing.',409);}
function customerSummary(q,r){canShare(r);const s=r.snapshot,quoteNumber=number(q,s);return {quoteNumber,phone:s.customer.phone,text:s.whatsapp.replace(/\{(restaurant|total|expiry|quote)\}/g,(_,key)=>({restaurant:s.customer.name,total:money(s.totalMinor,s.currency),expiry:s.expiresOn,quote:quoteNumber}[key]))};}
async function runQuotationReminders(query=require('../db').query){const {rows}=await query(`INSERT INTO quotation_alerts(user_id,quote_id,revision,kind)
 SELECT q.owner_id,q.id,r.revision,'follow_up' FROM quotations q JOIN quotation_revisions r ON r.quote_id=q.id AND r.revision=q.current_revision JOIN users u ON u.id=q.owner_id
 WHERE u.is_active=true AND r.status='sent' AND r.follow_up <= (now() AT TIME ZONE 'Asia/Kolkata')::date
 ON CONFLICT(user_id,quote_id,revision,kind,day) DO NOTHING RETURNING id`);return {quotationReminders:rows.length};}
module.exports={UUID,bad,str,num,day,date,validateConfig,buildSnapshot,money,number,canShare,customerSummary,runQuotationReminders};
