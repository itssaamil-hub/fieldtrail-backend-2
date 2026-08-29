const http = require("http");
const { WebSocketServer } = require("ws");
const app = require("./app");
const { verifyToken } = require("./utils/tokens");

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);

// Minimal live-location broadcast: any authenticated admin connecting to
// /realtime/admin gets pushed a message whenever a salesman pings a new
// location. This is intentionally simple (no rooms/backpressure handling) —
// swap for a proper pub/sub (Redis) layer once you have more than a
// handful of concurrent admins.
const wss = new WebSocketServer({ server, path: "/realtime/admin" });
const adminSockets = new Set();

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const payload = verifyToken(token);
    if (payload.role !== "admin") throw new Error("not admin");
  } catch {
    ws.close(4001, "unauthorized");
    return;
  }
  adminSockets.add(ws);
  ws.on("close", () => adminSockets.delete(ws));
});

function broadcastToAdmins(event) {
  const msg = JSON.stringify(event);
  for (const ws of adminSockets) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// Exposed so route handlers could call it after inserting a location ping —
// wire this into salesman.routes.js's /location/ping handler in production
// (kept decoupled here to keep the routes module testable without a live
// HTTP server).
app.set("broadcastToAdmins", broadcastToAdmins);

server.listen(PORT, () => {
  console.log(`FieldTrail backend listening on :${PORT}`);
});
