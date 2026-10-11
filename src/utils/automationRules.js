const db = require("../db");
const { getCrmSettings } = require("./crmSettings");

const RULE_KEY = "inactive-lead-follow-up";

function inactiveRuleFrom(settings) {
  const raw = settings?.lead_settings?.automationRules?.inactiveLeadFollowUp || {};
  const days = Number(raw.inactivityDays);
  return {
    enabled: raw.enabled === true,
    inactivityDays: Number.isInteger(days) && days >= 1 && days <= 90 ? days : 5,
  };
}

async function runInactiveLeadFollowUpAutomation(options = {}) {
  const database = options.database || db;
  const settings = options.settings || await getCrmSettings();
  const rule = inactiveRuleFrom(settings);
  if (!rule.enabled) return { enabled: false, created: 0, eligible: 0 };

  const { rows: leads } = await database.query(
    `WITH log_activity AS (
       SELECT entity_id AS lead_id, max(created_at) AS last_log_at
       FROM activity_logs
       WHERE entity_type='lead'
       GROUP BY entity_id
     ), status_activity AS (
       SELECT lead_id, max(changed_at) AS last_status_at
       FROM lead_status_history
       GROUP BY lead_id
     )
     SELECT l.id,l.business_name,l.salesman_id,
       GREATEST(
         l.updated_at,
         coalesce(a.last_log_at,l.updated_at),
         coalesce(s.last_status_at,l.updated_at)
       ) AS last_activity_at
     FROM leads l
     JOIN users u ON u.id=l.salesman_id AND u.role='salesman' AND u.is_active=true
     LEFT JOIN log_activity a ON a.lead_id=l.id
     LEFT JOIN status_activity s ON s.lead_id=l.id
     WHERE l.status NOT IN ('won','lost')
       AND GREATEST(
         l.updated_at,
         coalesce(a.last_log_at,l.updated_at),
         coalesce(s.last_status_at,l.updated_at)
       ) <= now() - ($1::int * interval '1 day')
     ORDER BY last_activity_at,l.id`,
    [rule.inactivityDays]
  );

  let created = 0;
  for (const lead of leads) {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const claim = await client.query(
        `INSERT INTO automation_rule_runs(rule_key,lead_id,activity_anchor)
         VALUES($1,$2,$3)
         ON CONFLICT DO NOTHING
         RETURNING rule_key`,
        [RULE_KEY, lead.id, lead.last_activity_at]
      );
      if (!claim.rows.length) {
        await client.query("COMMIT");
        continue;
      }

      const due = await client.query(
        `SELECT ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '23 hours 59 minutes')
          AT TIME ZONE 'Asia/Kolkata') AS due_at`
      );
      const title = `Follow up with ${lead.business_name}`.slice(0, 180);
      const notes = `Automatically created because this lead has had no activity for ${rule.inactivityDays} day${rule.inactivityDays === 1 ? "" : "s"}.`;
      const taskResult = await client.query(
        `INSERT INTO crm_tasks(title,notes,lead_id,assigned_to,created_by,due_at,priority,recurrence,recurrence_day)
         VALUES($1,$2,$3,$4,NULL,$5,'medium','none',
           EXTRACT(DAY FROM ($5::timestamptz AT TIME ZONE 'Asia/Kolkata'))::int)
         RETURNING id`,
        [title, notes, lead.id, lead.salesman_id, due.rows[0].due_at]
      );
      const taskId = taskResult.rows[0].id;
      await client.query(
        `UPDATE automation_rule_runs SET task_id=$4
         WHERE rule_key=$1 AND lead_id=$2 AND activity_anchor=$3`,
        [RULE_KEY, lead.id, lead.last_activity_at, taskId]
      );
      await client.query(
        `INSERT INTO task_notifications(user_id,task_id,kind)
         VALUES($1,$2,'assigned') ON CONFLICT DO NOTHING`,
        [lead.salesman_id, taskId]
      );
      await client.query(
        `INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
         VALUES(NULL,'automation.inactive_follow_up','lead',$1,$2::jsonb)`,
        [lead.id, JSON.stringify({
          ruleKey: RULE_KEY,
          inactivityDays: rule.inactivityDays,
          taskId,
          recipientId: lead.salesman_id,
        })]
      );
      await client.query("COMMIT");
      created += 1;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  return { enabled: true, created, eligible: leads.length, inactivityDays: rule.inactivityDays };
}

module.exports = { RULE_KEY, inactiveRuleFrom, runInactiveLeadFollowUpAutomation };
