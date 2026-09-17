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
1. Deploy the backend first. The existing npm start command runs migrations, including 019_onboarding.sql and 020_onboarding_sharing.sql. If your custom start command bypasses migration, run npm run migrate first.
2. Deploy the complete frontend using the existing configuration.
3. No new environment variables, cron job, AI service or messaging provider are needed.

All previous task, task deletion, notification, lead Brief and Deal Value report features remain included. The bundled DejaVu font is used for PDF output; its license is included in src/assets.

## Validation
Production frontend build passed. All 25 backend tests passed (HTTP route/authentication tests use a mocked database). jsdom checks covered the menu, starting checklists, completion gating, WhatsApp preview, conflicting edits, employee restrictions, template editing and reordering. Existing notification interactions were also checked. A generated PDF was rendered and visually checked. Live PostgreSQL migration and a deployed mobile browser were not tested here.

## Customize sharing wording
Admin: Menu -> Settings -> Edit onboarding checklist -> WhatsApp & PDF wording. Edit Heading, Opening message, and Closing message/support contact. Use {restaurant} and {owner} placeholders; missing owner names become “there”. The completed checklist and completion dates are always included automatically. The same wording is used in WhatsApp and PDF. Defaults say the restaurant is now live; share that wording only after the account is actually live. No go-live date is invented or inferred.

Sharing wording applies to newly generated summaries for all customers, including existing checklists. Previously sent messages and downloaded PDFs do not change. Template steps still apply only to new checklists. Settings use version checks to prevent silently overwriting concurrent edits. Existing clients that save only steps preserve the saved wording.

This update needs migration 020_onboarding_sharing.sql. Backend starts with migrations automatically under the existing npm start command. Deploy backend, then frontend. Custom-wording backend and frontend checks passed; the generated PDF text was checked for substituted names and saved wording. Live migration remains untested here.

## Checklist-style PDF
PDF exports now use an Engage header, restaurant and assigned-salesman details, completed badge, progress bar, checked step rows and completion dates. The editable heading/opening/closing from admin settings remain in the PDF and WhatsApp. PDFs are still generated only after all steps are complete, so the progress shown is the actual completed count, never the preview's sample 7/9. Internal notes remain excluded. Long checklists continue over numbered pages. The app screen and frontend are unchanged by this PDF-only update. Public owner links and the abandoned separate live-status feature are not included. No migration beyond 020 is needed for this layout change.

Validation: onboarding HTTP and sharing tests passed. A nine-step PDF and a thirty-step multi-page PDF were generated and visually checked.
