# FieldTrail backend

Real Express + PostgreSQL/PostGIS backend for the Salesman Lead Tracking &
Live Location app. Matches the schema and API surface from the architecture
doc.

## 1. Requirements

- Node.js 18+
- A Postgres database with the **PostGIS** extension available. Easiest
  managed options: [Supabase](https://supabase.com) (free tier, PostGIS
  pre-installed, one click), [Neon](https://neon.tech), or Render/Railway
  Postgres. Self-hosted works too (`postgis/postgis` Docker image).

## 2. Setup

```bash
cd backend
npm install
cp .env.example .env
# edit .env: paste your DATABASE_URL and a random JWT_SECRET
npm run migrate     # creates all tables, types, triggers, indexes
npm run seed        # creates one admin + one salesman test login
npm run dev          # starts on http://localhost:4000
```

Test credentials after seeding:
- Admin: phone `9000000001` / password `admin123`
- Salesman: phone `9000000002` / password `sales123`

## 3. Quick smoke test

```bash
# log in as admin
curl -X POST localhost:4000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"9000000001","password":"admin123"}'

# use the returned token
curl localhost:4000/admin/dashboard/summary \
  -H "Authorization: Bearer <token>"
```

## 4. What's implemented

- JWT auth, role-scoped middleware (`requireAuth`, `requireRole`)
- Salesman: day start/end, location pings, lead creation (idempotent on a
  device-generated `client_uuid` — safe to retry after an offline gap),
  lead status updates (own leads only), visit start/end
- Admin: dashboard summary, salesman roster + live position, salesman route
  history, lead list with filters, lead status changes, CSV export,
  performance rollup, notifications feed
- DB-level trigger that makes a lead's GPS/verification fields **immutable**
  after creation — even a compromised app-server code path can't quietly
  edit them, only Postgres superuser access could
- Verification logic (`utils/verification.js`): flags poor accuracy, mock-GPS
  suspicion (pass `isMockSuspected` from the device's
  `Location.isFromMockProvider()` check on Android), and implausible
  speed jumps between consecutive readings
- A bare-bones WebSocket channel (`/realtime/admin`) for live-map pushes —
  functional but minimal; swap for Redis pub/sub if you need it to scale
  past a few concurrent admin dashboards

## 5. What's intentionally left for you to fill in

- **Photo uploads** — routes accept a `photoUrl` string; wire up actual
  upload-to-S3 (or Supabase Storage) and pass the resulting URL in
  from your mobile client.
- **Reverse geocoding** — `reverseGeocodedAddress` is accepted as a field;
  call Google's Geocoding API or Mapbox from the mobile client (or a small
  server-side proxy) and pass the result in.
- **The actual mobile app** — this is the API it should talk to. React
  Native/Expo is the realistic path for background GPS + offline SQLite
  queue on Android, per the architecture doc.
- **Push notifications** — the `notifications` table is populated; wiring
  it to FCM/Expo push is a separate, fairly mechanical step.
- **Rate limiting / brute-force protection on `/auth/login`** — add
  `express-rate-limit` before going to production.

## 6. Directory layout

```
backend/
  src/
    migrations/001_init.sql   -- full schema
    db.js                       -- pg pool
    migrate.js, seed.js
    utils/                      -- geo math, verification logic, JWT, audit log
    middleware/auth.js
    routes/
      auth.routes.js
      salesman.routes.js
      admin.routes.js
    app.js, server.js
```
