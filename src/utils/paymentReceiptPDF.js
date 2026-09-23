const PDF=require('pdfkit'),path=require('path');const {money}=require('./quotations');
function renderReceipt(r){return new Promise((resolve,reject)=>{
 const d=new PDF({size:'A4',margin:46,bufferPages:true,info:{Title:r.number,Author:r.company}}),chunks=[];
 d.on('data',b=>chunks.push(b));d.on('end',()=>resolve(Buffer.concat(chunks)));d.on('error',reject);
 d.registerFont('regular',path.join(__dirname,'../assets/DejaVuSans.ttf'));d.registerFont('bold',path.join(__dirname,'../assets/DejaVuSans-Bold.ttf'));
 const teal='#16575b',ink='#233b3d',muted='#607574',width=503;
 function text(v,size=10,bold=false,color=ink){d.font(bold?'bold':'regular').fontSize(size).fillColor(color).text(String(v||''),46,d.y,{width,lineGap:3});d.moveDown(.5);}
 text(r.company,23,true,teal);text(r.companyContact,9,false,muted);text('PAYMENT RECEIPT',11,true,teal);text(`${r.number}  /  Version ${r.version}`,9,false,muted);
 d.moveDown();text('RECEIVED FROM',9,true,muted);text(r.customer.name,19,true);text([r.customer.contact,r.customer.phone].filter(Boolean).join(' · '),10,false,muted);
 if(r.quoteNumber)text(`${r.quoteNumber} · Revision ${r.quoteRevision}`,10,false,muted);
 d.moveDown();text(money(Math.round(r.amount*100),r.currency),28,true,teal);text('Received with thanks',10,false,muted);d.moveDown();
 for(const [label,value] of [['Payment date (IST)',r.date],['Payment method',({upi:'UPI',bank:'Bank transfer',cash:'Cash',cheque:'Cheque',card:'Card',other:'Other',unspecified:'Not recorded'})[r.method]],['Reference',r.reference||'Not provided'],['Recorded by',r.recordedBy]]){text(label,9,false,muted);text(value,11,true);}
 d.moveDown();text('Acknowledgment of recorded payment. This is not a tax invoice.',9,false,muted);text('Thank you for choosing '+r.company+'.',10,false,teal);
 const range=d.bufferedPageRange();for(let i=0;i<range.count;i++){d.switchToPage(i);d.page.margins.bottom=0;d.font('regular').fontSize(8).fillColor(muted).text(`${r.number} · ${i+1} / ${range.count}`,46,806,{width,lineBreak:false});}d.end();
});}module.exports={renderReceipt};
