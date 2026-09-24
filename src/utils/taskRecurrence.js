// Preserve the IST wall-clock time and original day-of-month; skip missed occurrences.
const IST = 330 * 60 * 1000;
function nextTaskDue(dueAt, recurrence, anchorDay, now = new Date()) {
 if (!['daily','weekly','monthly'].includes(recurrence)) return null;
 const start = new Date(new Date(dueAt).getTime() + IST);
 if (!Number.isFinite(start.getTime())) throw new Error('Invalid recurrence date');
 const cutoff = new Date(now).getTime() + IST;
 if (recurrence !== 'monthly') {
  const interval = (recurrence === 'daily' ? 1 : 7) * 86400000;
  const steps = Math.max(1, Math.floor((cutoff - start.getTime()) / interval) + 1);
  return new Date(start.getTime() + steps * interval - IST).toISOString();
 }
 const day = anchorDay || start.getUTCDate();
 const current = new Date(cutoff);
 let months = Math.max(1, (current.getUTCFullYear() - start.getUTCFullYear()) * 12 + current.getUTCMonth() - start.getUTCMonth());
 for (;;) {
  const candidate = new Date(start);candidate.setUTCDate(1);candidate.setUTCMonth(start.getUTCMonth() + months);
  const end = new Date(Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth()+1, 0)).getUTCDate();
  candidate.setUTCDate(Math.min(day,end));
  if (candidate.getTime() > cutoff) return new Date(candidate.getTime()-IST).toISOString();
  months++;
 }
}
module.exports={nextTaskDue};
