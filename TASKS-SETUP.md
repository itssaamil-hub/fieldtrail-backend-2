# Tasks update

## Included
- Admin dashboard: Team Tasks, assignment to active employees, completion and result notes.
- Salesman dashboard: My Tasks directly below Messages, with pending count; employees can create their own tasks and complete only their own tasks.
- Lead details: + Add task links the lead automatically and uses its assigned salesman. Queued/offline leads must sync first.
- All / Today / Upcoming / Overdue / Completed views, 50 tasks per page.
- Explicit IST due-date input/display, stored as timestamptz; Overdue means past the precise due time, including earlier today.
- Assignment alerts and daily task reminders in the existing notification bell. Clicking an alert opens that exact task; unread task alerts contribute to the employee bell badge.
- Task creation/completion appears in admin Activity. Completion is idempotent and saves the optional result note.
- Existing notification features and compact, animated lead Brief remain included.

## Deployment
1. Deploy backend first using the existing npm start command. It runs migrations automatically, including 018_tasks.sql. If your start command bypasses migration, run npm run migrate first.
2. Deploy frontend using the existing build/environment settings.
3. Keep your existing authenticated POST /notifications/run-daily-reminders cron job. It now also creates task reminders; no extra cron job or secret is needed.

Task reminders are in-app bell alerts, created once per pending due/overdue task per IST calendar day when the daily cron runs. They are not exact-time device push alarms. Assignments appear immediately in the database; dashboard and bell badges refresh within 60 seconds or after local task actions. The existing push settings remain unchanged.

This version supports creation and completion, not reassignment, editing, deletion, or recurring tasks. Lead-linked tasks are created from the lead detail screen; the main Tasks screen creates standalone tasks. No existing follow-up dates are changed.

## Verification
- Production frontend build passed.
- 23 backend tests passed, including HTTP routing/authentication with a mocked database, employee ownership, validation, audit transaction rollback, completion idempotency, reminders and existing briefing/activity behavior.
- jsdom interaction checks passed: admin assignment, IST conversion, employee self-assignment, lead linking, completion notes, task alert opening and error retry.
- A live PostgreSQL migration and deployed mobile browser were not available for testing here.
