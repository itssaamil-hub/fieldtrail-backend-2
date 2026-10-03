const test = require('node:test');
const assert = require('node:assert/strict');

const employeePolicyRouter = require('../src/routes/employeeLocationPolicy.routes');
const { effectiveAttendanceLocationRequirement } = require('../src/utils/dayClosing');

const effectiveLocationSettings = employeePolicyRouter.effectiveLocationSettings;

test('employee GPS OFF disables all GPS acquisition regardless of company requirements', () => {
  const effective = effectiveLocationSettings(
    { gpsLocation:false, locationMandatoryForNewLead:true, continuousGpsTracking:true, version:3 },
    { requireLocationToStartDay:true, requireLocationToEndDay:true }
  );
  assert.equal(effective.gpsLocation, false);
  assert.equal(effective.locationMandatoryForNewLead, false);
  assert.equal(effective.continuousGpsTracking, false);
  assert.equal(effective.requireLocationToStartDay, false);
  assert.equal(effective.requireLocationToEndDay, false);
  assert.equal(effectiveAttendanceLocationRequirement({gpsLocation:false},{requireLocationToStartDay:true},'start'), false);
  assert.equal(effectiveAttendanceLocationRequirement({gpsLocation:false},{requireLocationToEndDay:true},'end'), false);
});

test('GPS ON preserves the employee lead/tracking switches and company Start/End requirements', () => {
  const effective = effectiveLocationSettings(
    { gpsLocation:true, locationMandatoryForNewLead:false, continuousGpsTracking:true, version:2 },
    { requireLocationToStartDay:true, requireLocationToEndDay:false }
  );
  assert.equal(effective.gpsLocation, true);
  assert.equal(effective.locationMandatoryForNewLead, false);
  assert.equal(effective.continuousGpsTracking, true);
  assert.equal(effective.requireLocationToStartDay, true);
  assert.equal(effective.requireLocationToEndDay, false);
  assert.equal(effectiveAttendanceLocationRequirement({gpsLocation:true},{requireLocationToStartDay:true},'start'), true);
  assert.equal(effectiveAttendanceLocationRequirement({gpsLocation:true},{requireLocationToEndDay:false},'end'), false);
});

test('missing/unknown employee GPS policy can never enable Start or End GPS', () => {
  assert.equal(effectiveAttendanceLocationRequirement(null,{requireLocationToStartDay:true},'start'), false);
  assert.equal(effectiveAttendanceLocationRequirement(undefined,{requireLocationToEndDay:true},'end'), false);
});
