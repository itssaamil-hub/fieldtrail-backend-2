const webpush = require("web-push");
const db = require("../db");

const PREF_DEFAULTS = {
  hot_lead: true,
  status_conversation: true,
  status_negotiation: true,
  status_demo: true,
  renewal_due: true,
  follow_up_due: true,
  day_start_digest: true,
  sales_briefing: true,
  day_activity: true,
};

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT || "mailto:admin@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

/**
 * Sends a push notification to every subscribed device for a set of users,
 * but only to users who have the given preference key turned on (or who
 * have no preferences row at all, since the column defaults cover that).
 * Dead subscriptions (410/404 from the push service) are cleaned up as we go.
 */
async function notifyUsers(userIds, prefKey, payload) {
  if (!ensureConfigured()) {
    console.warn("push notify skipped: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set on this server.");
    return { sent: 0, failed: 0 };
  }
  if (userIds.length === 0) return { sent: 0, failed: 0 };

  const { rows: prefRows } = await db.query(
    `SELECT user_id, ${prefKey} AS enabled FROM notification_preferences WHERE user_id = ANY($1::uuid[])`,
    [userIds]
  );
  const prefMap = new Map(prefRows.map((r) => [r.user_id, r.enabled]));
  const eligibleIds = userIds.filter((id) => (prefMap.has(id) ? prefMap.get(id) : PREF_DEFAULTS[prefKey]));
  if (eligibleIds.length === 0) return { sent: 0, failed: 0 };

  const { rows: subs } = await db.query(`SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::uuid[])`, [eligibleIds]);
  if (subs.length === 0) {
    console.warn(`push notify: no subscribed devices found for ${eligibleIds.length} eligible user(s) (pref: ${prefKey}). They may not have turned on push in Settings yet.`);
    return { sent: 0, failed: 0 };
  }

  const body = JSON.stringify(payload);
  const results = await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body);
        return "sent";
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
          console.warn(`push notify: removed dead subscription (${err.statusCode}) for user ${sub.user_id}`);
        } else {
          console.error(`push notify: send failed for user ${sub.user_id}:`, err.statusCode || err.message);
        }
        return "failed";
      }
    })
  );
  console.log(`push notify: ${prefKey} → ${results.filter((r) => r === "sent").length}/${results.length} sent`);
  return { sent: results.filter(r => r === "sent").length, failed: results.filter(r => r === "failed").length };
}

/** All active admin user IDs — used for pipeline-movement alerts. */
async function getAdminIds() {
  const { rows } = await db.query(`SELECT id FROM users WHERE role = 'admin' AND is_active = true`);
  return rows.map((r) => r.id);
}

const STATUS_PREF_KEY = { hot: "hot_lead", conversation: "status_conversation", negotiation: "status_negotiation", demo: "status_demo" };
const STATUS_LABEL = { conversation: "Conversation", negotiation: "Negotiation", demo: "Demo" };

/**
 * Fires the right notification(s) for a lead status change:
 * - "hot" goes to the owning salesman (a nudge to act fast) and to admins
 *   who want hot-lead alerts.
 * - "conversation"/"negotiation"/"demo" go to admins who want pipeline
 *   visibility for that stage.
 * Anything else is a no-op — not every status change needs a push.
 */
async function notifyStatusChange(lead, { isNew = false } = {}) {
  const status = lead.status;
  const prefKey = STATUS_PREF_KEY[status];
  if (!prefKey) return;

  const adminIds = await getAdminIds();
  const url = "/";

  if (status === "hot") {
    await notifyUsers([lead.salesman_id].filter(Boolean), prefKey, {
      title: isNew ? "🔥 New Hot lead" : "🔥 Lead just went Hot",
      body: `${lead.business_name} needs a follow-up.`,
      url,
    });
    await notifyUsers(adminIds, prefKey, {
      title: "🔥 Hot lead",
      body: isNew ? `${lead.business_name} was added as Hot.` : `${lead.business_name} moved to Hot.`,
      url,
    });
  } else {
    await notifyUsers(adminIds, prefKey, {
      title: isNew ? `New deal in ${STATUS_LABEL[status]}` : `Deal moved to ${STATUS_LABEL[status]}`,
      body: isNew ? `${lead.business_name} was added directly in ${STATUS_LABEL[status]}.` : `${lead.business_name} is now in ${STATUS_LABEL[status]}.`,
      url,
    });
  }
}

