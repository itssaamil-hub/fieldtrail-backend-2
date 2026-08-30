const db = require("../db");

async function getCrmSettings() {
  const { rows } = await db.query(
    `SELECT lead_settings, location_settings FROM crm_settings ORDER BY updated_at DESC LIMIT 1`
  );
  // Sensible fallback if the settings row is somehow missing, so the API
  // never crashes on this — defaults match the spec's ON/OFF values.
  return (
    rows[0] || {
      lead_settings: {
        requireBusinessName: true,
        requireSubLocation: true,
        requirePosName: true,
        requireContactName: true,
        requireContactNumber: true,
        requireStatus: true,
        requireComments: false,
      },
      location_settings: {
        gpsLocation: true,
        locationMandatoryForNewLead: true,
        continuousGpsTracking: true,
      },
    }
  );
}

/**
 * Validates a lead payload against the current Lead Settings and Location
 * Settings. Returns { ok: true } or { ok: false, error: "..." }.
 */
function validateLeadAgainstSettings(payload, settings) {
  const ls = settings.lead_settings;
  const loc = settings.location_settings;

  const missing = [];
  if (ls.requireBusinessName && !payload.businessName) missing.push("Business Name");
  if (ls.requireSubLocation && !payload.subLocation) missing.push("Sub Location");
  if (ls.requirePosName && !payload.posName) missing.push("POS Name");
  if (ls.requireContactName && !payload.contactName) missing.push("Contact Name");
  if (ls.requireContactNumber && !payload.phone) missing.push("Contact Number");
  // requireStatus isn't checked here: new leads default to "new", which is
  // always a valid status, so there's nothing to reject — this setting
  // instead drives whether the field is shown as required in the form.
  if (ls.requireComments && !payload.notes) missing.push("Comments");

  if (missing.length > 0) {
    return { ok: false, error: `Missing required field(s): ${missing.join(", ")}` };
  }

  if (loc.gpsLocation && loc.locationMandatoryForNewLead) {
    if (payload.lat == null || payload.lng == null) {
      return { ok: false, error: "Location is required for this lead but was not captured." };
    }
  }

  return { ok: true };
}

module.exports = { getCrmSettings, validateLeadAgainstSettings };
