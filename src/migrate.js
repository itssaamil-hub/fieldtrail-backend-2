const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

async function main() {
  const sqlPath = path.join(__dirname, "migrations", "001_init.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  console.log("Running migration: 001_init.sql");
  await pool.query(sql);
  console.log("Done.");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
