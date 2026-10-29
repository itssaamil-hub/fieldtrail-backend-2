const { verifyToken } = require("../utils/tokens");
const db = require("../db");
const { isDeviceAllowed, MOBILE_ONLY_MESSAGE } = require("../utils/deviceAccess");

const QUERY_TOKEN_PATHS = [
  /^\/admin\/leads\/export\.(?:csv|xlsx)$/i,
  /^\/admin\/payments\/export\.(?:csv|xlsx|pdf)$/i,
  /^\/quotations\/[0-9a-f-]+\/pdf$/i,
  /^\/collections\/[^/]+\/payments\/[0-9a-f-]+\/receipt$/i,
  /^\/onboarding\/[0-9a-f-]+\/pdf$/i,
];

function mayUseQueryToken(req) {
  if (!["GET", "HEAD"].includes(req.method)) return false;
  const path = String(req.originalUrl || req.url || "").split("?")[0];
  return QUERY_TOKEN_PATHS.some((re) => re.test(path));
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  const queryToken = mayUseQueryToken(req) && typeof req.query.token === "string" ? req.query.token : null;
  const token = bearer || queryToken;
  if (!token) return res.status(401).json({ error: "Missing bearer token" });

  try {
    const payload = verifyToken(token);
    if (!payload?.sub || !payload?.role) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    const tokenVersion = Number.isInteger(payload.ver) ? payload.ver : 0;

    const { rows } = await db.query(
      `SELECT id, device_access_policy FROM users WHERE id=$1 AND role=$2 AND is_active=true AND auth_version=$3`,
      [payload.sub, payload.role, tokenVersion]
    );
    if (!rows[0]) {
      return res.status(401).json({ error: "Account is inactive or session is no longer valid" });
    }
    if (!isDeviceAllowed(payload.role, rows[0].device_access_policy, req)) {
      return res.status(403).json({ error: MOBILE_ONLY_MESSAGE, code: "MOBILE_ONLY_ACCESS" });
    }

    req.user = { id: payload.sub, role: payload.role, name: payload.name || null };
    req.authViaQuery = !!queryToken && !bearer;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `Requires ${role} role` });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
