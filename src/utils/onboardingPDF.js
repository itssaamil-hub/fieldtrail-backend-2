const PDFDocument=require('pdfkit');
const path=require('path');
const {formatDate}=require('./onboarding');
function renderOnboardingPDF(summary){
 return new Promise((resolve,reject)=>{
 const displayName=summary.onboardingName||'Swirl Onboarding';
 const doc=new PDFDocument({size:'A4',margin:36,bufferPages:true,info:{Title:`${summary.businessName} - Onboarding checklist`,Author:'Swirl'}}),chunks=[];
 doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
 doc.registerFont('regular',path.join(__dirname,'../assets/DejaVuSans.ttf'));
 doc.registerFont('bold',path.join(__dirname,'../assets/DejaVuSans-Bold.ttf'));
 const W=doc.page.width,H=doc.page.height,x=36,w=W-72,bottom=H-48;
 const C={teal:'#145456',ink:'#253135',muted:'#66777c',line:'#e2e9e8',soft:'#e7f4ec',green:'#267451',bg:'#f5f7f7'};
 let y;
 function page(){doc.rect(0,0,W,H).fill(C.bg);doc.rect(0,0,W,68).fill(C.teal);doc.roundedRect(x,20,28,28,7).fill('#b77043');for(const a of [0,1])for(const b of [0,1])doc.circle(x+9+a*10,29+b*10,2).fill('#fff');doc.font('bold').fontSize(21).fillColor('#fff').text(displayName,x+40,20,{width:w-40,lineBreak:false});doc.font('regular').fontSize(9).text('Customer onboarding',x+40,46,{lineBreak:false});y=88;}
 function next(){doc.addPage();page();}
 function ensure(h){if(y+h>bottom)next();}
 function height(text,size,width=w,font='regular'){return doc.font(font).fontSize(size).heightOfString(text,{width,lineGap:2});}
 function paragraph(text,size=10,color=C.ink,font='regular',gap=8){
 for(const p of String(text).split('\n')){if(!p){y+=5;continue;}let remaining=p;while(remaining){ensure(size*2);let piece=remaining;const available=bottom-y; if(height(piece,size,w,font)>available){const words=remaining.split(' ');let count=1;while(count<words.length&&height(words.slice(0,count+1).join(' '),size,w,font)<=available)count++;piece=words.slice(0,count).join(' ');if(height(piece,size,w,font)>available){next();continue;}}const h=height(piece,size,w,font);doc.font(font).fontSize(size).fillColor(color).text(piece,x,y,{width:w,lineGap:2});y+=h;remaining=remaining.slice(piece.length).trimStart();if(remaining)next();}y+=gap;}
 }
 page();paragraph('Customer onboarding',20,C.ink,'bold',3);paragraph('Setup completion summary',9,C.muted,'regular',12);
 const name=String(summary.businessName).slice(0,500);const nameH=height(name,15,w-145,'bold');const assigned=summary.assigneeName?`Assigned to ${summary.assigneeName} · Swirl`:'Swirl onboarding team';const assignedH=height(assigned,9,w-36);const heroH=24+nameH+assignedH+48;ensure(heroH+12);
 doc.roundedRect(x,y,w,heroH,12).fillAndStroke('#fff',C.line);
 doc.font('bold').fontSize(15).fillColor(C.ink).text(name,x+16,y+14,{width:w-145,lineGap:2});
 doc.roundedRect(x+w-105,y+15,89,22,11).fill(C.soft);doc.font('bold').fontSize(8.5).fillColor(C.green).text('Completed',x+w-101,y+21,{width:81,align:'center',lineBreak:false});
 doc.font('regular').fontSize(9).fillColor(C.muted).text(assigned,x+16,y+18+nameH,{width:w-36,lineGap:2});
 const trackY=y+24+nameH+assignedH;doc.roundedRect(x+16,trackY,w-32,6,3).fill(C.green);
 doc.font('regular').fontSize(9).fillColor(C.muted).text(`${summary.steps.length} of ${summary.steps.length} completed`,x+16,trackY+13,{lineBreak:false});y+=heroH+16;
 paragraph(summary.title,12,C.teal,'bold',5);paragraph(summary.intro,9.5,C.ink,'regular',9);
 for(const step of summary.steps){const titleH=height(step.title,10,w-64,'bold');const h=Math.max(40,titleH+24);ensure(h+6);doc.roundedRect(x,y,w,h,8).fill('#fff');doc.circle(x+18,y+17,7).fill(C.soft);doc.save().strokeColor(C.green).lineWidth(1.4).moveTo(x+14.5,y+17).lineTo(x+17,y+19.5).lineTo(x+22,y+14).stroke().restore();doc.font('bold').fontSize(10).fillColor(C.ink).text(step.title,x+34,y+8,{width:w-64,lineGap:2});doc.font('regular').fontSize(8).fillColor(C.muted).text(`Completed ${formatDate(step.completedAt)}`,x+34,y+11+titleH,{width:w-64});y+=h+5;}
 y+=9;paragraph(summary.closing,9.5,C.ink,'regular',4);
 const range=doc.bufferedPageRange();for(let i=range.start;i<range.start+range.count;i++){doc.switchToPage(i);doc.moveTo(x,H-32).lineTo(W-x,H-32).lineWidth(.5).strokeColor(C.line).stroke();doc.font('regular').fontSize(8).fillColor(C.muted).text(displayName,x,H-25,{lineBreak:false});doc.text(`${i+1} / ${range.count}`,W-75,H-25,{lineBreak:false});}
 doc.end();
 });
}
module.exports={renderOnboardingPDF};
