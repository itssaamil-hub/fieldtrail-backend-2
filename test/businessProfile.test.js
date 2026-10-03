const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.routes.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations', '101_business_profile.sql'), 'utf8');

test('business profile uses a singleton canonical workspace record', () => {
  assert.match(migration, /id SMALLINT PRIMARY KEY DEFAULT 1 CHECK \(id = 1\)/);
  assert.match(migration, /business_name VARCHAR\(160\) NOT NULL DEFAULT ''/);
  assert.match(migration, /ON CONFLICT \(id\) DO NOTHING/);
});

test('business name is returned with authenticated account identity', () => {
  assert.match(route, /async function getBusinessProfile\(\)/);
  assert.match(route, /SELECT business_name, updated_at FROM business_profile WHERE id = 1/);
  assert.match(route, /const business = await getBusinessProfile\(\);/);
  assert.match(route, /business_name: business\.business_name/);
  assert.match(route, /router\.get\("\/business-profile", requireAuth/);
});

test('only admins can update canonical business identity', () => {
  assert.match(route, /router\.patch\("\/business-profile", requireAuth, requireRole\("admin"\)/);
  assert.match(route, /replace\(\/\\s\+\/g, " "\)\.trim\(\)/);
  assert.match(route, /Business name must be between 2 and 160 characters/);
  assert.match(route, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(route, /updated_by = EXCLUDED\.updated_by/);
  assert.match(route, /business\.profile_updated/);
});
