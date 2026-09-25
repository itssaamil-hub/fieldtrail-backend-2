const { Pool } = require("pg");
require("dotenv").config();

const positiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: positiveInt(process.env.DB_POOL_MAX, 10),
  idleTimeoutMillis: positiveInt(process.env.DB_IDLE_TIMEOUT_MS, 30000),
  connectionTimeoutMillis: positiveInt(process.env.DB_CONNECT_TIMEOUT_MS, 10000),
  // Long enough for startup migrations/index creation, while still preventing
  // a genuinely stuck statement from holding a connection indefinitely.
  statement_timeout: positiveInt(process.env.DB_STATEMENT_TIMEOUT_MS, 120000),
  query_timeout: positiveInt(process.env.DB_QUERY_TIMEOUT_MS, 125000),
  application_name: "engage-backend",
});

pool.on("error", (err) => {
  console.error("Unexpected Postgres error on idle client", err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
