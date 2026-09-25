const db = require("../db");

const SENSITIVE_KEYS = new Set([
  "password", "password_hash", "passwordHash", "token", "accessToken", "refreshToken",
  "authorization", "secret", "cronSecret", "vapid_private_key", "privateKey"
]);

function sanitize(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key) || /password|secret|token|authorization|private.?key/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = sanitize(item, depth + 1);
    }
  }
  return out;
}

async function logActivity({ actorId, action, entityType, entityId, metadata = {} }) {
  await db.query(
    `INSERT INTO activity_logs (actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorId, action, entityType, entityId, sanitize(metadata)]
  );
}

async function notify({ type, salesmanId = null, leadId = null, payload = {} }) {
  await db.query(
    `INSERT INTO notifications (type, salesman_id, lead_id, payload)
     VALUES ($1, $2, $3, $4)`,
    [type, salesmanId, leadId, sanitize(payload)]
  );
}

module.exports = { logActivity, notify, sanitize };
