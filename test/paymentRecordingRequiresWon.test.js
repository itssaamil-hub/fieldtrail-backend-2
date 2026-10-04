const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('record payment requires the linked Deal to be Won',()=>{
 const src=read('src/routes/collectionLifecycle.routes.js');
 assert.match(src,/async function guardWonPayment/);
 assert.match(src,/if\(!a\.lead_id\)throw bad\('Move the linked Deal to Won before recording payment\.',409\)/);
 assert.match(src,/SELECT status FROM leads WHERE id=\$1/);
 assert.match(src,/rows\[0\]\.status!==\'won\'/);
 assert.match(src,/router\.post\('\/:key\/payments',guardActive\)/);
 assert.match(src,/router\.post\('\/:key\/payments',guardWonPayment\)/);
});

test('Won guard is scoped only to new payment recording',()=>{
 const src=read('src/routes/collectionLifecycle.routes.js');
 assert.match(src,/router\.put\('\/:key\/due-date',guardActive\)/);
 assert.match(src,/router\.patch\('\/:key\/payments\/:id',guardActive\)/);
 assert.match(src,/router\.delete\('\/:key\/payments\/:id',guardActive\)/);
});
