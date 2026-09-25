const db = require('../db');

const DEFAULTS = {
  gpsLocation: true,
  locationMandatoryForNewLead: true,
  continuousGpsTracking: true,
  version: 0,
};

function mapRow(row) {
  if (!row) return { ...DEFAULTS };
  return {
    gpsLocation: row.gps_location !== false,
    locationMandatoryForNewLead: row.location_mandatory_for_new_lead !== false,
    continuousGpsTracking: row.continuous_gps_tracking !== false,
    version: Number(row.version || 0),
  };
}

async function getEmployeeLocationSettings(userId, query = db.query) {
  const { rows } = await query(
    `SELECT gps_location, location_mandatory_for_new_lead, continuous_gps_tracking, version
       FROM employee_location_settings
      WHERE user_id=$1`,
    [userId]
  );
  return mapRow(rows[0]);
}

async function saveEmployeeLocationSettings({ userId, actorId, settings }, query = db.query) {
  const values = ['gpsLocation', 'locationMandatoryForNewLead', 'continuousGpsTracking'];
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

  const { rows } = await query(
    `INSERT INTO employee_location_settings
       (user_id,gps_location,location_mandatory_for_new_lead,continuous_gps_tracking,updated_by,updated_at,version)
     VALUES($1,$2,$3,$4,$5,now(),0)
     ON CONFLICT(user_id) DO UPDATE SET
       gps_location=EXCLUDED.gps_location,
       location_mandatory_for_new_lead=EXCLUDED.location_mandatory_for_new_lead,
       continuous_gps_tracking=EXCLUDED.continuous_gps_tracking,
       updated_by=EXCLUDED.updated_by,
       updated_at=now(),
       version=employee_location_settings.version+1
     RETURNING gps_location,location_mandatory_for_new_lead,continuous_gps_tracking,version`,
    [userId, settings.gpsLocation, settings.locationMandatoryForNewLead, settings.continuousGpsTracking, actorId]
  );
  return mapRow(rows[0]);
}

module.exports = { DEFAULTS, getEmployeeLocationSettings, saveEmployeeLocationSettings };
