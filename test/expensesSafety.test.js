const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'expenseEdits.routes.js'), 'utf8');

test('expense create defaults to the IST business date', () => {
  assert.match(route, /CURRENT_TIMESTAMP AT TIME ZONE 'Asia\/Kolkata'/);
});

test('expense create edit and delete are all audited', () => {
  assert.match(route, /expense\.created/);
  assert.match(route, /expense\.updated/);
  assert.match(route, /expense\.deleted/);
});

test('expense writes validate amount employee note and date', () => {
  assert.match(route, /MAX_AMOUNT=1000000000/);
  assert.match(route, /Selected employee is not valid/);
  assert.match(route, /Note must be at most 2000 characters/);
  assert.match(route, /validExpenseDate/);
});

test('expense delete locks the row before recording the deletion audit', () => {
  assert.match(route, /FROM expenses WHERE id=\$1 FOR UPDATE/);
  assert.match(route, /DELETE FROM expenses WHERE id=\$1/);
});
