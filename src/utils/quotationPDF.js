const PDFDocument=require('pdfkit'),path=require('path');
const {money,number}=require('./quotations');
function renderQuotationPDF(q,r){return new Promise((resolve,reject)=>{
 const s=r.snapshot,doc=new PDFDocument({size:'A4',margin:40,bufferPages:true,info:{Title:number(q,s),Author:s.company}}),chunks=[];
 doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
 doc.registerFont('regular',path.join(__dirname,'../assets/DejaVuSans.ttf'));doc.registerFont('bold',path.join(__dirname,'../assets/DejaVuSans-Bold.ttf'));
 const W=doc.page.width,H=doc.page.height,w=W-80,bottom=H-55,C={teal:'#145456',ink:'#203d3e',muted:'#627877',line:'#dce7e3',soft:'#eef6f2'};let y;
 function text(t,x,yy,width,size=10,bold=false,color=C.ink,opts={}){doc.font(bold?'bold':'regular').fontSize(size).fillColor(color).text(String(t),x,yy,{width,lineGap:2,...opts});}
 function heading(){doc.rect(0,0,W,105).fill(C.teal);let x=40;if(s.logo){doc.image(Buffer.from(s.logo.split(',')[1],'base64'),40,22,{fit:[48,48]});x=102;}text(s.company,x,22,w-(x-40),19,true,'#ffffff',{height:30,ellipsis:true});if(s.companyContact)text(s.companyContact,x,55,w-(x-40),8,false,'#dcebe7',{height:30,ellipsis:true});text('QUOTATION',40,87,140,8,true,'#dcebe7',{lineBreak:false});text(number(q,s)+'  /  REV '+r.revision,230,87,W-270,8,false,'#dcebe7',{align:'right',lineBreak:false});y=126;}
 function ensure(h){if(y+h>bottom){doc.addPage();heading();return true;}return false;}
 function paragraph(value,size=9,bold=false,color=C.ink){for(const line of String(value||'').split('\n')){if(!line){y+=4;continue;}let remain=line;while(remain){doc.font(bold?'bold':'regular').fontSize(size);let count=Math.min(remain.length,240);while(count>1&&doc.heightOfString(remain.slice(0,count),{width:w,lineGap:2})>90)count=Math.floor(count*.8);if(count<remain.length){const boundary=remain.lastIndexOf(' ',count);if(boundary>0)count=boundary;}const part=remain.slice(0,count),h=doc.heightOfString(part,{width:w,lineGap:2});ensure(h+6);text(part,40,y,w,size,bold,color);y+=h+4;remain=remain.slice(count).trimStart();}}y+=4;}
 function section(title){ensure(45);y+=8;paragraph(title,10,true,C.teal);}
 heading();paragraph('PREPARED FOR',8,true,C.muted);paragraph(s.customer.name,18,true);paragraph([s.customer.contact,s.customer.phone].filter(Boolean).join(' · '),9,false,C.muted);
 ensure(42);doc.roundedRect(40,y,w,36,6).fill('#f3f6f5');text('Issued  '+s.issuedOn,52,y+11,w/2-12,9);text('Valid until  '+s.expiresOn,40+w/2,y+11,w/2-12,9,false,C.ink,{align:'right'});y+=52;
 const amountX=W-180,periodX=310;
 function tableHead(){doc.rect(40,y,w,25).fill(C.teal);text('PACKAGE / ADD-ON',50,y+7,240,8,true,'#ffffff');text('BILLING',periodX,y+7,80,8,true,'#ffffff');text('AMOUNT',amountX,y+7,130,8,true,'#ffffff',{align:'right'});y+=25;}
 tableHead();
 function item(name,period,amount){doc.font('regular').fontSize(9);const h=Math.max(34,doc.heightOfString(name,{width:245,lineGap:2})+18);if(ensure(h+3))tableHead();text(name,50,y+9,245,9);text(period,periodX,y+9,80,8,false,C.muted);text(money(amount,s.currency),amountX,y+9,130,9,false,C.ink,{align:'right'});doc.moveTo(40,y+h).lineTo(W-40,y+h).lineWidth(.5).strokeColor(C.line).stroke();y+=h;}
 const periods={monthly:'Monthly',yearly:'Yearly',one_time:'One-time'};item(s.package.name,periods[s.package.period],Math.round(s.package.price*100));for(const a of s.addons)item(a.name,periods[a.period],Math.round(a.price*100));if(s.discountMinor)item('Package discount ('+s.discount+'%)','',-s.discountMinor);if(s.taxPercent)item('Tax ('+s.taxPercent+'%)','',s.taxMinor);y+=12;
 const advance=Math.round(s.totalMinor*s.advancePercent/100);ensure(115);doc.roundedRect(40,y,w,105,9).fill(C.soft);text('TOTAL QUOTATION VALUE',54,y+12,w-28,8,true,C.teal);text(money(s.totalMinor,s.currency),54,y+28,w-28,23,true);doc.moveTo(54,y+64).lineTo(W-54,y+64).lineWidth(.5).strokeColor('#c9dcd2').stroke();text('Advance required ('+s.advancePercent+'%)',54,y+72,w/2-20,8,false,C.muted);text(money(advance,s.currency),54,y+86,w/2-20,10,true);text('Remaining after advance',40+w/2,y+72,w/2-14,8,false,C.muted);text(money(s.totalMinor-advance,s.currency),40+w/2,y+86,w/2-14,10,true);y+=118;
 paragraph('Covers the first billing period of recurring items and all one-time charges.',8,false,C.muted);
 const features=String(s.package.features||'').split(/[\n,]+/).map(t=>t.trim()).filter(Boolean);
 if(features.length){section('Included in your package');for(const f of features)paragraph('✓  '+f,9);}
 if(s.terms){section('Payment & renewal terms');paragraph(s.terms,9,false,C.muted);}
 if(s.supportContact){section('Your support contact');paragraph(s.supportContact,9);}
 if(s.footer){y+=6;paragraph(s.footer,9,false,C.teal);}
 const range=doc.bufferedPageRange();for(let i=0;i<range.count;i++){doc.switchToPage(i);doc.page.margins.bottom=0;doc.moveTo(40,H-40).lineTo(W-40,H-40).lineWidth(.5).strokeColor(C.line).stroke();text(number(q,s)+' · Revision '+r.revision,40,H-29,w-70,8,false,C.muted,{lineBreak:false});text(`${i+1} / ${range.count}`,W-95,H-29,55,8,false,C.muted,{align:'right',lineBreak:false});}doc.end();
});}
module.exports={renderQuotationPDF};
