const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { getEmployeeLocationSettings, saveEmployeeLocationSettings } = require('../src/utils/employeeLocation');

const EMPLOYEE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const migration = name => fs.readFileSync(path.join(__dirname, '../src/migrations', name), 'utf8');
const attendanceMigration = () => migration('113_employee_attendance_location_policy.sql');

async function setup(t, legacy) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE users(id uuid PRIMARY KEY, role text NOT NULL);
    CREATE TABLE crm_settings(location_settings jsonb, updated_at timestamptz NOT NULL);
    INSERT INTO users VALUES ('${EMPLOYEE}','salesman'), ('${OTHER}','salesman'), ('${ADMIN}','admin');
  `);
  if (legacy !== undefined) {
    await db.query('INSERT INTO crm_settings VALUES ($1, now())', [JSON.stringify(legacy)]);
  }
  await db.exec(migration('054_employee_location_settings.sql'));
  await db.exec(migration('055_employee_location_settings_version.sql'));
  return db;
}

test('attendance policy migration preserves all legacy Start/End combinations and GPS override', async t => {
  for (const start of [false, true]) {
    for (const end of [false, true]) {
      await t.test(`Start=${start}, End=${end}`, async t => {
        const db = await setup(t, { requireLocationToStartDay: start, requireLocationToEndDay: end });
        await db.query('UPDATE employee_location_settings SET gps_location=false WHERE user_id=$1', [OTHER]);
        await db.exec(attendanceMigration());
        const query = db.query.bind(db);
        const policy = await getEmployeeLocationSettings(EMPLOYEE, query);
        assert.equal(policy.requireLocationToStartDay, start);
        assert.equal(policy.requireLocationToEndDay, end);
        const off = await getEmployeeLocationSettings(OTHER, query);
        assert.equal(off.requireLocationToStartDay, false);
        assert.equal(off.requireLocationToEndDay, false);
        const stored = (await db.query('SELECT require_location_to_start_day AS start, require_location_to_end_day AS end FROM employee_location_settings WHERE user_id=$1', [OTHER])).rows[0];
        assert.deepEqual(stored, { start, end });
      });
    }
  }
});

test('migration handles absent legacy settings, latest values, reruns and future defaults', async t => {
  for (const legacy of [undefined, {}]) {
    await t.test(legacy === undefined ? 'no settings row' : 'missing keys', async t => {
      const db = await setup(t, legacy);
      await db.exec(attendanceMigration());
      const query = db.query.bind(db);
      let policy = await getEmployeeLocationSettings(EMPLOYEE, query);
      assert.equal(policy.requireLocationToStartDay, true);
      assert.equal(policy.requireLocationToEndDay, true);
      await saveEmployeeLocationSettings({ userId: EMPLOYEE, actorId: ADMIN, settings: { ...policy, requireLocationToStartDay: false } }, query);
      await db.exec(attendanceMigration());
      policy = await getEmployeeLocationSettings(EMPLOYEE, query);
      assert.equal(policy.requireLocationToStartDay, false);
      assert.equal(policy.requireLocationToEndDay, true);
      assert.equal(policy.version, 1);
      await db.query('DELETE FROM employee_location_settings WHERE user_id=$1', [OTHER]);
      await db.query('INSERT INTO employee_location_settings(user_id) VALUES($1)', [OTHER]);
      const future = await getEmployeeLocationSettings(OTHER, query);
      assert.equal(future.requireLocationToStartDay, true);
      assert.equal(future.requireLocationToEndDay, true);
      await assert.rejects(db.query('UPDATE employee_location_settings SET require_location_to_start_day=NULL WHERE user_id=$1', [OTHER]), { code: '23502' });
    });
  }
  await t.test('latest global row wins', async t => {
    const db = await setup(t, { requireLocationToStartDay: false, requireLocationToEndDay: true });
    await db.query('INSERT INTO crm_settings VALUES($1, now() - interval \'1 day\')', [JSON.stringify({ requireLocationToStartDay: true, requireLocationToEndDay: false })]);
    await db.exec(attendanceMigration());
    const policy = await getEmployeeLocationSettings(EMPLOYEE, db.query.bind(db));
    assert.equal(policy.requireLocationToStartDay, false);
    assert.equal(policy.requireLocationToEndDay, true);
  });
});

test('competing saves from the same version allow one winner and reject the other without overwriting', async t => {
  const db = await setup(t, {});
  await db.exec(attendanceMigration());
  const query = db.query.bind(db);
  const original = await getEmployeeLocationSettings(EMPLOYEE, query);
  const other = await getEmployeeLocationSettings(OTHER, query);
  let reads = 0;
  let release;
  const bothRead = new Promise(resolve => { release = resolve; });
  // Force both callers to read the same version before either writes. The
  // writes still execute real PostgreSQL SQL, so a read-only version check fails.
  const competingQuery = async (sql, params) => {
    const result = await query(sql, params);
    if (/^\s*SELECT gps_location/.test(sql)) {
      if (++reads === 2) release();
      await bothRead;
    }
    return result;
  };
  const drafts = [
    { ...original, requireLocationToStartDay: false },
    { ...original, requireLocationToEndDay: false },
  ];
  const results = await Promise.allSettled(drafts.map(settings => saveEmployeeLocationSettings({ userId: EMPLOYEE, actorId: ADMIN, settings }, competingQuery)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  assert.match(rejected.reason.message, /Reload before saving/);
  const saved = await getEmployeeLocationSettings(EMPLOYEE, query);
  assert.deepEqual(saved, results.find(r => r.status === 'fulfilled').value);
  assert.equal(saved.version, original.version + 1);
  assert.deepEqual(await getEmployeeLocationSettings(OTHER, query), other);
  await assert.rejects(saveEmployeeLocationSettings({ userId: EMPLOYEE, actorId: ADMIN, settings: original }, query), { status: 409 });
  const retried = await saveEmployeeLocationSettings({ userId: EMPLOYEE, actorId: ADMIN, settings: { ...saved, gpsLocation: false } }, query);
  assert.equal(retried.version, 2);
  for (const key of ['gpsLocation', 'locationMandatoryForNewLead', 'continuousGpsTracking', 'requireLocationToStartDay', 'requireLocationToEndDay']) assert.equal(retried[key], false);
});
