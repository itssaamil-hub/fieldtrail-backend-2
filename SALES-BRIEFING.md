# Daily Sales Briefing

A free, rule-based sales summary. No AI API key or paid AI service is required. This is deterministic prioritization, not a language model.

## Deploy and schedule

1. Deploy this backend using your existing Render workflow. The existing `npm start` runs migration 015 automatically. If your deployment uses a different start command, run `npm run migrate` before starting the server.
2. Keep your existing DATABASE_URL, CRON_SECRET and VAPID settings. Optionally set BRIEFING_TIMEZONE=Asia/Kolkata (the default).
3. Add a daily cron-job.org job at 9:00 AM, with the scheduler timezone set to Asia/Kolkata.
4. Use POST to https://fieldtrail-backend.onrender.com/notifications/run-sales-briefing and add the header `x-cron-secret` with your existing CRON_SECRET value. The existing `?secret=YOUR_SECRET` convention is also supported.
5. Run the job once to inspect its response. sentUsers counts users with at least one accepted device push; sentDevices counts accepted pushes. skippedUsers counts already-sent or otherwise skipped users. failedUsers counts failures. A zero count can mean there are no active, subscribed salesmen with the preference enabled. It is not proof of delivery.

Only active salesmen with subscribed devices and the salesBriefing preference enabled receive the morning notification. Preferences default to enabled, consistent with the existing notification settings. Keep the daily-reminder and noon-digest jobs as they are.

A database record and per-user advisory lock prevent ordinary duplicate sends and overlapping cron requests. Failed sends with no successful devices are retryable. If one device succeeds and another fails, the user is marked sent for that day. A process crash after push acceptance but before recording delivery can still cause a retry duplicate; browser notification tags can help if your service worker forwards them. Push-service acceptance does not guarantee the device displayed it.

## Frontend integration

GET /notifications/sales-briefing with the current user's Authorization: Bearer token returns `{ briefing: { date, timeZone, mode, counts, greeting, paragraphs, focus, summary, notificationBody, priorityLeads, recommendation } }`.

- Salesmen can retrieve only their own briefing.
- Admins can request an active salesman's briefing with `?salesmanId=UUID`.
- counts includes followUpsToday, overdueFollowUps, demoStageLeads, and activeLeads.
- priorityLeads includes up to five leads with id, business_name, contact_name, phone, status, next_follow_up_date, score, and reasons.
- The matching frontend adds a bell next to Settings. It opens a Notifications panel with greeting, paragraphs, focus, and priority contacts. Salesmen can open the existing lead drawer; admins can select an active employee and inspect their briefing.
- GET /notifications/preferences includes salesBriefing.
- PATCH /notifications/preferences with `{ "salesBriefing": false }` disables the morning push for the signed-in user. The briefing API remains available.
- Notification clicks use `/#sales-briefing`. Both new windows and existing tabs open the Notifications panel. The hash is retained through sign-in. This shows the latest CRM briefing, not an archived copy of an earlier notification.
- The full briefing is fetched when the panel opens. Offline and failed requests show a retry state; no fabricated or locally cached customer data is shown.
- Greetings are time-neutral ("Hello, Anand!") because the panel can be opened at any hour. Templates handle zero/singular counts and only mention dates/statuses present in CRM data.

Counts use active leads only (won/lost excluded). Demo count means leads in demo/demo_scheduled stage; the database has no separate demo appointment date, so this is not a count of appointments today. Today's follow-ups and overdue follow-ups are separate counts.

Priority points: overdue follow-up 100; due today 80; hot 40; negotiation 30; demo stage 20. Points add together. Leads with an explicitly future follow-up are excluded from today's priority contacts. Ties use oldest follow-up, then lead ID. Only positive-score leads appear, so fewer than five is possible. The briefing reads current data each time.

## Validation

Run `node --test test/salesBriefing.test.js` (Node 18+). Nine tests cover timezone boundaries, closed lead exclusion, demo-stage counts, priority order, future follow-ups, empty data, daily duplicate/concurrency checks, failed-send retry eligibility, natural-language wording, and future-only appointments. Scheduler tests use mocked database/push dependencies. JavaScript syntax checks also passed.

A live PostgreSQL migration and real device delivery have not been tested here because production database credentials and devices were not provided. Deploying and scheduling remain required; this ZIP does not change your live server.
