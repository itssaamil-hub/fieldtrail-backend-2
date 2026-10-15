const PDFDocument=require('pdfkit'),path=require('path');
const {money,number}=require('./quotations');
const {getBusinessName}=require('./businessProfile');
async function renderQuotationPDF(q,r,compact=false,knownBusinessName=undefined){
 const canonicalBusinessName=knownBusinessName===undefined?await getBusinessName():knownBusinessName;
 return new Promise((resolve,reject)=>{
 const s={...r.snapshot,company:canonicalBusinessName||r.snapshot.company},doc=new PDFDocument({size:'A4',margin:40,bufferPages:true,info:{Title:number(q,s),Author:s.company}}),chunks=[];let pageCount=1;
 doc.on('data',c=>chunks.push(c));doc.on('end',()=>{if(!compact&&pageCount>1)renderQuotationPDF(q,r,true,canonicalBusinessName).then(resolve,reject);else resolve(Buffer.concat(chunks));});doc.on('error',reject);
 doc.registerFont('regular',path.join(__dirname,'../assets/DejaVuSans.ttf'));doc.registerFont('bold',path.join(__dirname,'../assets/DejaVuSans-Bold.ttf'));
 const W=doc.page.width,H=doc.page.height,w=W-80,bottom=H-55,C={teal:'#145456',ink:'#203d3e',muted:'#627877',line:'#dce7e3',soft:'#eef6f2'};let y;
 function text(t,x,yy,width,size=10,bold=false,color=C.ink,opts={}){doc.font(bold?'bold':'regular').fontSize(size).fillColor(color).text(String(t),x,yy,{width,lineGap:2,...opts});}
 function heading(){doc.rect(0,0,W,105).fill(C.teal);let x=40;if(s.logo){doc.image(Buffer.from(s.logo.split(',')[1],'base64'),40,22,{fit:[48,48]});x=102;}text(s.company,x,22,w-(x-40),19,true,'#ffffff',{height:30,ellipsis:true});if(s.companyContact)text(s.companyContact,x,55,w-(x-40),8,false,'#dcebe7',{height:30,ellipsis:true});text('QUOTATION',40,87,140,8,true,'#dcebe7',{lineBreak:false});text(number(q,s)+'  /  REV '+r.revision,230,87,W-270,8,false,'#dcebe7',{align:'right',lineBreak:false});y=126;}
 function ensure(h){if(y+h>bottom){doc.addPage();heading();return true;}return false;}
 function paragraph(value,size=9,bold=false,color=C.ink){if(compact)size=Math.max(8,size-1);for(const line of String(value||'').split('\n')){if(!line){y+=4;continue;}let remain=line;while(remain){doc.font(bold?'bold':'regular').fontSize(size);let count=Math.min(remain.length,240);while(count>1&&doc.heightOfString(remain.slice(0,count),{width:w,lineGap:2})>90)count=Math.floor(count*.8);if(count<remain.length){const boundary=remain.lastIndexOf(' ',count);if(boundary>0)count=boundary;}const part=remain.slice(0,count),h=doc.heightOfString(part,{width:w,lineGap:2});ensure(h+6);text(part,40,y,w,size,bold,color);y+=h+(compact?2:4);remain=remain.slice(count).trimStart();}}y+=4;}
 function section(title){ensure(35);y+=compact?3:8;paragraph(title,10,true,C.teal);}
 heading();paragraph('PREPARED FOR',8,true,C.muted);paragraph(s.customer.name,18,true);paragraph([s.customer.contact,s.customer.phone].filter(Boolean).join(' · '),9,false,C.muted);
 ensure(42);doc.roundedRect(40,y,w,36,6).fill('#f3f6f5');text('Issued  '+s.issuedOn,52,y+11,w/2-12,9);text('Valid until  '+s.expiresOn,40+w/2,y+11,w/2-12,9,false,C.ink,{align:'right'});y+=52;
 const amountX=395;
 function tableHead(){doc.rect(40,y,w,23).fill(C.teal);text('Item & Description',50,y+6,320,8,true,'#ffffff');text('AMOUNT',amountX,y+6,W-50-amountX,8,true,'#ffffff',{align:'right'});y+=23;}
 tableHead();
 function item(module,period,isPackage=false){
  const name=module.name,qty=module.quantity||1,features=module.features||'',gross=module.grossMinor??Math.round(Number(module.price||0)*100)*qty,discount=Number((module.discount??(isPackage?s.discount:0))||0),discountMinor=module.discountMinor??Math.round(gross*discount/100),net=module.netMinor??gross-discountMinor;
  const size=compact?8:9;doc.font('bold').fontSize(size);const billing=[period,qty>1?('Qty '+qty):''].filter(Boolean).join(' · ');const h=Math.max(compact?32:38,doc.heightOfString(name,{width:320,lineGap:2})+24);
  if(ensure(h+(features?22:0)))tableHead();
  text(name,50,y+7,320,size,true);const nameBottom=doc.y;
  text(billing,50,nameBottom+1,320,8,false,C.muted);
  text(money(net,s.currency),amountX,y+7,W-50-amountX,8,true,C.ink,{align:'right'});
  y+=h;
  const list=String(features||'').split(/[\n,]+/).map(t=>t.trim()).filter(Boolean);
  let remaining=list.map(t=>'• '+t).join('   ');
  while(remaining){
   doc.font('regular').fontSize(8);let count=Math.min(remaining.length,350);
   if(count<remaining.length){const boundary=remaining.lastIndexOf(' ',count);if(boundary>0)count=boundary;}
   const part=remaining.slice(0,count),fh=doc.heightOfString(part,{width:w-20,lineGap:2});
   if(ensure(fh+24)){tableHead();text(name+' (continued)',50,y+5,w-20,8,true);y=doc.y+5;}
   text(part,50,y,w-20,8,false,C.muted);y+=fh+3;remaining=remaining.slice(count).trimStart();
  }
  if(discountMinor>0){
   const discountText='Discount '+discount+'%  −'+money(discountMinor,s.currency);
   doc.font('bold').fontSize(8);const dh=doc.heightOfString(discountText,{width:w-20,lineGap:2});
   if(ensure(dh+12)){tableHead();text(name+' (continued)',50,y+5,w-20,8,true);y=doc.y+5;}
   text(discountText,50,y+3,w-20,8,true,C.teal);y=doc.y+4;
  }
  y+=compact?3:6;doc.moveTo(40,y).lineTo(W-40,y).lineWidth(.5).strokeColor(C.line).stroke();
 }
 const periods={monthly:'Monthly',yearly:'',one_time:'One-time'};
 [s.package,...s.addons].forEach((a,i)=>item(a,periods[a.period],i===0));
 if(s.discountMinor){ensure(24);text('Total discounts',50,y+5,320,8,true,C.muted);text('−'+money(s.discountMinor,s.currency),amountX,y+5,W-50-amountX,8,true,C.teal,{align:'right'});y+=24;}
 if(s.taxPercent){ensure(24);text('Tax ('+s.taxPercent+'%)',50,y+5,320,8,false,C.muted);text(money(s.taxMinor,s.currency),amountX,y+5,W-50-amountX,8,false,C.ink,{align:'right'});y+=24;}y+=10;
 const boxH=compact?58:68;ensure(boxH+10);doc.roundedRect(40,y,w,boxH,9).fill(C.soft);
 text('TOTAL QUOTATION VALUE',54,y+10,w-28,8,true,C.teal);text(money(s.totalMinor,s.currency),54,y+27,w-28,compact?19:23,true);y+=boxH+10;
 if(s.terms){section('Payment & renewal terms');paragraph(s.terms,9,false,C.muted);}
 if(s.supportContact){section('Your support contact');paragraph(s.supportContact,9);}
 if(s.footer){y+=6;paragraph(s.footer,9,false,C.teal);}
 const range=doc.bufferedPageRange();pageCount=range.count;for(let i=0;i<range.count;i++){doc.switchToPage(i);doc.page.margins.bottom=0;doc.moveTo(40,H-40).lineTo(W-40,H-40).lineWidth(.5).strokeColor(C.line).stroke();text(number(q,s)+' · Revision '+r.revision,40,H-29,w-70,8,false,C.muted,{lineBreak:false});text(`${i+1} / ${range.count}`,W-95,H-29,55,8,false,C.muted,{align:'right',lineBreak:false});}doc.end();
 });
}
module.exports={renderQuotationPDF};