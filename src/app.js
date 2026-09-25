require("dotenv").config();
const express = require("express");
const cors = require("cors");
require("express-async-errors"); // lets async route handlers throw straight into the error middleware below

const authRoutes = require("./routes/auth.routes");
const salesmanRoutes = require("./routes/salesman.routes");
const adminRoutes = require("./routes/admin.routes");
const notificationsRoutes = require("./routes/notifications.routes");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
// Exact performance route is mounted before the broader salesman router so
// both admin and salesman views share the same V2 calculation engine.
app.use("/salesman/my-performance", require("./routes/salesmanPerformanceV2.routes"));
app.use("/salesman", salesmanRoutes);
app.use("/admin/expenses", require("./routes/expenseEdits.routes"));
app.use("/admin/reports/performance-v2", require("./routes/performanceV2.routes"));
// Compatibility mounts keep existing frontend screens working while forcing
// them through the same V2 source of truth.
app.use("/admin/reports/performance-insights", require("./routes/performanceInsightsCompat.routes"));
app.use("/admin/reports/performance", require("./routes/performanceLegacyCompat.routes"));
app.use("/admin", adminRoutes);
app.use("/admin/dashboard-comparisons", require("./routes/dashboardComparisons.routes"));
app.use("/notifications", notificationsRoutes);
app.use("/tasks", require("./routes/tasks.routes"));
app.use("/onboarding", require("./routes/onboarding.routes"));
app.use("/day-closing", require("./routes/dayClosing.routes"));
app.use("/collections", require("./routes/collections.routes"));
app.use("/quotations", require("./routes/quotations.routes"));
app.use("/exceptions", require("./routes/exceptions.routes"));

// Centralised error handler — keeps DB constraint errors (like the
// lead-location-immutability trigger) from leaking stack traces to clients.
app.use((err, req, res, next) => {
  console.error(err);
  if (err.message && err.message.includes("immutable")) {
    return res.status(400).json({ error: "Lead location/verification fields cannot be edited." });
  }
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
