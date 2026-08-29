const db = require("../db");

async function logActivity({ actorId, action, entityType, entityId, metadata = {} }) {
  await db.query(
    `INSERT INTO activity_logs (actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorId, action, entityType, entityId, metadata]
  );
}

async function notify({ type, salesmanId = null, leadId = null, payload = {} }) {
  await db.query(
    `INSERT INTO notifications (type, salesman_id, lead_id, payload)
     VALUES ($1, $2, $3, $4)`,
    [type, salesmanId, leadId, payload]
  );
}

module.exports = { logActivity, notify };
