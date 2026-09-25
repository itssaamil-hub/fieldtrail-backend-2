require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
require("express-async-errors");

const db = require("./db");
const authRoutes = require("./routes/auth.routes");
const salesmanRoutes = require("./routes/salesman.routes");
const adminRoutes = require("./routes/admin.routes");
const notificationsRoutes = require("./routes/notifications.routes");

const app = express();
app.set("trust proxy", 1);

const allowedOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",").map(v => v.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(Object.assign(new Error("Origin not allowed"), { status: 403 }));
  },
  credentials: false,
}));
app.use(express.json({ limit: "5mb", strict: true }));
app.use((req,res,next)=>{
  const requestId = String(req.headers["x-request-id"] || crypto.randomUUID()).slice(0,128);
  req.requestId = requestId;
  res.set({
    "X-Request-Id": requestId,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  next();
});

app.get("/health", (req, res) => res.json({ ok: true, requestId:req.requestId }));
app.get("/ready", async (req,res)=>{
  await db.query("SELECT 1");
  res.json({ok:true,database:true,requestId:req.requestId});
});

app.use("/auth", authRoutes);
app.use("/salesman/my-performance", require("./routes/salesmanPerformanceV2.routes"));
// Exact write routes go first. Read routes and untouched flows continue through
// the existing salesman router with the same URLs and response shapes.
app.use("/salesman", require("./routes/salesmanSafeWrites.routes"));
app.use("/salesman", salesmanRoutes);
app.use("/admin/expenses", require("./routes/expenseEdits.routes"));
app.use("/admin/reports/performance-v2", require("./routes/performanceV2.routes"));
app.use("/admin/reports/performance-insights", require("./routes/performanceInsightsCompat.routes"));
app.use("/admin/reports/performance", require("./routes/performanceLegacyCompat.routes"));
app.use("/admin/data-health", require("./routes/dataHealth.routes"));
// Exact admin lead write routes are mounted before the monolithic admin router
// so concurrent edits/status changes are serialized without changing the UI/API.
app.use("/admin", require("./routes/adminLeadSafeWrites.routes"));
app.use("/admin", adminRoutes);
app.use("/admin/dashboard-comparisons", require("./routes/dashboardComparisons.routes"));
// Exact cron endpoints are mounted before the general notification router so
// scheduler retries are idempotent while the rest of the notification API is unchanged.
app.use("/notifications", require("./routes/cronSafe.routes"));
app.use("/notifications", notificationsRoutes);
app.use("/tasks", require("./routes/tasks.routes"));
app.use("/onboarding", require("./routes/onboarding.routes"));
app.use("/day-closing", require("./routes/dayClosing.routes"));
app.use("/collections", require("./routes/collections.routes"));
app.use("/quotations", require("./routes/quotations.routes"));
app.use("/exceptions", require("./routes/exceptions.routes"));

app.use((req,res)=>res.status(404).json({error:"Route not found",requestId:req.requestId}));

app.use((err, req, res, next) => {
  const requestId = req.requestId || null;
  const safePath = String(req.originalUrl || req.url || '').split('?')[0];
  console.error("request failed", { requestId, method:req.method, path:safePath, code:err.code, status:err.status, message:err.message });

  if (err.message && err.message.includes("immutable")) {
    return res.status(400).json({ error: "Lead location/verification fields cannot be edited.", requestId });
  }
  if (err.status && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) {
    return res.status(err.status).json({ error: err.message || "Request failed", requestId });
  }
  if (err.code === "23505") return res.status(409).json({ error: "This record already exists.", requestId });
  if (err.code === "23503") return res.status(409).json({ error: "This record is still in use and cannot be changed yet.", requestId });
  if (err.code === "23514" || err.code === "22P02") return res.status(400).json({ error: "Invalid data supplied.", requestId });
  if (err.code === "57014") return res.status(503).json({ error: "The request took too long. Please try again.", requestId });
  res.status(500).json({ error: "Internal server error", requestId });
});

module.exports = app;
