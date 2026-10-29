const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
require('express-async-errors');
const { PGlite } = require('@electric-sql/pglite');
const bcrypt = require('bcryptjs');
const dbModule = require('../src/db');
const { signToken } = require('../src/utils/tokens');
const { requireAuth } = require('../src/middleware/auth');
const { isPhoneBrowser, isDeviceAllowed } = require('../src/utils/deviceAccess');
const authRoutes = require('../src/routes/auth.routes');
const adminRoutes = require('../src/routes/employeeDeviceAccessAdmin.routes');

const ADMIN = '11111111-1111-4111-8111-111111111111';
const ONE = '22222222-2222-4222-8222-222222222222';
const TWO = '33333333-3333-4333-8333-333333333333';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const TABLET = 'Mozilla/5.0 (Linux; Android 14; Pixel C) AppleWebKit/537.36 Chrome/126 Safari/537.36';

test('phone classification blocks normal desktop/tablet browsers but supports Android and iPhone', () => {
  for (const ua of [PHONE, IPHONE]) assert.equal(isPhoneBrowser({ headers: { 'user-agent': ua } }), true);
  for (const ua of [DESKTOP, TABLET, 'Mozilla/5.0 (iPad; CPU OS 16_1 like Mac OS X)']) {
    assert.equal(isPhoneBrowser({ headers: { 'user-agent': ua } }), false);
  }
  assert.equal(isDeviceAllowed('admin', 'mobile_only', {headers:{'user-agent':DESKTOP}}), true);
  assert.equal(isDeviceAllowed('salesman', 'both', {headers:{'user-agent':DESKTOP}}), true);
  assert.equal(isDeviceAllowed('salesman', 'mobile_only', {headers:{'user-agent':DESKTOP}}), false);
  assert.equal(isDeviceAllowed('salesman', 'mobile_only', {headers:{'user-agent':PHONE}}), true);
});

test('per-salesman policy persists, rejects stale writes, blocks desktop sessions and login without touching other users', async t => {
  const database = new PGlite();
  t.after(() => database.close());
  const oldDbQuery = dbModule.query;
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'device-policy-test-only-secret-long-enough';
  dbModule.query = database.query.bind(database);
  t.after(() => {
    dbModule.query = oldDbQuery;
    if (oldSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  });

  await database.exec(`CREATE TABLE users (
    id uuid PRIMARY KEY, role text NOT NULL, full_name text, phone text, password_hash text,
    is_active boolean NOT NULL DEFAULT true, auth_version integer NOT NULL DEFAULT 0
  );
  CREATE TABLE activity_logs (
    actor_id uuid, action text, entity_type text, entity_id uuid, metadata jsonb
  );
  CREATE TABLE business_profile (id integer PRIMARY KEY, business_name text, updated_at timestamptz DEFAULT now());
  INSERT INTO business_profile(id,business_name) VALUES(1,'Test business');`);
  const script = fs.readFileSync(path.join(__dirname, '../src/migrations/121_employee_device_access_policy.sql'), 'utf8');
  await database.exec(script);
  await database.exec(script); // Migration can be replayed safely.
  const hash = await bcrypt.hash('Password123!', 6);
  for (const [id,role,phone] of [[ADMIN,'admin','9999999991'],[ONE,'salesman','9999999992'],[TWO,'salesman','9999999993']]) {
    await database.query('INSERT INTO users (id, role, full_name, phone, password_hash) VALUES ($1,$2,$3,$4,$5)',[id,role,'Test user',phone,hash]);
  }
  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use('/admin', adminRoutes);
  app.get('/private', requireAuth, (req,res)=>res.json({id:req.user.id,role:req.user.role}));
  app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.message}));
  const server = app.listen(0,'127.0.0.1');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const adminToken = signToken({id:ADMIN,role:'admin',full_name:'Admin',auth_version:0});
  const oneToken = signToken({id:ONE,role:'salesman',full_name:'One',auth_version:0});
  const twoToken = signToken({id:TWO,role:'salesman',full_name:'Two',auth_version:0});
  const call = async (p,token,ua,method='GET',body) => {
    const res=await fetch(base+p,{method,headers:{Authorization:'Bearer '+token,'User-Agent':ua,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});
    return {status:res.status,data:await res.json()};
  };
  const login = async (ua,phone) => {
    const res=await fetch(base+'/auth/login',{method:'POST',headers:{'User-Agent':ua,'Content-Type':'application/json'},body:JSON.stringify({phone,password:'Password123!'})});
    return {status:res.status,data:await res.json()};
  };

  assert.deepEqual((await call('/admin/employees/'+ONE+'/device-policy',adminToken,DESKTOP)).data,{policy:'both',version:0});
  assert.equal((await call('/private',oneToken,DESKTOP)).status,200);
  assert.equal((await login(DESKTOP,'9999999992')).status,200);
  assert.equal((await call('/admin/employees/'+ONE+'/device-policy',oneToken,PHONE)).status,403);
  assert.equal((await call('/admin/employees/'+ONE+'/device-policy',adminToken,DESKTOP,'PUT',{policy:'both'})).status,400);
  let updated=await call('/admin/employees/'+ONE+'/device-policy',adminToken,DESKTOP,'PUT',{policy:'mobile_only',version:0});
  assert.equal(updated.status,200);
  assert.deepEqual(updated.data,{policy:'mobile_only',version:1});
  assert.equal((await call('/private',oneToken,DESKTOP)).status,401); // Old sessions are revoked.
  assert.equal((await call('/private',oneToken,PHONE)).status,401);
  assert.equal((await call('/private',oneToken,IPHONE)).status,401);
  assert.equal((await call('/private',oneToken,TABLET)).status,401);
  const mobileSession = await login(PHONE,'9999999992');
  assert.equal(mobileSession.status,200);
  const newToken = mobileSession.data.token;
  assert.equal((await call('/private',newToken,PHONE)).status,200);
  assert.equal((await call('/private',newToken,IPHONE)).status,200);
  assert.equal((await call('/private',newToken,DESKTOP)).status,403);
  assert.equal((await call('/private',newToken,TABLET)).status,403);
  assert.equal((await login(DESKTOP,'9999999992')).status,403);
  assert.equal((await login(PHONE,'9999999992')).status,200);
  assert.equal((await call('/private',twoToken,DESKTOP)).status,200); // Other employee untouched.
  assert.equal((await call('/private',adminToken,DESKTOP)).status,200); // Admin untouched.
  assert.equal((await call('/admin/employees/'+ONE+'/device-policy',adminToken,DESKTOP,'PUT',{policy:'both',version:0})).status,409);
  assert.equal((await call('/admin/employees/'+ONE+'/device-policy',adminToken,DESKTOP,'PUT',{policy:'invalid',version:1})).status,400);
  updated=await call('/admin/employees/'+ONE+'/device-policy',adminToken,DESKTOP,'PUT',{policy:'both',version:1});
  assert.equal(updated.status,200);
  assert.equal((await call('/private',newToken,DESKTOP)).status,401);
  const restored = await login(DESKTOP,'9999999992');
  assert.equal(restored.status,200);
  assert.equal((await call('/private',restored.data.token,DESKTOP)).status,200);
  assert.equal((await call('/admin/employees/'+ADMIN+'/device-policy',adminToken,DESKTOP)).status,404);
  const logs=await database.query("SELECT action,entity_id,metadata FROM activity_logs WHERE action='employee.device_access_updated'");
  assert.equal(logs.rows.length,2);
  assert.equal(logs.rows[0].entity_id,ONE);
});
