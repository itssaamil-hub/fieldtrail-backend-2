const { haversineMeters, impliedSpeedKmh } = require("./geo");

/**
 * Decide a lead/visit's verification_status and any fraud flags, given the
 * incoming GPS reading and (optionally) the salesman's last known point.
 *
 * This intentionally does not try to be clever about a single "true"
 * target location — per the product spec, verification here is about
 * whether the reading itself can be trusted (accuracy, plausibility of
 * movement since the last reading, mock-provider flag from the device),
 * not about matching a pre-registered address. Visit-based geofencing
 * (radius_m) is applied separately in the visit routes, where there IS a
 * specific place the salesman claims to be at.
 */
function assessReading({ lat, lng, accuracyM, isMockSuspected, capturedAt, lastKnown, settings }) {
  const flags = [];
  let verification_status = "verified";

  if (isMockSuspected) {
    flags.push("mock_gps_suspected");
    verification_status = "unverified";
  }

  if (accuracyM == null || accuracyM > settings.min_accuracy_m) {
    flags.push("poor_accuracy");
    if (verification_status === "verified") verification_status = "poor_accuracy";
  }

  // lastKnown = { lat, lng, capturedAt } for this salesman's previous reading
  if (lastKnown && lastKnown.lat != null) {
    const distanceM = haversineMeters(lastKnown.lat, lastKnown.lng, lat, lng);
    const seconds = (new Date(capturedAt) - new Date(lastKnown.capturedAt)) / 1000;
    const speedKmh = impliedSpeedKmh(distanceM, seconds);
    if (speedKmh > settings.max_speed_kmh) {
      flags.push("suspicious_jump");
      verification_status = "unverified";
    }
  }

  return { verification_status, flags };
}

/** True if a point is within radiusM of a target lat/lng (plain-JS check). */
function withinRadius(lat, lng, targetLat, targetLng, radiusM) {
  return haversineMeters(lat, lng, targetLat, targetLng) <= radiusM;
}

module.exports = { assessReading, withinRadius };
