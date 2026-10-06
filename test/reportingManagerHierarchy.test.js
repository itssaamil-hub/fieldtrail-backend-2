const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const migration = fs.readFileSync(path.join(__dirname, '../src/migrations/114_reporting_manager_hierarchy.sql'), 'utf8');

test('reporting manager migration adds hierarchy fields and prevents self-reporting', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE users(id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE salesman_profiles(
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
    );
    INSERT INTO users(id) VALUES
      ('11111111-1111-4111-8111-111111111111'),
      ('22222222-2222-4222-8222-222222222222');
    INSERT INTO salesman_profiles(user_id) VALUES
      ('11111111-1111-4111-8111-111111111111'),
      ('22222222-2222-4222-8222-222222222222');
  `);

  await db.exec(migration);
  await db.query(`
    UPDATE salesman_profiles
    SET is_reporting_manager=true, region='Uttar Pradesh'
    WHERE user_id='11111111-1111-4111-8111-111111111111'
  `);
  await db.query(`
    UPDATE salesman_profiles
    SET reporting_manager_id='11111111-1111-4111-8111-111111111111', region='Uttar Pradesh'
    WHERE user_id='22222222-2222-4222-8222-222222222222'
  `);

  const { rows } = await db.query(`
    SELECT region, is_reporting_manager, reporting_manager_id
    FROM salesman_profiles
    WHERE user_id='22222222-2222-4222-8222-222222222222'
  `);
  assert.equal(rows[0].region, 'Uttar Pradesh');
  assert.equal(rows[0].is_reporting_manager, false);
  assert.equal(rows[0].reporting_manager_id, '11111111-1111-4111-8111-111111111111');

  await assert.rejects(
    db.query(`
      UPDATE salesman_profiles
      SET reporting_manager_id='22222222-2222-4222-8222-222222222222'
      WHERE user_id='22222222-2222-4222-8222-222222222222'
    `),
    { code: '23514' }
  );

  await db.exec(migration);
});
