# Admin notification activity feed

Deploy this backend first, then the matching frontend. Keep your existing Render settings and cron jobs. npm start applies migration 016 automatically; for custom start commands run npm run migrate before starting the app. No new environment variables, AI API, cron schedule or push subscription is needed.

The admin notification panel now has a Brief / Activity slider beside Close. Brief stays the default. Activity shows all employees and admins, newest first, rather than filtering by the employee selected for a briefing. It loads when opened or refreshed and offers Load older activity in pages of 30. It does not poll in the background or create additional push notifications.

GET /notifications/activity requires normal authentication and the admin role. It accepts an optional opaque cursor from the previous response. Response: activities (id, action, actorName, businessName, description, fromStatus, toStatus, createdAt) and nextCursor. Invalid cursors return 400, unauthenticated requests 401, salesmen 403.

Activity uses existing activity_logs: lead creation by admin/salesman, lead edits and deletion, deal status changes including Hot, day starts/ends, employee creation/update/removal, message send/broadcast, and CRM settings changes. No-op status transitions are omitted. Existing historical logs appear immediately; actions never logged in the past cannot be reconstructed. Future salesman lead-detail edits are now logged too.

Lead names are saved with new lead-related events so they remain understandable after a lead is deleted. Older events fall back to current records; a deleted record without a saved name is labeled as removed. Deleted users without names are labeled Former user. Dates are displayed in the viewer's local timezone.

Only display-safe fields are returned. Raw audit metadata, passwords, message contents and GPS details are not exposed by this endpoint. This is an activity view, not a new complete audit system for payments, expenses or every database change.

The uploaded repository also contains legacy frontend files. Those files are preserved; deploy the separate frontend ZIP for the notification UI.

Validation: node --test test/*.test.js; JavaScript syntax checks. Production database migration and live deployment have not been executed here.


## Unread badge update

The bell now matches Settings (30 × 30 button, 14px icon). A small red count sits above it; zero is hidden and values above 99 display 99+.

Admins: the count covers new Activity events. Opening Brief does not clear Activity. Loading the newest Activity page marks events through the newest displayed event as seen, including older pages; later arrivals remain unread. Refresh the Activity feed to see and acknowledge subsequent events.

Salesmen: the badge indicates today's delivered daily briefing until it is opened. It does not count every legacy reminder/status push or previous days' briefings. A briefing opened before it was delivered does not pre-clear the future notification.

Read state is saved per user in PostgreSQL and shared across their devices. Existing historical activity is not turned into an unread backlog when this migration is installed. Existing activity stays available in the feed. The badge refreshes once per minute while the app is visible, on focus, and after a read receipt. No new cron job is needed.

Deploy backend first: migration 017 creates notification_read_state. The normal npm start applies migrations. Then deploy the updated frontend and refresh the installed app. Production migrations/device behavior have not been run here.

Checks: 20 backend tests; frontend production build; DOM checks of badge 1 → 0, 30px button/14px icon, panel navigation, slider/pagination/retry and role isolation.
