const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

async function main() {
  // Skip if the schema is already in place — makes this safe to run on
  // every deploy/restart instead of crashing on "already exists" errors.
  const check = await pool.query(
    `SELECT 1 FROM pg_type WHERE typname = 'user_role'`
  );
  if (check.rows.length > 0) {
    console.log("Schema already exists, skipping migration.");
    await pool.end();
    return;
  }

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
