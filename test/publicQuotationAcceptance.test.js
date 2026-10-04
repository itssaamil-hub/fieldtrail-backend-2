const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'public-quote-test-secret';
const { makePublicQuoteToken, parsePublicQuoteToken, publicQuoteUrl } = require('../src/utils/publicQuotation');
const { state } = require('../src/routes/publicQuotation.routes');

const linkId = '11111111-1111-4111-8111-111111111111';

test('public quotation token round-trips and rejects tampering', () => {
  const token = makePublicQuoteToken(linkId);
  assert.equal(parsePublicQuoteToken(token), linkId);
  assert.equal(parsePublicQuoteToken(token + 'x'), null);
  assert.equal(parsePublicQuoteToken('not-a-token'), null);
  assert.match(publicQuoteUrl(token), /\/q\/index\.html\?t=/);
});

test('public quotation response gate closes expired, superseded, revoked and answered links', () => {
  const base = {
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    revoked_at: null,
    current_revision: 2,
    revision: 2,
    status: 'sent',
  };
  assert.equal(state(base, null).canRespond, true);
  assert.equal(state({ ...base, expires_at: new Date(Date.now() - 60_000).toISOString() }, null).canRespond, false);
  assert.equal(state({ ...base, current_revision: 3 }, null).canRespond, false);
  assert.equal(state({ ...base, revoked_at: new Date().toISOString() }, null).canRespond, false);
  assert.equal(state(base, { action: 'accepted' }).canRespond, false);
  assert.equal(state({ ...base, status: 'accepted' }, null).canRespond, false);
});
