const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

// Runs every .sql file in migrations/ (sorted by filename) that hasn't been
// applied yet, tracked in a schema_migrations table. Each file should still
// be written defensively (IF NOT EXISTS etc.) since this is belt-and-braces,
// but this is what actually prevents re-running old migrations going forward.
async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const dir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  const { rows } = await pool.query(`SELECT filename FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.filename));

  // Bootstrap case: 001_init.sql was applied before this tracking table
  // existed. If the schema is clearly already there but untracked, record
  // it as applied instead of trying (and failing) to re-run it.
  if (applied.size === 0) {
    const check = await pool.query(`SELECT to_regclass('public.leads') AS exists`);
    if (check.rows[0].exists) {
      console.log("Detected pre-existing schema — marking 001_init.sql as already applied.");
      await pool.query(
        `INSERT INTO schema_migrations (filename) VALUES ('001_init.sql') ON CONFLICT DO NOTHING`
      );
      applied.add("001_init.sql");
    }
  }

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    console.log(`Running migration: ${file}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
      await client.query("COMMIT");
      console.log(`Applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  console.log("Done.");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