/**
 * Checks for leads whose renewal or follow-up date is due, and pushes a
 * reminder to the owning salesman. Meant to run once a day (see the
 * /notifications/run-daily-reminders route, called by a Render Cron Job).
 * Fires for: renewal due today, renewal due in 3 days (a heads-up), and
 * follow-up due today. Leads with only a renewal *month* (no exact date)
 * aren't included here since there's no single day to fire on — they still
 * show up in the Renewals report.
 */
async function runDailyReminders() {
  const { rows: renewalsToday } = await db.query(
    `SELECT id, business_name, salesman_id FROM leads WHERE renewal_date = CURRENT_DATE`
  );
  const { rows: renewalsSoon } = await db.query(
    `SELECT id, business_name, salesman_id FROM leads WHERE renewal_date = CURRENT_DATE + INTERVAL '3 days'`
  );
  const { rows: followUpsToday } = await db.query(
    `SELECT id, business_name, salesman_id FROM leads WHERE next_follow_up_date = CURRENT_DATE`
  );

  for (const lead of renewalsToday) {
    await notifyUsers([lead.salesman_id].filter(Boolean), "renewal_due", {
      title: "Renewal due today",
      body: `${lead.business_name}'s renewal is due today.`,
      url: "/",
    });
  }
  for (const lead of renewalsSoon) {
    await notifyUsers([lead.salesman_id].filter(Boolean), "renewal_due", {
      title: "Renewal coming up",
      body: `${lead.business_name} renews in 3 days.`,
      url: "/",
    });
  }
  for (const lead of followUpsToday) {
    await notifyUsers([lead.salesman_id].filter(Boolean), "follow_up_due", {
      title: "Follow-up due today",
      body: `Time to follow up with ${lead.business_name}.`,
      url: "/",
    });
  }

  return { renewalsToday: renewalsToday.length, renewalsSoon: renewalsSoon.length, followUpsToday: followUpsToday.length };
}

/**
 * A once-a-day digest for admins summarising which employees started their
 * day today and when, and who hasn't started yet. Meant to run once around
 * 1pm (see /notifications/run-noon-digest, called by the same free
 * scheduler as the renewal/follow-up reminders).
 */
async function runNoonDigest() {
  const { rows } = await db.query(
    `SELECT u.full_name, a.start_day_at
     FROM users u
     LEFT JOIN (
       SELECT salesman_id, MIN(start_day_at) AS start_day_at FROM attendance WHERE day = CURRENT_DATE GROUP BY salesman_id
     ) a ON a.salesman_id = u.id
     WHERE u.role = 'salesman' AND u.is_active = true
     ORDER BY u.full_name ASC`
  );

  if (rows.length === 0) return { sent: false, reason: "no active employees" };

  const lines = rows.map((r) => {
    if (!r.start_day_at) return `${r.full_name}: not started`;
    const time = new Date(r.start_day_at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
    return `${r.full_name}: ${time}`;
  });

  const adminIds = await getAdminIds();
  await notifyUsers(adminIds, "day_start_digest", {
    title: "Today's day-start report",
    body: lines.join(" · "),
    url: "/",
  });

  return { sent: true, employeeCount: rows.length };
}

/**
 * Instant push to admins when an employee starts / ends their day.
 * Never throws — a push problem must not make Start Day / End Day fail.
 * Call it AFTER the DB transaction has committed.
 */
async function notifyDayEvent({ userId, kind, sessionNumber = 1, closingStatus = null }) {
  try {
    const { rows } = await db.query(`SELECT full_name FROM users WHERE id = $1`, [userId]);
    const name = rows[0]?.full_name || "An employee";
    const time = new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
    const session = sessionNumber > 1 ? ` (session ${sessionNumber})` : "";
    const closing = { submitted: " · closing report submitted", skipped: " · closing report skipped" }[closingStatus] || "";
    const started = kind === "start";
    const adminIds = await getAdminIds();
    return await notifyUsers(adminIds, "day_activity", {
      title: started ? "Day started" : "Day ended",
      body: `${name} ${started ? "started" : "ended"} their day at ${time}${session}${closing}.`,
      url: "/",
    });
  } catch (err) {
    console.error("day event push failed:", err.message);
    return { sent: 0, failed: 0 };
  }
}

module.exports = { notifyUsers, getAdminIds, notifyStatusChange, runDailyReminders, runNoonDigest, notifyDayEvent };
