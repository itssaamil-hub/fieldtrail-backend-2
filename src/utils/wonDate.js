const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function isoDayInIst(date = new Date()) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function validCalendarDay(value) {
  if (!DAY_RE.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateWonDate(value, now = new Date()) {
  if (!validCalendarDay(value)) {
    const err = new Error('Choose a valid Won Date.');
    err.status = 400;
    throw err;
  }
  if (value > isoDayInIst(now)) {
    const err = new Error('Won Date cannot be in the future.');
    err.status = 400;
    throw err;
  }
  return value;
}

module.exports = { isoDayInIst, validCalendarDay, validateWonDate };
