const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function isValidDay(value) {
  if (!DAY_RE.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateWonDate({ wonDate, status, createdDay, today }) {
  if (!isValidDay(wonDate)) throw fail('Choose a valid Won Date.');
  if (status !== 'won') throw fail('Won Date can only be edited while the deal is Won.', 409);
  if (!isValidDay(createdDay) || !isValidDay(today)) throw fail('Won Date validation data is unavailable.', 500);
  if (wonDate < createdDay) throw fail('Won Date cannot be before the deal was created.');
  if (wonDate > today) throw fail('Won Date cannot be in the future.');
  return wonDate;
}

module.exports = { isValidDay, validateWonDate };
