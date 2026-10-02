const {WebSocketServer,WebSocket}=require('ws');
const {verifyToken}=require('./tokens');
function attachAdminRealtime(server,db,{heartbeatMs=30000}={}) {
 const wss=new WebSocketServer({server,path:'/realtime/admin',maxPayload:16*1024}),sockets=new Set();
 async function authorized(token) {
  const payload=verifyToken(token);
  if(payload.role!=='admin'||!payload.sub)throw Error('Not admin');
  const version=Number.isInteger(payload.ver)?payload.ver:0;
  const {rows}=await db.query("SELECT id FROM users WHERE id=$1 AND role='admin' AND is_active=true AND auth_version=$2",[payload.sub,version]);
  if(!rows.length)throw Error('Session revoked');
  return payload;
 }
 const reject=ws=>{sockets.delete(ws);ws.close(4001,'unauthorized');};
 wss.on('connection',async(ws,req)=>{
  ws.on('error',()=>sockets.delete(ws));
  ws.on('close',()=>sockets.delete(ws));
  try {
   const token=new URL(req.url,'http://localhost').searchParams.get('token');
   if(!token)throw Error('Missing token');
   const payload=await authorized(token);if(ws.readyState!==WebSocket.OPEN)return;
   ws.token=token;ws.userId=payload.sub;ws.isAlive=true;ws.delivery=Promise.resolve();ws.pendingDeliveries=0;sockets.add(ws);
   ws.on('pong',()=>{ws.isAlive=true;});
  }catch{reject(ws);}
 });
 const heartbeat=setInterval(()=>{
  for(const ws of sockets){
   if(!ws.isAlive){sockets.delete(ws);ws.terminate();continue;}
   if(ws.checkingSession)continue;ws.checkingSession=true;
   authorized(ws.token).then(()=>{if(ws.readyState===WebSocket.OPEN){ws.isAlive=false;ws.ping();}}).catch(()=>reject(ws)).finally(()=>{ws.checkingSession=false;});
  }
 },heartbeatMs);heartbeat.unref?.();
 function broadcast(event){
  const message=JSON.stringify(event);
  for(const ws of sockets){
   if(ws.readyState!==WebSocket.OPEN||ws.bufferedAmount>1024*1024||ws.pendingDeliveries>=100)continue;
   // Revalidate before delivering data to an already-open connection.
   ws.pendingDeliveries+=1;
   ws.delivery=ws.delivery.then(()=>authorized(ws.token)).then(()=>{if(sockets.has(ws)&&ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<=1024*1024)ws.send(message);}).catch(()=>reject(ws)).finally(()=>{ws.pendingDeliveries-=1;});
  }
 }
 function revokeUser(userId){for(const ws of sockets)if(ws.userId===userId)reject(ws);}
 function close(){clearInterval(heartbeat);for(const ws of sockets)ws.terminate();sockets.clear();wss.close();}
 server.on('close',close);return{broadcast,revokeUser,close};
}
module.exports={attachAdminRealtime};
