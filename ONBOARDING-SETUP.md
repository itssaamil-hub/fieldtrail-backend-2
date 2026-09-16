# Customer onboarding

## Where to find it
- The old Settings icon is now a three-line Menu button of the same 30px size.
- Menu -> Onboarding checklist: customer setup progress.
- Menu -> Settings: all existing settings.
- Admin only: Settings -> Edit onboarding checklist.

## Customer checklists
Won leads appear in the list. Click Start onboarding to create a snapshot of the current template. Checklists start on this explicit action, not automatically when a lead becomes Won. Existing checklists stay available even if the lead status changes later. Admins see all customers; salesmen see and update only leads currently assigned to them. The lead's salesman is responsible for its checklist; per-step assignees and due dates are not part of this version.

All steps are required. Each step saves completion time, completing user, and optional internal notes. Completion is manual; payment and printer checks are not inferred automatically from other CRM data. Unchecking a step clears its completion information. Optimistic version checks reject stale updates instead of overwriting another user's work. Use Refresh when a conflict is reported.

Admins can add, rename, reorder and remove template steps (1-30). Template edits affect only new customer checklists; existing steps and progress remain intact.

## Share with the restaurant owner
After all steps are complete, admin chooses Share completion summary and reviews it. Owner phone numbers can be adjusted in the preview (country code required; a stored 10-digit Indian number is prefixed with 91). Open WhatsApp prepares the message; the user must tap Send. No message is sent automatically. Download PDF produces a branded summary with completion dates. Internal notes and user IDs are excluded from both outputs. Sharing is a dated snapshot; later checklist edits do not update previously shared messages/PDFs. There is no public link or owner login in this version.

## Deploy
1. Deploy the backend first. The existing npm start command runs migrations, including 019_onboarding.sql. If your custom start command bypasses migration, run npm run migrate first.
2. Deploy the complete frontend using the existing configuration.
3. No new environment variables, cron job, AI service or messaging provider are needed.

All previous task, task deletion, notification, lead Brief and Deal Value report features remain included. The bundled DejaVu font is used for PDF output; its license is included in src/assets.

## Validation
Production frontend build passed. All 25 backend tests passed (HTTP route/authentication tests use a mocked database). jsdom checks covered the menu, starting checklists, completion gating, WhatsApp preview, conflicting edits, employee restrictions, template editing and reordering. Existing notification interactions were also checked. A generated PDF was rendered and visually checked. Live PostgreSQL migration and a deployed mobile browser were not tested here.
