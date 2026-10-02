const {test}=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http'),{once}=require('node:events'),{WebSocket}=require('ws');
process.env.JWT_SECRET='realtime-revocation-test';
const {signToken}=require('../src/utils/tokens'),{attachAdminRealtime}=require('../src/utils/adminRealtime');
test('realtime checks token version, active status, existing connections and immediate revocation',async()=>{
 const id='11111111-1111-4111-8111-111111111111';let version=1,active=true;
 const db={query:async(sql,args)=>{assert.match(sql,/auth_version=\$2/);return{rows:active&&args[1]===version?[{id}]:[]};}};
 const server=http.createServer(),realtime=attachAdminRealtime(server,db,{heartbeatMs:30});server.listen(0,'127.0.0.1');await once(server,'listening');
 const clients=[],token=v=>signToken({id,role:'admin',auth_version:v});
 const connect=async(t)=>{const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/realtime/admin?token=${encodeURIComponent(t)}`);clients.push(ws);await once(ws,'open');return ws;};
 try{
  let ws=await connect(token(0));assert.equal((await once(ws,'close'))[0],4001);
  ws=await connect(token(1));await new Promise(r=>setTimeout(r,10));const msg=once(ws,'message');realtime.broadcast({type:'location_update'});assert.equal(JSON.parse((await msg)[0]).type,'location_update');
  const received=[];ws.on('message',data=>received.push(data));version=2;const closed=once(ws,'close');realtime.broadcast({type:'secret_after_revocation'});assert.equal((await closed)[0],4001);assert.equal(received.length,0);
  ws=await connect(token(2));await new Promise(r=>setTimeout(r,10));const immediate=once(ws,'close');realtime.revokeUser(id);assert.equal((await immediate)[0],4001);
  ws=await connect(token(2));const deactivated=once(ws,'close');active=false;assert.equal((await deactivated)[0],4001);
 }finally{for(const ws of clients)ws.terminate();realtime.close();await new Promise(r=>server.close(r));}
});
