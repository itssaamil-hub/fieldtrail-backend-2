const db = require('../db');

const DEFAULTS = {
  gpsLocation: true,
  locationMandatoryForNewLead: true,
  continuousGpsTracking: true,
  requireLocationToStartDay: true,
  requireLocationToEndDay: true,
  version: 0,
};

function mapRow(row) {
  if (!row) {
    const err = new Error('Location policy is missing for this employee');
    err.status = 500;
    throw err;
  }
  const gpsLocation = row.gps_location !== false;
  return {
    gpsLocation,
    locationMandatoryForNewLead: gpsLocation && row.location_mandatory_for_new_lead !== false,
    continuousGpsTracking: gpsLocation && row.continuous_gps_tracking !== false,
    requireLocationToStartDay: gpsLocation && row.require_location_to_start_day !== false,
    requireLocationToEndDay: gpsLocation && row.require_location_to_end_day !== false,
    version: Number(row.version || 0),
  };
}

async function ensureEmployeeLocationSettings(userId, query = db.query) {
  await query(
    `INSERT INTO employee_location_settings
       (user_id,gps_location,location_mandatory_for_new_lead,continuous_gps_tracking,require_location_to_start_day,require_location_to_end_day)
     SELECT id,TRUE,TRUE,TRUE,TRUE,TRUE
       FROM users
      WHERE id=$1 AND role='salesman'
     ON CONFLICT(user_id) DO NOTHING`,
    [userId]
  );
}

async function getEmployeeLocationSettings(userId, query = db.query) {
  await ensureEmployeeLocationSettings(userId, query);
  const { rows } = await query(
    `SELECT gps_location, location_mandatory_for_new_lead, continuous_gps_tracking, require_location_to_start_day, require_location_to_end_day, version
       FROM employee_location_settings
      WHERE user_id=$1`,
    [userId]
  );
  return mapRow(rows[0]);
}

async function saveEmployeeLocationSettings({ userId, actorId, settings }, query = db.query) {
  const values = ['gpsLocation', 'locationMandatoryForNewLead', 'continuousGpsTracking', 'requireLocationToStartDay', 'requireLocationToEndDay'];
  if (!settings || values.some((key) => typeof settings[key] !== 'boolean')) {
    const err = new Error('Invalid location settings');
    err.status = 400;
    throw err;
  }

  const current = await getEmployeeLocationSettings(userId, query);
  if (settings.version != null && Number(settings.version) !== current.version) {
    const err = new Error('Settings changed. Reload before saving.');
    err.status = 409;
    throw err;
  }

  const gpsLocation = settings.gpsLocation;
  const locationMandatoryForNewLead = gpsLocation ? settings.locationMandatoryForNewLead : false;
  const continuousGpsTracking = gpsLocation ? settings.continuousGpsTracking : false;
  const requireLocationToStartDay = gpsLocation ? settings.requireLocationToStartDay : false;
  const requireLocationToEndDay = gpsLocation ? settings.requireLocationToEndDay : false;

  const { rows } = await query(
    `INSERT INTO employee_location_settings
       (user_id,gps_location,location_mandatory_for_new_lead,continuous_gps_tracking,require_location_to_start_day,require_location_to_end_day,updated_by,updated_at,version)
     VALUES($1,$2,$3,$4,$5,$6,$7,now(),0)
     ON CONFLICT(user_id) DO UPDATE SET
       gps_location=EXCLUDED.gps_location,
       location_mandatory_for_new_lead=EXCLUDED.location_mandatory_for_new_lead,
       continuous_gps_tracking=EXCLUDED.continuous_gps_tracking,
       require_location_to_start_day=EXCLUDED.require_location_to_start_day,
       require_location_to_end_day=EXCLUDED.require_location_to_end_day,
       updated_by=EXCLUDED.updated_by,
       updated_at=now(),
       version=employee_location_settings.version+1
     WHERE employee_location_settings.version=$8
     RETURNING gps_location,location_mandatory_for_new_lead,continuous_gps_tracking,require_location_to_start_day,require_location_to_end_day,version`,
    [userId, gpsLocation, locationMandatoryForNewLead, continuousGpsTracking, requireLocationToStartDay, requireLocationToEndDay, actorId, current.version]
  );
  // Another save can commit after the read above. Enforce the version inside
  // the write as well, so that competing saves cannot overwrite newer policy.
  if (!rows.length) {
    const err = new Error('Settings changed. Reload before saving.');
    err.status = 409;
    throw err;
  }
  return mapRow(rows[0]);
}

module.exports = { DEFAULTS, ensureEmployeeLocationSettings, getEmployeeLocationSettings, saveEmployeeLocationSettings };
