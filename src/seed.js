const bcrypt = require("bcryptjs");
const { pool } = require("./db");

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required seed environment variable: ${name}`);
  return value.trim();
}

async function main() {
  if (process.env.ALLOW_DEV_SEED !== "true") {
    throw new Error("Seeding is disabled. Set ALLOW_DEV_SEED=true explicitly for a controlled development seed run.");
  }

  const adminName = required("SEED_ADMIN_NAME");
  const adminPhone = required("SEED_ADMIN_PHONE");
  const adminPassword = required("SEED_ADMIN_PASSWORD");
  const salesmanName = required("SEED_SALESMAN_NAME");
  const salesmanPhone = required("SEED_SALESMAN_PHONE");
  const salesmanPassword = required("SEED_SALESMAN_PASSWORD");
  const salesmanCode = required("SEED_SALESMAN_CODE");
  const dailyTarget = Number(process.env.SEED_SALESMAN_DAILY_TARGET || "0");

  if (!Number.isInteger(dailyTarget) || dailyTarget < 0 || dailyTarget > 10000) {
    throw new Error("SEED_SALESMAN_DAILY_TARGET must be a whole number from 0 to 10000");
  }

  const adminPass = await bcrypt.hash(adminPassword, 12);
  const salesPass = await bcrypt.hash(salesmanPassword, 12);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (role, full_name, phone, password_hash)
     VALUES ('admin', $1, $2, $3)
     ON CONFLICT (phone) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`,
    [adminName, adminPhone, adminPass]
  );

  const { rows: [salesman] } = await pool.query(
    `INSERT INTO users (role, full_name, phone, password_hash)
     VALUES ('salesman', $1, $2, $3)
     ON CONFLICT (phone) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`,
    [salesmanName, salesmanPhone, salesPass]
  );

  await pool.query(
    `INSERT INTO salesman_profiles (user_id, employee_code, daily_target)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET employee_code = EXCLUDED.employee_code, daily_target = EXCLUDED.daily_target`,
    [salesman.id, salesmanCode, dailyTarget]
  );

  console.log(`Seeded admin user ${admin.id} and salesman user ${salesman.id}. Credentials were supplied through environment variables and are not printed.`);
  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
