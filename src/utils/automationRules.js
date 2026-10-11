const db = require("../db");
const { getCrmSettings, DEFAULT_AUTOMATION_STAGES, AUTOMATION_STAGES } = require("./crmSettings");

function inactiveRuleFrom(settings) {
  const raw = settings?.lead_settings?.automationRules?.inactiveLeadFollowUp || {};
  const days = Number(raw.inactivityDays);
  const stages = Array.isArray(raw.stages)
    ? [...new Set(raw.stages.filter((stage) => AUTOMATION_STAGES.includes(stage)))]
    : DEFAULT_AUTOMATION_STAGES;
  return {
    enabled: raw.enabled === true,
    inactivityDays: Number.isInteger(days) && days >= 1 && days <= 90 ? days : 5,
    stages: stages.length ? stages : DEFAULT_AUTOMATION_STAGES,
  };
}

function inactiveDaysFrom(lastActivityAt, now = new Date()) {
  if (!lastActivityAt) return null;
  const last = new Date(lastActivityAt);
  if (Number.isNaN(last.getTime())) return null;
  const diff = now.getTime() - last.getTime();
  if (diff < 0) return 0;
  return Math.floor(diff / 86400000);
}

async function decorateLeadsWithInactivity(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return rows || [];

  const database = options.database || db;
  const settings = options.settings || await getCrmSettings();
  const rule = inactiveRuleFrom(settings);

  if (!rule.enabled) {
    return rows.map((row) => ({ ...row, inactive_days: null, inactive_since: null }));
  }

  const eligibleIds = rows
    .filter((row) => rule.stages.includes(String(row.status || "").toLowerCase()))
    .map((row) => row.id)
    .filter(Boolean);

  const activityByLead = new Map();
  if (eligibleIds.length) {
    const { rows: activityRows } = await database.query(
      `SELECT entity_id AS lead_id, max(created_at) AS last_activity_at
       FROM activity_logs
       WHERE entity_type='lead' AND entity_id = ANY($1::uuid[])
       GROUP BY entity_id`,
      [eligibleIds]
    );
    for (const row of activityRows) activityByLead.set(String(row.lead_id), row.last_activity_at);
  }

  const now = options.now || new Date();
  return rows.map((row) => {
    if (!rule.stages.includes(String(row.status || "").toLowerCase())) {
      return { ...row, inactive_days: null, inactive_since: null };
    }
    const lastActivityAt = activityByLead.get(String(row.id)) || row.updated_at || row.created_at;
    const days = inactiveDaysFrom(lastActivityAt, now);
    const inactive = days != null && days >= rule.inactivityDays;
    return {
      ...row,
      inactive_days: inactive ? days : null,
      inactive_since: inactive ? lastActivityAt : null,
    };
  });
}

module.exports = { inactiveRuleFrom, inactiveDaysFrom, decorateLeadsWithInactivity };
