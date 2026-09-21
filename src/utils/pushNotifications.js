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
  deal_won: true,
  target_milestone: true,
  day_started_ended: true,
  day_closing_missing: true,
  day_activity_summary: true,
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
  const uniqueIds = [...new Set((userIds || []).filter(Boolean))];
  const diagnostics = {
    requestedUsers: uniqueIds.length,
    eligibleUsers: 0,
    subscribedUsers: 0,
    subscribedDevices: 0,
    preferenceDisabledUsers: 0,
    sent: 0,
    failed: 0,
  };

  if (!ensureConfigured()) {
    console.warn("push notify skipped: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set on this server.");
    return diagnostics;
  }
  if (uniqueIds.length === 0) return diagnostics;

  const { rows: prefRows } = await db.query(
    `SELECT user_id, ${prefKey} AS enabled FROM notification_preferences WHERE user_id = ANY($1::uuid[])`,
    [uniqueIds]
  );
  const prefMap = new Map(prefRows.map((r) => [r.user_id, r.enabled]));
  const eligibleIds = uniqueIds.filter((id) => (prefMap.has(id) ? prefMap.get(id) : PREF_DEFAULTS[prefKey]));
  diagnostics.eligibleUsers = eligibleIds.length;
  diagnostics.preferenceDisabledUsers = uniqueIds.length - eligibleIds.length;
  if (eligibleIds.length === 0) return diagnostics;

  const { rows: subs } = await db.query(
    `SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::uuid[])`,
    [eligibleIds]
  );
  diagnostics.subscribedDevices = subs.length;
  diagnostics.subscribedUsers = new Set(subs.map((x) => x.user_id)).size;
  if (subs.length === 0) {
    console.warn(`push notify: no subscribed devices found for ${eligibleIds.length} eligible user(s) (pref: ${prefKey}).`);
    return diagnostics;
  }

  const body = JSON.stringify(payload);
  const results = await Promise.all(subs.map(async (sub) => {
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
  }));
  diagnostics.sent = results.filter((x) => x === "sent").length;
  diagnostics.failed = results.filter((x) => x === "failed").length;
  console.log(`push notify: ${prefKey} → ${diagnostics.sent}/${results.length} sent`);
  return diagnostics;
}

/** All active admin user IDs — used for pipeline-movement alerts. */
async function getAdminIds() {
  const { rows } = await db.query(`SELECT id FROM users WHERE role = 'admin' AND is_active = true`);
  return rows.map((r) => r.id);
}

const STATUS_PREF_KEY = { hot: "hot_lead", conversation: "status_conversation", negotiation: "status_negotiation", demo: "status_demo", won: "deal_won" };
const STATUS_LABEL = { conversation: "Conversation", negotiation: "Negotiation", demo: "Demo", won: "Won" };

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
  } else if (status === "won") {
    const amount = Number(lead.deal_value || 0);
    const amountText = amount > 0 ? ` · ₹${amount.toLocaleString("en-IN")}` : "";
    await notifyUsers(adminIds, prefKey, {
      title: "🎉 Deal Won",
      body: `${lead.business_name}${amountText}`,
      url,
    });
    if (lead.salesman_id) await notifyTargetMilestones(lead.salesman_id);
  } else {
    await notifyUsers(adminIds, prefKey, {
      title: isNew ? `New deal in ${STATUS_LABEL[status]}` : `Deal moved to ${STATUS_LABEL[status]}`,
      body: isNew ? `${lead.business_name} was added directly in ${STATUS_LABEL[status]}.` : `${lead.business_name} is now in ${STATUS_LABEL[status]}.`,
      url,
    });
  }
}

