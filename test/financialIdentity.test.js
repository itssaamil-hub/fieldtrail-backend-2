const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveCompanyIdentity } = require('../src/utils/collections');

test('financial identity uses stored account snapshot when present', () => {
  const identity = resolveCompanyIdentity(
    { company: 'Saved Company', companyContact: 'saved@example.com' },
    { company: 'Current Company', companyContact: 'current@example.com' }
  );
  assert.equal(identity.company, 'Saved Company');
  assert.equal(identity.companyContact, 'saved@example.com');
});

test('financial identity may use real configured company when legacy snapshot has no identity', () => {
  const identity = resolveCompanyIdentity({}, { company: 'Configured Company', companyContact: 'accounts@example.com' });
  assert.equal(identity.company, 'Configured Company');
  assert.equal(identity.companyContact, 'accounts@example.com');
});

test('financial identity never invents a company name', () => {
  assert.throws(
    () => resolveCompanyIdentity({}, {}),
    (err) => err && err.status === 500 && /Company identity is not configured/.test(err.message)
  );
});
