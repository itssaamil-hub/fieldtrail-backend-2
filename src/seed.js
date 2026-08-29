const bcrypt = require("bcryptjs");
const { pool } = require("./db");

async function main() {
  const adminPass = await bcrypt.hash("admin123", 10);
  const salesPass = await bcrypt.hash("sales123", 10);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (role, full_name, phone, password_hash)
     VALUES ('admin', 'Aamil', '9000000001', $1)
     ON CONFLICT (phone) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`,
    [adminPass]
  );

  const { rows: [rahul] } = await pool.query(
    `INSERT INTO users (role, full_name, phone, password_hash)
     VALUES ('salesman', 'Rahul Verma', '9000000002', $1)
     ON CONFLICT (phone) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`,
    [salesPass]
  );
  await pool.query(
    `INSERT INTO salesman_profiles (user_id, employee_code, daily_target)
     VALUES ($1, 'EMP-001', 8) ON CONFLICT (user_id) DO NOTHING`,
    [rahul.id]
  );

  console.log("Seeded:");
  console.log("  admin   -> phone 9000000001 / password admin123");
  console.log("  salesman-> phone 9000000002 / password sales123");
  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
