const http = require("http");
const app = require("./app");
const db = require("./db");

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);

const realtime = require('./utils/adminRealtime').attachAdminRealtime(server, db);
app.set("broadcastToAdmins", realtime.broadcast);
app.set("revokeAdminSessions", realtime.revokeUser);

server.listen(PORT, () => {
  console.log(`Engage backend listening on :${PORT}`);
});
