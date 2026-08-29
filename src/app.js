require("dotenv").config();
const express = require("express");
const cors = require("cors");
require("express-async-errors"); // lets async route handlers throw straight into the error middleware below

const authRoutes = require("./routes/auth.routes");
const salesmanRoutes = require("./routes/salesman.routes");
const adminRoutes = require("./routes/admin.routes");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/salesman", salesmanRoutes);
app.use("/admin", adminRoutes);

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
