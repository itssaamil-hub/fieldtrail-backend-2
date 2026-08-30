const { verifyToken } = require("../utils/tokens");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  // A direct browser navigation (e.g. clicking an export/download link)
  // can't set a custom Authorization header, so those routes pass the
  // token as ?token=... instead — accepted here as a fallback only.
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token || null;
  if (!token) return res.status(401).json({ error: "Missing bearer token" });

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, role: payload.role, name: payload.name };
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
