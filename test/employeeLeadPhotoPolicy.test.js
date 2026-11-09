const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const router = require('../src/routes/employeeLeadPhotoPolicy.routes');
const {UUID} = require('../src/utils/leadPhotos');

const EMPLOYEE_ID='3f7ff2a6-5b2c-4d6f-a741-92b6a841dd99';
const ADMIN_ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function getHandler(method) {
 const route=router.stack.find(x=>x.route?.path==='/employees/:id/photo-policy' && x.route.methods[method.toLowerCase()]);
 assert.ok(route,'Photo policy '+method+' route must exist');
 return route.route.stack.at(-1).handle;
}
function response() {
 return {body:null,headers:{},set(name,value){ if(typeof name==='object')Object.assign(this.headers,name); else this.headers[name]=value; return this;},json(data){this.body=data;return this;}};
}
test('Photo policy GET accepts real 36-character employee UUID and reads the correct owner',async()=>{
 assert.equal(UUID.test(EMPLOYEE_ID),true);
 assert.equal(UUID.test(ADMIN_ID),true);
 assert.equal(UUID.test('not-a-uuid'),false);
 const previous=db.query;
 const queries=[];
 db.query=async(sql,params)=>{
  queries.push({sql,params});
  assert.match(sql,/FROM salesman_profiles/);
  assert.deepEqual(params,[EMPLOYEE_ID]);
  return {rows:[{require_lead_photo:false}]};
 };
 const res=response();
 try {
  await getHandler('GET')({params:{id:EMPLOYEE_ID},user:{id:ADMIN_ID,role:'admin'}},res);
  assert.deepEqual(res.body,{required:false});
  assert.equal(res.headers['Cache-Control'],'no-store');
  assert.equal(queries.length,1);
 } finally {db.query=previous;}
});
test('Photo policy GET rejects invalid IDs without touching the database',async()=>{
 const previous=db.query;let queries=0;
 db.query=async()=>{queries++;throw Error('Query must not run');};
 try {
  await assert.rejects(getHandler('GET')({params:{id:'invalid-id'},user:{id:ADMIN_ID}},response()),error=>error.status===400 && error.message==='Invalid employee');
  assert.equal(queries,0);
 } finally {db.query=previous;}
});
test('Photo policy PUT accepts valid employee UUID and saves ON with an audit record',async()=>{
 const previous=db.pool.connect;
 const executed=[];
 const fakeConnection={
  async query(sql,args=[]){
   executed.push({sql,args});
   if(sql.includes('SELECT sp.require_lead_photo'))return {rows:[{require_lead_photo:false}]};
   return {rows:[]};
  },
  release(){executed.push({sql:'RELEASE'});}
 };
 db.pool.connect=async()=>fakeConnection;
 const res=response();
 try {
  await getHandler('PUT')({params:{id:EMPLOYEE_ID},user:{id:ADMIN_ID,role:'admin'},body:{required:true}},res);
  assert.deepEqual(res.body,{required:true});
  assert.equal(executed.some(x=>x.sql.includes('UPDATE salesman_profiles SET require_lead_photo=$2')&&x.args[0]===EMPLOYEE_ID&&x.args[1]===true),true);
  assert.equal(executed.some(x=>x.sql.includes('INSERT INTO activity_logs')),true);
  assert.equal(executed.some(x=>x.sql==='COMMIT'),true);
 } finally {db.pool.connect=previous;}
});
