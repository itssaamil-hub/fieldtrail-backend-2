import assert from 'node:assert/strict';
import express from 'express';
import {chromium} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const app=express();app.use(express.json());
const html=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src/public/broadcast.html');
app.get('/public/broadcast/view',(req,res)=>res.sendFile(html));
const deals=[{business:'North Café',employee:'Amina',status:'hot',value:'25000',month:'2026-09'},{business:'South Café',employee:'Rahul',status:'cold',value:'10000',month:'2026-10'}];
app.post('/public/broadcast/read',(req,res)=>{
 const tab=req.body.tab==='payments'?'payments':'deals',stage=req.body.status||'all';
 if(tab==='payments'&&Object.hasOwn(req.body,'month'))return res.status(400).json({error:'Payment requests must not receive a Deals month filter'});
 const rows=tab==='deals'?deals.filter(d=>(stage==='all'||d.status===stage)&&(!req.body.month||d.month===req.body.month)):[{business:'North Café',total:'30000',paid:'15000',remaining:'15000',status:'partial'}];
 const noValue=req.body.token==='no-value';
 const cols=tab==='deals'?[{key:'business',label:'Business name'},{key:'status',label:'Status'},{key:'employee',label:'Employee'},...(!noValue?[{key:'value',label:'Deal value'}]:[])]:[{key:'business',label:'Business name'},{key:'total',label:'Total'},{key:'paid',label:'Paid'},{key:'remaining',label:'Remaining'}];
 res.json({title:'Shared CRM report',sharedType:'combined',type:tab==='deals'?'leads':'payments',currency:'INR',columns:cols,rows:rows.map(row=>Object.fromEntries(cols.map(c=>[c.key,row[c.key]??null]))),
 summary:tab==='deals'?{deals:rows.length,...(!noValue?{value:String(rows.reduce((sum,r)=>sum+Number(r.value||0),0))}:{})}:{accounts:1,total:'30000',paid:'15000',remaining:'15000'},
 hasMore:false,offset:0,from:null,to:null,dateBasis:'Lead creation date',updatedAt:new Date().toISOString()});
});
const server=app.listen(0,'127.0.0.1');await new Promise(ok=>server.once('listening',ok));
let browser;
try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const url='http://127.0.0.1:'+server.address().port+'/public/broadcast/view';
 for(const width of [320,375,390,430,768,1024]){
  const page=await browser.newPage({viewport:{width,height:850},isMobile:width<700,hasTouch:width<700});
  try{
   await page.goto(url+'?mode=combined#mobile-test');
   await page.locator('#deal-summary .deal-stat').first().waitFor();
   assert.equal(await page.locator('#deal-summary .deal-stat').count(),2,'Deal count and total value at '+width);
   assert.match(await page.locator('#deal-summary').innerText(),/35,000/);
   const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
   assert.ok((await overflow())<=1,'No page overflow at '+width);
   if(width<=680){
    assert.equal(await page.locator('.deal-value-banner:visible').count(),2,'Visible mobile deal values at '+width);
    assert.equal(await page.locator('.table-wrap').isVisible(),false);
   }else{
    assert.equal(await page.locator('.table-wrap').isVisible(),true);
    assert.equal(await page.locator('.deal-value-banner:visible').count(),0);
   }
   await page.getByRole('button',{name:'Hot',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#deal-summary')?.textContent?.includes('25,000'));
   assert.equal(await page.locator('#rows tr').count(),1);
   assert.ok((await overflow())<=1,'No filter overflow at '+width);
   const month=page.getByLabel('Deal creation month');
   assert.equal(await month.isVisible(),true,'Month picker visible in Deals at '+width);
   if(width<=680){
    const statusBox=await page.locator('.status-field').boundingBox(),monthBox=await page.locator('.month-field').boundingBox();
    assert.ok(statusBox&&monthBox&&Math.abs(statusBox.y-monthBox.y)<6&&monthBox.x>statusBox.x,
      'Status and Month share the same row on '+width+'px phone');
   }
   await month.fill('2026-10');
   await page.waitForFunction(()=>document.querySelector('#deal-summary')?.textContent?.includes('Total deals'));
   await page.waitForFunction(()=>document.querySelector('#deal-summary')?.textContent?.includes('₹0'));
   assert.equal(await page.locator('#rows tr').count(),0,'Hot September deal excluded by October');
   await page.getByRole('button',{name:'Cold',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#deal-summary')?.textContent?.includes('10,000'));
   assert.equal(await page.locator('#rows tr').count(),1,'Cold October deal included');
   assert.ok((await overflow())<=1,'No selected-month horizontal overflow at '+width);
   await page.getByRole('button',{name:'Clear deal month filter'}).click();
   await page.waitForFunction(()=>document.querySelector('#deal-summary')?.textContent?.includes('10,000'));
   assert.equal(await month.inputValue(),'','Cleared means all months');
   await page.locator('[data-tab=payments]').click();
   assert.equal(await month.isVisible(),false,'Month hidden in Payments tab');
   assert.ok((await overflow())<=1,'No mobile payment overflow after month selection at '+width);
   await page.locator('#payment-summary .payment-stat').first().waitFor();
   assert.equal(await page.locator('#payment-summary .payment-stat').count(),4);
   assert.equal(await page.locator('#deal-summary').isVisible(),false);
   assert.ok((await overflow())<=1,'No payment tab overflow at '+width);
   process.stdout.write('Broadcast responsive '+width+'px OK\n');
  }finally{await page.close();}
 }
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 try{
  await page.goto(url+'#no-value');
  await page.locator('#deal-summary .deal-stat').first().waitFor();
  assert.equal(await page.locator('#deal-summary .deal-stat').count(),1,'Hidden deal values must not be disclosed');
  assert.equal(await page.locator('.deal-value-banner').count(),0);
 }finally{await page.close();}
}finally{
 if(browser)await browser.close();
 await new Promise(ok=>server.close(ok));
}
