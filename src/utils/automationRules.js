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


const INACTIVE_PUSH_RULE_KEY = "inactive-lead-push-v1";

async function runInactiveLeadNotifications(options = {}) {
  const database = options.database || db;
  const settings = options.settings || await getCrmSettings();
  const rule = inactiveRuleFrom(settings);
  const emptyDelivery = () => ({
    requestedUsers:0, eligibleUsers:0, subscribedUsers:0, subscribedDevices:0,
    preferenceDisabledUsers:0, sent:0, failed:0,
  });
  const summary = { eligibleLeads:0, claimed:0, notified:0, deferred:0, delivery:emptyDelivery() };
  if (!rule.enabled) return summary;

  const { rows } = await database.query(
    "SELECT id,business_name,salesman_id,status,created_at,updated_at FROM leads WHERE salesman_id IS NOT NULL AND status::text = ANY($1::text[])",
    [rule.stages]
  );
  const decorated = await decorateLeadsWithInactivity(rows, { database, settings, now: options.now });
  const inactive = decorated.filter((lead) => lead.inactive_days != null && lead.inactive_since);
  summary.eligibleLeads = inactive.length;
  if (!inactive.length) return summary;

  const notify = options.notify || (async (...args) => {
    const { notifyUsers } = require("./pushNotifications");
    return notifyUsers(...args);
  });
  const addDelivery = (target, value) => {
    for (const key of Object.keys(target)) target[key] += Number(value?.[key] || 0);
  };

  for (const lead of inactive) {
    const claim = await database.query(
      "INSERT INTO automation_rule_runs(rule_key,lead_id,activity_anchor) VALUES($1,$2,$3::timestamptz) ON CONFLICT DO NOTHING RETURNING rule_key",
      [INACTIVE_PUSH_RULE_KEY, lead.id, lead.inactive_since]
    );
    if (!claim.rows[0]) continue;
    summary.claimed += 1;

    let delivery;
    try {
      delivery = await notify(
        [lead.salesman_id],
        "inactive_lead",
        {
          title: lead.business_name + " needs attention",
          body: "No activity for " + lead.inactive_days + " day" + (lead.inactive_days === 1 ? "" : "s") + ".",
          url: "/#lead=" + encodeURIComponent(lead.id),
        }
      );
    } catch (err) {
      await database.query(
        "DELETE FROM automation_rule_runs WHERE rule_key=$1 AND lead_id=$2 AND activity_anchor=$3::timestamptz",
        [INACTIVE_PUSH_RULE_KEY, lead.id, lead.inactive_since]
      );
      throw err;
    }

    addDelivery(summary.delivery, delivery);
    if (Number(delivery?.sent || 0) > 0) {
      summary.notified += 1;
    } else {
      summary.deferred += 1;
      await database.query(
        "DELETE FROM automation_rule_runs WHERE rule_key=$1 AND lead_id=$2 AND activity_anchor=$3::timestamptz",
        [INACTIVE_PUSH_RULE_KEY, lead.id, lead.inactive_since]
      );
    }
  }
  return summary;
}

module.exports = { inactiveRuleFrom, inactiveDaysFrom, decorateLeadsWithInactivity, runInactiveLeadNotifications, INACTIVE_PUSH_RULE_KEY };
