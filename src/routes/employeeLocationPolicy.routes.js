const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getCrmSettings } = require('../utils/crmSettings');
const { permissions } = require('../utils/dayClosing');
const { getEmployeeLocationSettings } = require('../utils/employeeLocation');

const router = express.Router();
router.use(requireAuth, requireRole('salesman'));

// Employee-specific replacement for the legacy global Location Settings response.
// Lead/message settings remain global; only the three GPS controls are per employee.
router.get('/settings', async (req,res) => {
  const settings = await getCrmSettings();
  const dayPermissions = await permissions(db.query, req.user.id);
  const locationSettings = await getEmployeeLocationSettings(req.user.id);
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

// Apply the employee GPS policy, then hand the request to the existing lead
// creation route. This deliberately does not duplicate lead creation logic:
// duplicate checks, Start Day rules, audit logs, notifications and all other
// current behaviour remain owned by the existing route.
router.post('/leads', async (req,res,next) => {
  const dayPermissions = await permissions(db.query, req.user.id);
  const trustedLeadCapture = !!dayPermissions.allow_lead_without_start_day;
  const policy = await getEmployeeLocationSettings(req.user.id);

  // GPS OFF means no location should be stored even if an older client sends
  // cached coordinates. Clear all location evidence before the legacy handler.
  if (!policy.gpsLocation) {
    delete req.body.lat;
    delete req.body.lng;
    delete req.body.accuracyM;
    delete req.body.capturedAt;
    delete req.body.deviceId;
    delete req.body.reverseGeocodedAddress;
    delete req.body.isMockSuspected;
  }

  // Trusted lead entry intentionally remains able to work without GPS.
  if (!trustedLeadCapture && policy.gpsLocation && policy.locationMandatoryForNewLead) {
    if (req.body.lat == null || req.body.lng == null) {
      return res.status(400).json({ error: 'Location is required for this lead but was not captured.' });
    }
  }

  next();
});

module.exports=router;