async function notifyTargetMilestones(salesmanId) {
  try {
    const { rows } = await db.query(`
      WITH b AS (SELECT date_trunc('month',(now() AT TIME ZONE 'Asia/Kolkata')::date)::date AS month),
      wins AS (
        SELECT count(DISTINCT al.entity_id)::int won, coalesce(sum(l.deal_value),0)::numeric sales
        FROM activity_logs al JOIN leads l ON l.id=al.entity_id CROSS JOIN b
        WHERE al.actor_id=$1 AND al.action='lead.status_changed' AND al.metadata->>'to'='won'
          AND (al.created_at AT TIME ZONE 'Asia/Kolkata')::date >= b.month
      )
      SELECT u.full_name,b.month,coalesce(t.won_target,0)::int won_target,coalesce(t.sales_value_target,0)::numeric sales_target,w.won,w.sales
      FROM users u CROSS JOIN b CROSS JOIN wins w LEFT JOIN sales_targets t ON t.salesman_id=u.id AND t.month=b.month
      WHERE u.id=$1`, [salesmanId]);
    const r=rows[0]; if(!r) return;
    const adminIds=await getAdminIds();
    for (const [kind,actual,target,label] of [["deals",Number(r.won),Number(r.won_target),"Deals"],["sales",Number(r.sales),Number(r.sales_target),"Sales"]]) {
      if(target<=0) continue;
      for(const pct of [80,100]) {
        if(actual < target*pct/100) continue;
        const key=`${kind}:${pct}:${r.month}`;
        const exists=await db.query(`SELECT 1 FROM activity_logs WHERE actor_id=$1 AND action='target.milestone_notified' AND metadata->>'key'=$2 LIMIT 1`,[salesmanId,key]);
        if(exists.rows.length) continue;
        const value=kind==='sales'?`₹${actual.toLocaleString('en-IN')} / ₹${target.toLocaleString('en-IN')}`:`${actual} / ${target}`;
        await notifyUsers(adminIds,"target_milestone",{title:pct===100?"🏆 Monthly target achieved":`🎯 ${pct}% target milestone`,body:`${r.full_name} · ${label} ${value}`,url:"/"});
        await db.query(`INSERT INTO activity_logs(actor_id,action,entity_type,metadata) VALUES($1,'target.milestone_notified','user',$2::jsonb)`,[salesmanId,JSON.stringify({key,kind,pct,month:r.month})]);
      }
    }
  } catch(err) { console.error("target milestone push failed:",err.message); }
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
  const today = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
  const { rows: renewalsToday } = await db.query(`SELECT id,business_name,salesman_id FROM leads WHERE renewal_date = ${today}`);
  const { rows: renewalsSoon } = await db.query(`SELECT id,business_name,salesman_id FROM leads WHERE renewal_date = ${today} + 3`);
  const { rows: followUpsToday } = await db.query(`SELECT id,business_name,salesman_id FROM leads WHERE next_follow_up_date = ${today}`);
  const empty=()=>({requestedUsers:0,eligibleUsers:0,subscribedUsers:0,subscribedDevices:0,preferenceDisabledUsers:0,sent:0,failed:0});
  const delivery={renewalToday:empty(),renewalSoon:empty(),followUpToday:empty()};
  const add=(b,x)=>{for(const k of Object.keys(b)) b[k]+=Number(x?.[k]||0);};
  for(const lead of renewalsToday) add(delivery.renewalToday,await notifyUsers([lead.salesman_id].filter(Boolean),"renewal_due",{title:"Renewal due today",body:`${lead.business_name}'s renewal is due today.`,url:"/"}));
  for(const lead of renewalsSoon) add(delivery.renewalSoon,await notifyUsers([lead.salesman_id].filter(Boolean),"renewal_due",{title:"Renewal coming up",body:`${lead.business_name} renews in 3 days.`,url:"/"}));
  for(const lead of followUpsToday) add(delivery.followUpToday,await notifyUsers([lead.salesman_id].filter(Boolean),"follow_up_due",{title:"Follow-up due today",body:`Time to follow up with ${lead.business_name}.`,url:"/"}));
  return {renewalsToday:renewalsToday.length,renewalsSoon:renewalsSoon.length,followUpsToday:followUpsToday.length,delivery};
}

/**
 * A once-a-day digest for admins summarising which employees started their
 * day today and when, and who hasn't started yet. Meant to run once around
 * 1pm (see /notifications/run-noon-digest, called by the same free
 * scheduler as the renewal/follow-up reminders).
 */
async function runNoonDigest() {
  const {rows}=await db.query(`SELECT u.full_name,a.start_day_at FROM users u LEFT JOIN (
    SELECT salesman_id,MIN(start_day_at) AS start_day_at FROM attendance
    WHERE day=(now() AT TIME ZONE 'Asia/Kolkata')::date GROUP BY salesman_id
  ) a ON a.salesman_id=u.id WHERE u.role='salesman' AND u.is_active=true ORDER BY u.full_name ASC`);
  if(!rows.length) return {sent:0,failed:0,employeeCount:0,reason:"no active employees"};
  const lines=rows.map(r=>!r.start_day_at?`${r.full_name}: not started`:`${r.full_name}: ${new Date(r.start_day_at).toLocaleTimeString("en-IN",{hour:"numeric",minute:"2-digit",timeZone:"Asia/Kolkata"})}`);
  const adminIds=await getAdminIds();
  const delivery=await notifyUsers(adminIds,"day_start_digest",{title:"Today's day-start report",body:lines.join(" · "),url:"/"});
  return {...delivery,employeeCount:rows.length,adminCount:adminIds.length};
}

/**
 * Instant push to admins when an employee starts / ends their day.
 * Never throws — a push problem must not make Start Day / End Day fail.
 * Call it AFTER the DB transaction has committed.
 */
async function notifyDayEvent({ userId, kind, sessionNumber = 1, closingStatus = null, summary = null }) {
  try {
    const { rows } = await db.query(`SELECT full_name FROM users WHERE id = $1`, [userId]);
    const name = rows[0]?.full_name || "An employee";
    const time = new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
    const session = sessionNumber > 1 ? ` (session ${sessionNumber})` : "";
    const started = kind === "start";
    const adminIds = await getAdminIds();
    await notifyUsers(adminIds, "day_started_ended", {
      title: started ? "Day started" : "Day ended",
      body: `${name} ${started ? "started" : "ended"} their day at ${time}${session}.`, url: "/",
    });
    if (!started && closingStatus === "skipped") {
      await notifyUsers(adminIds, "day_closing_missing", {title:"Day Closing missing",body:`${name} ended the day without submitting Day Closing.`,url:"/"});
    }
    if (!started && closingStatus === "submitted" && summary) {
      const parts=[`${summary.leads||0} leads`,`${summary.followups||0} follow-ups`,`${summary.demos||0} demos`,`${summary.quotes||0} quotes`,`${summary.won||0} won`];
      if(Number(summary.sales_value||0)>0) parts.push(`₹${Number(summary.sales_value).toLocaleString('en-IN')} sales`);
      await notifyUsers(adminIds,"day_activity_summary",{title:`📊 ${name} — Day Closed`,body:parts.join(" · "),url:"/"});
    }
    return { sent: true };
  } catch (err) {
    console.error("day event push failed:", err.message);
    return { sent: 0, failed: 0 };
  }
}

module.exports = { notifyUsers, getAdminIds, notifyStatusChange, runDailyReminders, runNoonDigest, notifyDayEvent, notifyTargetMilestones };
