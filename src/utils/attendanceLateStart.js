const db = require('../db');
const { notifyUsers, getAdminIds } = require('./pushNotifications');

function timeMinutes(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function istClockMinutes(value) {
  if (!value) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

function computeLateMinutes(startAt, expectedStartTime, toleranceMinutes) {
  const start = istClockMinutes(startAt);
  const expected = timeMinutes(expectedStartTime);
  if (start == null || expected == null || toleranceMinutes == null) return null;
  const tolerance = Number(toleranceMinutes);
  if (!Number.isFinite(tolerance) || tolerance < 0) return null;
  return Math.max(0, start - expected - tolerance);
}

async function notifyLateStartEvent({ userId, sessionNumber = 1, lateMinutes }) {
  try {
    const minutes = Number(lateMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return { sent: 0, failed: 0 };
    const { rows } = await db.query('SELECT full_name FROM users WHERE id=$1', [userId]);
    const name = rows[0]?.full_name || 'An employee';
    const session = sessionNumber > 1 ? ` · Session ${sessionNumber}` : '';
    const adminIds = await getAdminIds();
    return await notifyUsers(adminIds, 'day_started_ended', {
      title: 'Late Start',
      body: `${name} started day · Late by ${minutes} min${session}`,
      url: '/',
    });
  } catch (err) {
    console.error('late Start push failed:', err.message);
    return { sent: 0, failed: 0 };
  }
}

module.exports = { computeLateMinutes, notifyLateStartEvent };
