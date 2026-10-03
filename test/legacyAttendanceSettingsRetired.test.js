const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('legacy attendance settings path is retired before Day Closing router', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const retiredMount = 'app.use("/day-closing", require("./routes/legacyAttendanceSettings.routes"));';
  const dayClosingMount = 'app.use("/day-closing", require("./routes/dayClosing.routes"));';

  assert.ok(appSource.includes(retiredMount));
  assert.ok(appSource.includes(dayClosingMount));
  assert.ok(appSource.indexOf(retiredMount) < appSource.indexOf(dayClosingMount));
});

test('retired route points clients to Attendance V2 canonical settings path', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'legacyAttendanceSettings.routes.js'), 'utf8');
  assert.ok(routeSource.includes("router.use('/attendance-settings'"));
  assert.ok(routeSource.includes("res.status(410)"));
  assert.ok(routeSource.includes("canonicalPath: '/attendance-v2/settings'"));
});
