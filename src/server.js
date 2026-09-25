const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const app = require("./app");
const db = require("./db");
const { verifyToken } = require("./utils/tokens");

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/realtime/admin", maxPayload: 16 * 1024 });
const adminSockets = new Set();

wss.on("connection", async (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get("token");
    if (!token) throw new Error("missing token");
    const payload = verifyToken(token);
    if (payload.role !== "admin" || !payload.sub) throw new Error("not admin");
    const { rows } = await db.query("SELECT id FROM users WHERE id=$1 AND role='admin' AND is_active=true", [payload.sub]);
    if (!rows.length) throw new Error("inactive admin");
    ws.userId = payload.sub;
  } catch {
    ws.close(4001, "unauthorized");
    return;
  }
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  adminSockets.add(ws);
  ws.on("close", () => adminSockets.delete(ws));
  ws.on("error", () => adminSockets.delete(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of adminSockets) {
    if (!ws.isAlive) { adminSockets.delete(ws); ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { adminSockets.delete(ws); ws.terminate(); }
  }
}, 30000);
heartbeat.unref?.();

function broadcastToAdmins(event) {
  const msg = JSON.stringify(event);
  for (const ws of adminSockets) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    // Drop realtime updates for a badly backed-up client instead of allowing
    // one browser tab to grow server memory without bound.
    if (ws.bufferedAmount > 1024 * 1024) continue;
    try { ws.send(msg); } catch { adminSockets.delete(ws); }
  }
}

app.set("broadcastToAdmins", broadcastToAdmins);

server.listen(PORT, () => {
  console.log(`Engage backend listening on :${PORT}`);
});
