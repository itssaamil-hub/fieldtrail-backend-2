const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'attendance-core-test-only';
const vapid = require('web-push').generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;

const db = require('../src/db');
const dayClosing = require('../src/utils/dayClosing');

const U = '11111111-1111-4111-8111-111111111111';

function fakeDb({
  allowMultiple = false,
  requireStartLocation = false,
  requireEndLocation = false,
  sessions = [],
} = {}) {
  const state = {
    sessions: sessions.map((s) => ({ ...s })),
    status: 'offline',
    committed: 0,
    rolledBack: 0,
    scheduleQueries: 0,
  };

  const query = async (sql, args = []) => {
    if (sql === 'BEGIN') return { rows: [] };
    if (sql === 'COMMIT') { state.committed += 1; return { rows: [] }; }
    if (sql === 'ROLLBACK') { state.rolledBack += 1; return { rows: [] }; }

    if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: args[0] }] };
    if (sql.startsWith('INSERT INTO employee_day_closing_permissions')) return { rows: [] };
    if (sql.startsWith('SELECT * FROM employee_day_closing_permissions')) {
      return { rows: [{
        require_closing: false,
        allow_skip: false,
        require_skip_reason: true,
        allow_multiple_starts: allowMultiple,
        allow_lead_without_start_day: false,
        version: 1,
      }] };
    }

    if (sql.includes('attendance_company_schedule') || sql.includes('attendance_employee_schedule') || sql.includes('attendance_calendar_exceptions')) {
      state.scheduleQueries += 1;
      return { rows: [] };
    }

    if (sql.startsWith('SELECT *,day::text')) {
      return { rows: state.sessions.filter((s) => s.start_day_at && !s.end_day_at).slice(-1) };
    }

    if (sql.includes('FROM crm_settings')) {
      return { rows: [{
        lead_settings: {},
        location_settings: {
          requireLocationToStartDay: requireStartLocation,
          requireLocationToEndDay: requireEndLocation,
        },
      }] };
    }

    if (sql.startsWith('SELECT COALESCE(MAX(session_number)')) {
      return { rows: [{
        max_session: Math.max(0, ...state.sessions.map((s) => Number(s.session_number || 0))),
        ended_count: state.sessions.filter((s) => s.end_day_at).length,
      }] };
    }

    if (sql.startsWith('INSERT INTO attendance')) {
      state.sessions.push({
        id: `a${state.sessions.length + 1}`,
        day: '2026-09-29',
        session_number: args[2],
        start_day_at: new Date('2026-09-29T04:00:00Z'),
        end_day_at: null,
        start_lat: args[3],
        start_lng: args[4],
      });
      return { rows: [] };
    }

    if (sql.startsWith('UPDATE salesman_profiles')) {
      state.status = sql.includes("'online'") ? 'online' : 'offline';
      return { rows: [] };
    }

    if (sql.startsWith('SELECT id,session_number FROM attendance')) {
      const ended = state.sessions.filter((s) => s.end_day_at).slice(-1);
      return { rows: ended.map((s) => ({ id: s.id, session_number: s.session_number })) };
    }

    if (sql.startsWith('SELECT version FROM day_closing_reports')) return { rows: [] };
    if (sql.startsWith('SELECT\n (SELECT count')) {
      return { rows: [{ leads: 0, tasks: 0, followups: 0, demos: 0, quotes: 0, won: 0, sales_value: 0 }] };
    }

    if (sql.startsWith('UPDATE attendance')) {
      const s = state.sessions.find((x) => x.id === args[0]);
      if (s) {
        s.end_day_at = new Date('2026-09-29T10:00:00Z');
        s.end_lat = args[1];
        s.end_lng = args[2];
      }
      return { rows: [] };
    }

    return { rows: [] };
  };

  return { state, query };
}

function install(f) {
  db.query = f.query;
  db.pool.connect = async () => ({ query: f.query, release() {} });
}

function activeSession(n = 1) {
  return {
    id: `a${n}`,
    day: '2026-09-29',
    session_number: n,
    start_day_at: new Date('2026-09-29T04:00:00Z'),
    end_day_at: null,
  };
}

function endedSession(n = 1) {
  return {
    ...activeSession(n),
    end_day_at: new Date('2026-09-29T06:00:00Z'),
  };
}

test('first Start Day creates exactly one active session', async () => {
  const f = fakeDb(); install(f);
  const result = await dayClosing.startDay(U, {});
  assert.equal(result.startedNew, true);
  assert.equal(f.state.sessions.length, 1);
  assert.equal(f.state.sessions[0].session_number, 1);
  assert.equal(f.state.status, 'online');
});

test('duplicate Start Day is idempotent and does not create a second session', async () => {
  const f = fakeDb({ sessions: [activeSession()] }); install(f);
  const result = await dayClosing.startDay(U, {});
  assert.equal(result.deduped, true);
  assert.equal(result.sessionNumber, 1);
  assert.equal(f.state.sessions.length, 1);
});

test('Start/End/Start/End on the same day is supported when multiple cycles are enabled', async () => {
  const f = fakeDb({ allowMultiple: true }); install(f);
  await dayClosing.startDay(U, {});
  await dayClosing.endDay(U, { mode: 'none' });
  const second = await dayClosing.startDay(U, {});
  await dayClosing.endDay(U, { mode: 'none' });
  assert.equal(second.sessionNumber, 2);
  assert.equal(f.state.sessions.length, 2);
  assert.ok(f.state.sessions.every((s) => s.end_day_at));
});

test('required Start Day GPS is enforced server-side', async () => {
  const f = fakeDb({ requireStartLocation: true }); install(f);
  await assert.rejects(() => dayClosing.startDay(U, {}), /Location is required to start your day/);
  assert.equal(f.state.sessions.length, 0);
});

test('required End Day GPS is enforced server-side', async () => {
  const f = fakeDb({ requireEndLocation: true, sessions: [activeSession()] }); install(f);
  await assert.rejects(() => dayClosing.endDay(U, { mode: 'none' }), /Location is required to end your day/);
  assert.equal(f.state.sessions[0].end_day_at, null);
});

test('invalid GPS coordinates are rejected', async () => {
  const f = fakeDb(); install(f);
  await assert.rejects(() => dayClosing.startDay(U, { lat: 91, lng: 77 }), /Invalid location/);
  assert.equal(f.state.sessions.length, 0);
});

test('End Day without Start Day fails safely', async () => {
  const f = fakeDb(); install(f);
  await assert.rejects(() => dayClosing.endDay(U, { mode: 'none' }), /No active day found/);
});

test('retrying End Day after a successful End is idempotent', async () => {
  const f = fakeDb({ sessions: [activeSession()] }); install(f);
  await dayClosing.endDay(U, { mode: 'none' });
  const retry = await dayClosing.endDay(U, { mode: 'none' });
  assert.equal(retry.deduped, true);
  assert.equal(retry.sessionNumber, 1);
  assert.equal(f.state.sessions.length, 1);
});

test('weekly off or Sunday never blocks Start Day at the attendance write layer', async () => {
  const f = fakeDb(); install(f);
  const result = await dayClosing.startDay(U, {});
  assert.equal(result.startedNew, true);
  assert.equal(f.state.scheduleQueries, 0, 'Start Day must not consult work-calendar restrictions');
});
