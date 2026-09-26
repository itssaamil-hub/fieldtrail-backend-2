const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'engage-test-secret-that-is-long-enough';
process.env.JWT_EXPIRES_IN = '1h';

const { signToken, verifyToken } = require('../src/utils/tokens');

test('JWT carries user role and auth version', () => {
  const token = signToken({
    id: '11111111-1111-4111-8111-111111111111',
    role: 'admin',
    full_name: 'Aamil',
    auth_version: 7,
  });
  const payload = verifyToken(token);
  assert.equal(payload.sub, '11111111-1111-4111-8111-111111111111');
  assert.equal(payload.role, 'admin');
  assert.equal(payload.name, 'Aamil');
  assert.equal(payload.ver, 7);
});

test('JWT auth version defaults to zero for newly migrated legacy rows', () => {
  const token = signToken({
    id: '22222222-2222-4222-8222-222222222222',
    role: 'salesman',
    full_name: 'Sales User',
  });
  assert.equal(verifyToken(token).ver, 0);
});

test('JWT verification rejects a token signed with another secret', () => {
  const jwt = require('jsonwebtoken');
  const forged = jwt.sign({ sub: 'x', role: 'admin', ver: 0 }, 'different-secret', { algorithm: 'HS256' });
  assert.throws(() => verifyToken(forged));
});
