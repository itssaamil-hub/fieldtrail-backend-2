// Plain-JS haversine distance in metres — used for quick in-application
// speed/jump checks. PostGIS (ST_Distance on the `geography` columns) is the
// source of truth for anything stored/queried at the DB level; this is for
// fast checks on values already in memory during a request.
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function impliedSpeedKmh(distanceM, seconds) {
  if (seconds <= 0) return Infinity;
  return (distanceM / seconds) * 3.6;
}

module.exports = { haversineMeters, impliedSpeedKmh };
