const PDFDocument=require('pdfkit'),path=require('path');
const {money,number}=require('./quotations');
function renderQuotationPDF(q,r,compact=false){return new Promise((resolve,reject)=>{
 const s=r.snapshot,doc=new PDFDocument({size:'A4',margin:40,bufferPages:true,info:{Title:number(q,s),Author:s.company}}),chunks=[];let pageCount=1;
 doc.on('data',c=>chunks.push(c));doc.on('end',()=>{if(!compact&&pageCount>1)renderQuotationPDF(q,r,true).then(resolve,reject);else resolve(Buffer.concat(chunks));});doc.on('error',reject);
 doc.registerFont('regular',path.join(__dirname,'../assets/DejaVuSans.ttf'));doc.registerFont('bold',path.join(__dirname,'../assets/DejaVuSans-Bold.ttf'));
 const W=doc.page.width,H=doc.page.height,w=W-80,bottom=H-55,C={teal:'#145456',ink:'#203d3e',muted:'#627877',line:'#dce7e3',soft:'#eef6f2'};let y;
 function text(t,x,yy,width,size=10,bold=false,color=C.ink,opts={}){doc.font(bold?'bold':'regular').fontSize(size).fillColor(color).text(String(t),x,yy,{width,lineGap:2,...opts});}
 function heading(){doc.rect(0,0,W,105).fill(C.teal);let x=40;if(s.logo){doc.image(Buffer.from(s.logo.split(',')[1],'base64'),40,22,{fit:[48,48]});x=102;}text(s.company,x,22,w-(x-40),19,true,'#ffffff',{height:30,ellipsis:true});if(s.companyContact)text(s.companyContact,x,55,w-(x-40),8,false,'#dcebe7',{height:30,ellipsis:true});text('QUOTATION',40,87,140,8,true,'#dcebe7',{lineBreak:false});text(number(q,s)+'  /  REV '+r.revision,230,87,W-270,8,false,'#dcebe7',{align:'right',lineBreak:false});y=126;}
 function ensure(h){if(y+h>bottom){doc.addPage();heading();return true;}return false;}
 function paragraph(value,size=9,bold=false,color=C.ink){if(compact)size=Math.max(8,size-1);for(const line of String(value||'').split('\n')){if(!line){y+=4;continue;}let remain=line;while(remain){doc.font(bold?'bold':'regular').fontSize(size);let count=Math.min(remain.length,240);while(count>1&&doc.heightOfString(remain.slice(0,count),{width:w,lineGap:2})>90)count=Math.floor(count*.8);if(count<remain.length){const boundary=remain.lastIndexOf(' ',count);if(boundary>0)count=boundary;}const part=remain.slice(0,count),h=doc.heightOfString(part,{width:w,lineGap:2});ensure(h+6);text(part,40,y,w,size,bold,color);y+=h+(compact?2:4);remain=remain.slice(count).trimStart();}}y+=4;}
 function section(title){ensure(35);y+=compact?3:8;paragraph(title,10,true,C.teal);}
 heading();paragraph('PREPARED FOR',8,true,C.muted);paragraph(s.customer.name,18,true);paragraph([s.customer.contact,s.customer.phone].filter(Boolean).join(' · '),9,false,C.muted);
 ensure(42);doc.roundedRect(40,y,w,36,6).fill('#f3f6f5');text('Issued  '+s.issuedOn,52,y+11,w/2-12,9);text('Valid until  '+s.expiresOn,40+w/2,y+11,w/2-12,9,false,C.ink,{align:'right'});y+=52;
 const qtyX=270,unitX=310,amountX=420;
 function tableHead(){doc.rect(40,y,w,23).fill(C.teal);text('MODULE / BILLING',50,y+6,210,8,true,'#ffffff');text('QTY',qtyX,y+6,35,8,true,'#ffffff',{align:'center'});text('UNIT PRICE',unitX,y+6,100,8,true,'#ffffff',{align:'right'});text('AMOUNT',amountX,y+6,W-50-amountX,8,true,'#ffffff',{align:'right'});y+=23;}
 tableHead();
 function item(name,period,unit,qty=1,features=''){
  const size=compact?8:9;doc.font('bold').fontSize(size);const h=Math.max(compact?32:38,doc.heightOfString(name,{width:210,lineGap:2})+24);
  if(ensure(h+(features?22:0)))tableHead();
  text(name,50,y+7,210,size,true);const nameBottom=doc.y;
  text(period,50,nameBottom+1,210,8,false,C.muted);
  text(qty===null?'':qty,qtyX,y+7,35,8,false,C.muted,{align:'center'});
  text(qty===null?'':money(unit,s.currency),unitX,y+7,100,8,false,C.muted,{align:'right'});
  text(money(unit*(qty||1),s.currency),amountX,y+7,W-50-amountX,8,false,C.ink,{align:'right'});y+=h;
  const list=String(features||'').split(/[\n,]+/).map(t=>t.trim()).filter(Boolean);
  // Wrap every feature below its module. Never truncate feature text.
  let remaining=list.map(t=>'• '+t).join('   ');
  while(remaining){
   doc.font('regular').fontSize(8);let count=Math.min(remaining.length,350);
   if(count<remaining.length){const boundary=remaining.lastIndexOf(' ',count);if(boundary>0)count=boundary;}
   const part=remaining.slice(0,count),fh=doc.heightOfString(part,{width:w-20,lineGap:2});
   if(ensure(fh+24)){tableHead();text(name+' (continued)',50,y+5,w-20,8,true);y=doc.y+5;}
   text(part,50,y,w-20,8,false,C.muted);y+=fh+3;remaining=remaining.slice(count).trimStart();
  }
  y+=compact?3:6;doc.moveTo(40,y).lineTo(W-40,y).lineWidth(.5).strokeColor(C.line).stroke();
 }
 const periods={monthly:'Monthly',yearly:'Yearly',one_time:'One-time'};
 for(const a of [s.package,...s.addons])item(a.name,periods[a.period],Math.round(a.price*100),a.quantity||1,a.features);
 if(s.discountMinor)item('Package discount ('+s.discount+'%)','',-s.discountMinor,null);
 if(s.taxPercent)item('Tax ('+s.taxPercent+'%)','',s.taxMinor,null);y+=10;
 const advance=Math.round(s.totalMinor*s.advancePercent/100),boxH=compact?85:100;ensure(boxH+10);doc.roundedRect(40,y,w,boxH,9).fill(C.soft);
 text('TOTAL QUOTATION VALUE',54,y+10,w-28,8,true,C.teal);text(money(s.totalMinor,s.currency),54,y+25,w-28,compact?19:23,true);
 const detailY=y+boxH-33;
 text('Advance required ('+s.advancePercent+'%)',54,detailY,w/2-20,8,false,C.muted);text(money(advance,s.currency),54,detailY+14,w/2-20,9,true);
 text('Remaining after advance',40+w/2,detailY,w/2-14,8,false,C.muted);text(money(s.totalMinor-advance,s.currency),40+w/2,detailY+14,w/2-14,9,true);y+=boxH+10;
 if(s.terms){section('Payment & renewal terms');paragraph(s.terms,9,false,C.muted);}
 if(s.supportContact){section('Your support contact');paragraph(s.supportContact,9);}
 if(s.footer){y+=6;paragraph(s.footer,9,false,C.teal);}
 const range=doc.bufferedPageRange();pageCount=range.count;for(let i=0;i<range.count;i++){doc.switchToPage(i);doc.page.margins.bottom=0;doc.moveTo(40,H-40).lineTo(W-40,H-40).lineWidth(.5).strokeColor(C.line).stroke();text(number(q,s)+' · Revision '+r.revision,40,H-29,w-70,8,false,C.muted,{lineBreak:false});text(`${i+1} / ${range.count}`,W-95,H-29,55,8,false,C.muted,{align:'right',lineBreak:false});}doc.end();
});}
module.exports={renderQuotationPDF};
