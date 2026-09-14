const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { runDailyReminders } = require("../utils/pushNotifications");

const router = express.Router();

// POST /notifications/run-daily-reminders — called once a day by a Render
// Cron Job, which has no user session, so this checks a shared secret
// instead of a Bearer token. Deliberately registered before requireAuth
// below so it isn't swept up by that middleware.
router.post("/run-daily-reminders", async (req, res) => {
  const secret = req.query.secret || req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const result = await runDailyReminders();
  res.json({ ok: true, ...result });
});

router.use(requireAuth);

// GET /notifications/vapid-public-key — the frontend needs this to create a
// PushSubscription via the browser's Push API. Public by design (it's a
// public key), but kept behind auth here for consistency with the rest of
// the API surface.
router.get("/vapid-public-key", (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ error: "Push notifications aren't configured on this server yet." });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /notifications/subscribe — save (or refresh) this device's push subscription
router.post("/subscribe", async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: "Invalid subscription." });

  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [req.user.id, endpoint, keys.p256dh, keys.auth]
  );

  // Make sure a preferences row exists so the Settings screen has something to show/edit.
  await db.query(`INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [req.user.id]);

  res.status(201).json({ ok: true });
});

// DELETE /notifications/subscribe — stop notifying this device
router.delete("/subscribe", async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "Missing endpoint." });
  await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [endpoint, req.user.id]);
  res.json({ ok: true });
});

// GET /notifications/preferences
router.get("/preferences", async (req, res) => {
  const { rows } = await db.query(`SELECT * FROM notification_preferences WHERE user_id = $1`, [req.user.id]);
  const p = rows[0];
  res.json({
    preferences: {
      hotLead: p ? p.hot_lead : true,
      statusConversation: p ? p.status_conversation : true,
      statusNegotiation: p ? p.status_negotiation : true,
      statusDemo: p ? p.status_demo : true,
      renewalDue: p ? p.renewal_due : true,
      followUpDue: p ? p.follow_up_due : true,
    },
  });
});

// PATCH /notifications/preferences — partial update; only send the keys you're changing
router.patch("/preferences", async (req, res) => {
  const { rows } = await db.query(`SELECT * FROM notification_preferences WHERE user_id = $1`, [req.user.id]);
  const current = rows[0] || {
    hot_lead: true, status_conversation: true, status_negotiation: true,
    status_demo: true, renewal_due: true, follow_up_due: true,
  };
  const body = req.body || {};
  const merged = {
    hot_lead: body.hotLead != null ? !!body.hotLead : current.hot_lead,
    status_conversation: body.statusConversation != null ? !!body.statusConversation : current.status_conversation,
    status_negotiation: body.statusNegotiation != null ? !!body.statusNegotiation : current.status_negotiation,
    status_demo: body.statusDemo != null ? !!body.statusDemo : current.status_demo,
    renewal_due: body.renewalDue != null ? !!body.renewalDue : current.renewal_due,
    follow_up_due: body.followUpDue != null ? !!body.followUpDue : current.follow_up_due,
  };

  await db.query(
    `INSERT INTO notification_preferences (user_id, hot_lead, status_conversation, status_negotiation, status_demo, renewal_due, follow_up_due)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id) DO UPDATE SET
       hot_lead = EXCLUDED.hot_lead, status_conversation = EXCLUDED.status_conversation,
       status_negotiation = EXCLUDED.status_negotiation, status_demo = EXCLUDED.status_demo,
       renewal_due = EXCLUDED.renewal_due, follow_up_due = EXCLUDED.follow_up_due, updated_at = now()`,
    [req.user.id, merged.hot_lead, merged.status_conversation, merged.status_negotiation, merged.status_demo, merged.renewal_due, merged.follow_up_due]
  );
  res.json({ ok: true });
});

module.exports = router;
