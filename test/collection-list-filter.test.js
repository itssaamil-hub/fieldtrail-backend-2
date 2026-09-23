const {test}=require('node:test'),assert=require('node:assert/strict');
test('employee due list is filtered before pagination; admin status is validated',async()=>{
 process.env.JWT_SECRET='collection-list-test';const db=require('../src/db'),original=db.query;let args,sqlSeen;
 db.query=async(sql,p)=>{if(sql.startsWith('SELECT id FROM users'))return{rows:[{id:p[0]}]};sqlSeen=sql;args=p;return{rows:[{accounts:[],summary:{collected:0,pending:0,overdue:0},employees:[]}]}};
 const express=require('express');require('express-async-errors');const {signToken}=require('../src/utils/tokens');const app=express();app.use('/collections',require('../src/routes/collections.routes'));app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const id='11111111-1111-4111-8111-111111111111';const call=(role,status)=>fetch(`http://127.0.0.1:${server.address().port}/collections?status=${status}&offset=50`,{headers:{Authorization:'Bearer '+signToken({id,role})}});
 try{let res=await call('salesman','all');assert.equal(res.status,200);assert.equal(args[1],id);assert.equal(args[6],'pending');assert.match(sqlSeen,/FROM totals WHERE .*pending>0.*LIMIT 51 OFFSET \$6/);assert.deepEqual((await res.json()).employees,[]);
 res=await call('salesman','paid');assert.equal(res.status,200);assert.equal(args[6],'pending');
 for(const status of ['all','pending','overdue','paid']){res=await call('admin',status);assert.equal(res.status,200);assert.equal(args[6],status);assert.equal(args[1],null)}
 res=await call('admin','invalid');assert.equal(res.status,400);
 }finally{db.query=original;await new Promise(r=>server.close(r));}
});
