const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getCrmSettings } = require('../utils/crmSettings');
const { permissions } = require('../utils/dayClosing');
const { getEmployeeLocationSettings } = require('../utils/employeeLocation');

const router = express.Router();
router.use(requireAuth, requireRole('salesman'));

function effectiveLocationSettings(employeePolicy) {
  const gpsLocation = employeePolicy.gpsLocation === true;
  return {
    ...employeePolicy,
    gpsLocation,
    locationMandatoryForNewLead: gpsLocation && employeePolicy.locationMandatoryForNewLead === true,
    continuousGpsTracking: gpsLocation && employeePolicy.continuousGpsTracking === true,
    requireLocationToStartDay: gpsLocation && employeePolicy.requireLocationToStartDay === true,
    requireLocationToEndDay: gpsLocation && employeePolicy.requireLocationToEndDay === true,
  };
}

// Employee-specific replacement for the legacy global Location Settings response.
// Lead/message settings remain global. GPS capture is governed by the employee
// policy first, including Start Day and End Day GPS requirements. Global CRM
// location flags are legacy compatibility data and are not authoritative here.
router.get('/settings', async (req,res) => {
  const settings = await getCrmSettings();
  const dayPermissions = await permissions(db.query, req.user.id);
  const employeePolicy = await getEmployeeLocationSettings(req.user.id);
  const locationSettings = effectiveLocationSettings(employeePolicy);
  res.json({
    leadSettings: settings.lead_settings,
    locationSettings,
    messageSettings: settings.message_settings || { employeeRepliesEnabled: true },
    employeePermissions: { allowLeadWithoutStartDay: !!dayPermissions.allow_lead_without_start_day },
  });
});

// Server-side guard as well as the client toggle: a stale/open PWA cannot
// continue writing GPS history after Continuous GPS Tracking is switched off.
router.post('/location/ping', async (req,res,next) => {
  const policy = await getEmployeeLocationSettings(req.user.id);
  if (!policy.gpsLocation || !policy.continuousGpsTracking) {
    return res.status(403).json({ error: 'Continuous GPS tracking is disabled for your account.' });
  }
  next();
});

function stripLeadLocation(body = {}) {
  delete body.lat;
  delete body.lng;
  delete body.accuracyM;
  delete body.capturedAt;
  delete body.deviceId;
  delete body.reverseGeocodedAddress;
  delete body.isMockSuspected;
}

// Apply the employee GPS policy, then hand the request to the existing lead
// creation route. This deliberately does not duplicate lead creation logic:
// duplicate checks, Start Day rules, audit logs, notifications and all other
// current behaviour remain owned by the existing route.
router.post('/leads', async (req,res,next) => {
  const dayPermissions = await permissions(db.query, req.user.id);
  const trustedLeadCapture = !!dayPermissions.allow_lead_without_start_day;
  const policy = await getEmployeeLocationSettings(req.user.id);
  const mandatoryLeadGps = policy.gpsLocation === true && policy.locationMandatoryForNewLead === true;

  // Explicit lead GPS policy has precedence. If GPS Location + Location Mandatory
  // for New Lead are both ON, Add Deal must capture and retain coordinates even
  // when the employee is otherwise trusted to enter leads without Start Day/GPS.
  // Trusted GPS-free lead capture applies only when mandatory lead GPS is not ON.
  if (!policy.gpsLocation || (trustedLeadCapture && !mandatoryLeadGps)) {
    stripLeadLocation(req.body);
  }

  if (mandatoryLeadGps) {
    if (req.body.lat == null || req.body.lng == null) {
      return res.status(400).json({ error: 'Location is required for this lead but was not captured.' });
    }
  }

  next();
});

module.exports=router;
module.exports.effectiveLocationSettings=effectiveLocationSettings;
module.exports.stripLeadLocation=stripLeadLocation;
