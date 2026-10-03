const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'trusted-lead-test-only';

const { stripLeadLocation } = require('../src/routes/employeeLocationPolicy.routes');

test('trusted lead capture strips every location field from stale client payloads', () => {
  const body = {
    businessName: 'Cafe 91',
    lat: 26.8467,
    lng: 80.9462,
    accuracyM: 8,
    capturedAt: '2026-10-03T12:00:00.000Z',
    deviceId: 'device-1',
    reverseGeocodedAddress: 'Lucknow',
    isMockSuspected: true,
  };

  stripLeadLocation(body);

  assert.equal(body.businessName, 'Cafe 91');
  for (const key of ['lat','lng','accuracyM','capturedAt','deviceId','reverseGeocodedAddress','isMockSuspected']) {
    assert.equal(Object.prototype.hasOwnProperty.call(body, key), false, `${key} must be removed`);
  }
});
