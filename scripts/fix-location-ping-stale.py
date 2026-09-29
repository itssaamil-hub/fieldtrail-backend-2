from pathlib import Path

# Update utility with an explicit decision object so stale retries never move
# the live-map/profile backwards while stationary current fixes still refresh it.
p = Path('src/utils/locationPings.js')
t = p.read_text()
old = '''function shouldPersistLocationPing({ previous, lat, lng, capturedAt, minDistanceM, maxGapMs }) {\n  if (!previous || previous.latitude == null || previous.longitude == null || !previous.captured_at) return true;\n\n  const currentMs = Date.parse(capturedAt);\n  const previousMs = new Date(previous.captured_at).getTime();\n  if (!Number.isFinite(currentMs) || !Number.isFinite(previousMs)) return true;\n\n  // A delayed/retried ping older than the latest persisted fix should not add\n  // an out-of-order history row. The live profile is still refreshed by the route.\n  if (currentMs <= previousMs) return false;\n  if (currentMs - previousMs >= maxGapMs) return true;\n\n  return haversineMeters(previous.latitude, previous.longitude, lat, lng) >= minDistanceM;\n}\n'''
new = '''function locationPingDecision({ previous, lat, lng, capturedAt, minDistanceM, maxGapMs }) {\n  if (!previous || previous.latitude == null || previous.longitude == null || !previous.captured_at) {\n    return { persisted: true, refreshLive: true, reason: 'first' };\n  }\n\n  const currentMs = Date.parse(capturedAt);\n  const previousMs = new Date(previous.captured_at).getTime();\n  if (!Number.isFinite(currentMs) || !Number.isFinite(previousMs)) {\n    return { persisted: true, refreshLive: true, reason: 'uncomparable' };\n  }\n\n  // Delayed/retried fixes must not append history OR move the live profile/map\n  // backwards to an older coordinate.\n  if (currentMs <= previousMs) return { persisted: false, refreshLive: false, reason: 'stale' };\n  if (currentMs - previousMs >= maxGapMs) return { persisted: true, refreshLive: true, reason: 'heartbeat' };\n\n  const moved = haversineMeters(previous.latitude, previous.longitude, lat, lng) >= minDistanceM;\n  return { persisted: moved, refreshLive: true, reason: moved ? 'moved' : 'stationary' };\n}\n\nfunction shouldPersistLocationPing(args) {\n  return locationPingDecision(args).persisted;\n}\n'''
if old not in t: raise SystemExit('utility decision block not found')
t=t.replace(old,new,1)
t=t.replace('  shouldPersistLocationPing,\n', '  locationPingDecision,\n  shouldPersistLocationPing,\n',1)
p.write_text(t)

# Update route import + behavior.
p=Path('src/routes/salesman.routes.js')
t=p.read_text()
t=t.replace('const { locationPingConfig, shouldPersistLocationPing } = require("../utils/locationPings");', 'const { locationPingConfig, locationPingDecision } = require("../utils/locationPings");',1)
old='''  const pingConfig = locationPingConfig();\n  const persisted = shouldPersistLocationPing({\n    previous: activeRows[0], lat: latNum, lng: lngNum, capturedAt,\n    minDistanceM: pingConfig.minDistanceM, maxGapMs: pingConfig.maxGapMs,\n  });\n\n  if (persisted) {'''
new='''  const pingConfig = locationPingConfig();\n  const decision = locationPingDecision({\n    previous: activeRows[0], lat: latNum, lng: lngNum, capturedAt,\n    minDistanceM: pingConfig.minDistanceM, maxGapMs: pingConfig.maxGapMs,\n  });\n  const persisted = decision.persisted;\n\n  if (persisted) {'''
if old not in t: raise SystemExit('route decision block not found')
t=t.replace(old,new,1)
old2='''  // Live presence is refreshed on every accepted ping even if the historical\n  // row was deduplicated. Admin live-map behavior therefore stays unchanged.\n  await db.query(\n    `UPDATE salesman_profiles\n     SET last_lat = $2, last_lng = $3, last_battery_pct = $4, last_speed_mps = $5, last_seen_at = now()\n     WHERE user_id = $1`,\n    [salesmanId, latNum, lngNum, batteryPct, speedMps]\n  );\n\n  const broadcast = req.app.get("broadcastToAdmins");\n  if (typeof broadcast === "function") {\n    broadcast({ type: "location_update", salesman: {\n      id: salesmanId, lat: latNum, lng: lngNum, batteryPct, speedMps, status: "online", lastSeenAt: new Date().toISOString()\n    }});\n  }\n'''
new2='''  // Current stationary fixes still refresh live presence even when their raw\n  // history row is deduplicated. Stale retries are acknowledged but ignored\n  // for live state so the map never jumps backwards.\n  if (decision.refreshLive) {\n    await db.query(\n      `UPDATE salesman_profiles\n       SET last_lat = $2, last_lng = $3, last_battery_pct = $4, last_speed_mps = $5, last_seen_at = now()\n       WHERE user_id = $1`,\n      [salesmanId, latNum, lngNum, batteryPct, speedMps]\n    );\n\n    const broadcast = req.app.get("broadcastToAdmins");\n    if (typeof broadcast === "function") {\n      broadcast({ type: "location_update", salesman: {\n        id: salesmanId, lat: latNum, lng: lngNum, batteryPct, speedMps, status: "online", lastSeenAt: new Date().toISOString()\n      }});\n    }\n  }\n'''
if old2 not in t: raise SystemExit('route live refresh block not found')
t=t.replace(old2,new2,1)
t=t.replace('  res.json({ ok: true, persisted });', '  res.json({ ok: true, persisted, stale: decision.reason === "stale" });',1)
p.write_text(t)

# Extend focused test.
p=Path('test/locationPings.test.js')
t=p.read_text()
t=t.replace("  shouldPersistLocationPing,\n", "  locationPingDecision,\n  shouldPersistLocationPing,\n",1)
needle="""test('out-of-order retry does not append stale history', () => {\n  const previous = { latitude: 26.8467, longitude: 80.9462, captured_at: '2026-09-29T10:01:00.000Z' };\n  assert.equal(shouldPersistLocationPing({\n    previous, lat: 26.8472, lng: 80.9462, capturedAt: '2026-09-29T10:00:30.000Z',\n    minDistanceM: 20, maxGapMs: 120000,\n  }), false);\n});\n"""
replacement=needle+"""\ntest('out-of-order retry cannot overwrite live location state', () => {\n  const previous = { latitude: 26.8467, longitude: 80.9462, captured_at: '2026-09-29T10:01:00.000Z' };\n  const decision = locationPingDecision({\n    previous, lat: 26.8472, lng: 80.9462, capturedAt: '2026-09-29T10:00:30.000Z',\n    minDistanceM: 20, maxGapMs: 120000,\n  });\n  assert.deepEqual(decision, { persisted: false, refreshLive: false, reason: 'stale' });\n});\n"""
if needle not in t: raise SystemExit('stale test block not found')
t=t.replace(needle,replacement,1)
p.write_text(t)
print('stale GPS safety patch prepared')
