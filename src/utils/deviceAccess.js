// A browser can spoof its user-agent or client hints. This blocks ordinary
// laptop/desktop access, but is not a cryptographic proof of physical hardware.
function isPhoneBrowser(req) {
  const ua = String(req?.headers?.["user-agent"] || "");
  // An iPad/tablet is not a phone. Android phones commonly advertise Mobile.
  if (/iPad|Tablet|Android(?![^)]*Mobile)/i.test(ua)) return false;
  return /iPhone|iPod|Windows Phone|Android[^\n]*Mobile|Mobile[^\n]*Android/i.test(ua);
}

function isDeviceAllowed(role, policy, req) {
  if (role !== "salesman") return true;
  return policy !== "mobile_only" || isPhoneBrowser(req);
}

const MOBILE_ONLY_MESSAGE = "This employee account is set to Mobile Only. Open Engage on your Android phone or iPhone, or ask your admin to allow laptop access.";

module.exports = { isPhoneBrowser, isDeviceAllowed, MOBILE_ONLY_MESSAGE };
