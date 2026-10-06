const test = require('node:test');
const assert = require('node:assert/strict');

const employeePolicyRouter = require('../src/routes/employeeLocationPolicy.routes');
const { effectiveAttendanceLocationRequirement } = require('../src/utils/dayClosing');

const effectiveLocationSettings = employeePolicyRouter.effectiveLocationSettings;

test('employee GPS OFF disables all employee GPS requirements', () => {
  const effective = effectiveLocationSettings({
    gpsLocation:false,
    locationMandatoryForNewLead:true,
    continuousGpsTracking:true,
    requireLocationToStartDay:true,
    requireLocationToEndDay:true,
    version:3,
  });
  assert.equal(effective.gpsLocation, false);
  assert.equal(effective.locationMandatoryForNewLead, false);
  assert.equal(effective.continuousGpsTracking, false);
  assert.equal(effective.requireLocationToStartDay, false);
  assert.equal(effective.requireLocationToEndDay, false);
  assert.equal(effectiveAttendanceLocationRequirement({gpsLocation:false,requireLocationToStartDay:true},'start'), false);
  assert.equal(effectiveAttendanceLocationRequirement({gpsLocation:false,requireLocationToEndDay:true},'end'), false);
});

test('GPS ON preserves the employee lead, tracking, Start and End requirements', () => {
  const policy = {
    gpsLocation:true,
    locationMandatoryForNewLead:false,
    continuousGpsTracking:true,
    requireLocationToStartDay:true,
    requireLocationToEndDay:false,
    version:2,
  };
  const effective = effectiveLocationSettings(policy);
  assert.equal(effective.gpsLocation, true);
  assert.equal(effective.locationMandatoryForNewLead, false);
  assert.equal(effective.continuousGpsTracking, true);
  assert.equal(effective.requireLocationToStartDay, true);
  assert.equal(effective.requireLocationToEndDay, false);
  assert.equal(effectiveAttendanceLocationRequirement(policy,'start'), true);
  assert.equal(effectiveAttendanceLocationRequirement(policy,'end'), false);
});

test('missing/unknown employee GPS policy can never enable Start or End GPS', () => {
  assert.equal(effectiveAttendanceLocationRequirement(null,'start'), false);
  assert.equal(effectiveAttendanceLocationRequirement(undefined,'end'), false);
});
