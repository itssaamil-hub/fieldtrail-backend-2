# Quotations update

This is the complete project with existing notifications, tasks, lead briefs, reports and onboarding preserved.

## Deploy

1. Deploy the backend first. `npm start` runs the pending migrations, including `021_quotations.sql` and `022_day_closing.sql`, automatically, then starts the server. If using a custom start command, run `npm run migrate` before starting it.
2. Deploy the frontend. Keep the existing backend URL and environment variables.
3. Admin: Menu → Settings → Quotation settings. Add packages/prices, optional add-ons, currency, logo, discount limit, quote validity and terms. Packages start empty deliberately; add your real prices.
4. Salesman: Menu → Quotations → Create quotation. Choose an assigned lead or enter a new customer. A new quotation customer is not automatically added as a CRM lead.
5. Admin: Menu → Quotation approvals. Requests above the configured discount limit also appear in the notification bell.

## Sharing and tracking

- Server computes totals from admin prices; discounts apply to the package only. Tax is optional, configured by admin, and applied after discounts. The total covers the first billing period of recurring items plus one-time charges.
- Quotes retain their original prices, customer details, branding and terms. Revisions use current admin settings and keep earlier PDFs in history.
- A quote above the limit requires admin approval, including if created by admin. Approval, price updates and revisions use version checks and database transactions.
- Download the PDF and attach it manually in WhatsApp. The WhatsApp button prefills text only. No customer sharing link or automatic message sending.
- Mark sent manually after sending. Record customer response manually; this does not change the lead pipeline status.
- Expired unaccepted quotes require a new revision before WhatsApp sharing or marking sent. Previously approved PDFs can still be downloaded as records.
- Quotation alerts appear in the existing bell. Daily follow-up alerts for sent quotes use the existing POST `/notifications/run-daily-reminders` cron job and existing credentials. No new cron or environment variables. These are in-app alerts, not new operating-system push notifications.
- Salesmen see their own quotation records. Existing-lead selection is restricted to their assigned leads; admin can access all quotes.
- PNG/JPEG logos: maximum 200 KB and 2000 × 2000 pixels. Settings allow up to 30 packages and 30 add-ons.

## Validation

30 backend tests passed, including quotation authorization/approval, price snapshots, revisions, PDF output and existing feature tests. Frontend production build and DOM interaction checks passed; sample and multi-page PDFs were rendered for visual review. A real PostgreSQL migration and deployed/mobile browser flow have not been run in this workspace.

## Enhanced quotation update

- Admin dashboard: Total Employees includes Active Now. The freed card shows Conversation leads, counted across the database. Clicking shows up to the latest 500 matching leads, using the existing lead dialog.
- Quotation filters: all dates, this month, last month, selected month with previous/next controls, and inclusive custom date ranges. Based on original quotation creation date in Asia/Kolkata, not revision creation date.
- Details → ⋮ → Delete quotation: permanent deletion after confirmation. No archive or recovery in the app. Deletes all revisions, event history and bell alerts. Already downloaded PDFs are unaffected. Salesmen may delete their own quotes only if no revision was sent; admin may delete any quote. Stale versions cannot be deleted until reloaded.
- Preview PDF before sharing (with open/download fallback for browsers without embedded PDF support). New pricing table, included-feature checklist, prominent total, advance required, and remaining-after-advance figures. These are payment terms, not a payment-received tracker.
- Admin quotation settings now include company contact and support contact text. They are copied into new quotes/revisions; old quote data remains unchanged.
- The earlier quotation-only enhancement needed no extra migration beyond 021. This release also requires 022 as described below. Deploy backend first, then frontend.
- Existing Brief is unchanged; no Restaurant Timeline added.
- Backend tests and DOM interaction checks cover permanent-delete authorization, stale versions, date validation, leap-year month navigation, preview, and cancellation. No live database or real-device deployment test was performed.


## Employee Settings and Day Closing update

- Admin dashboard → Salesmen → Settings on each employee card. Settings replaces the separate Edit/Delete buttons and contains Edit employee, Delete employee and three employee-specific Day Closing switches. The existing delete confirmation remains.
- Require Day Closing defaults OFF, Allow skip defaults OFF, Require skip reason defaults ON. Changes only affect the selected employee and are checked server-side when they end their day. Admin settings use version checks to prevent overwriting another admin's changes.
- If closing is required: Submit report & End Day requires outcomes and tomorrow's priorities. Blockers are optional. With Allow skip enabled, an employee may skip; a reason is mandatory when Require reason is enabled.
- If closing is optional: the employee may submit a report or choose End Day without report. That record is marked Not required; it is not treated as a skipped required report.
- Salesman End Day opens the closing form. Save draft keeps the day active. Report saving, attendance closing and activity recording commit together; a failed write leaves the day active. Direct End Day API calls must obey the same permissions.
- Admin Reports → Day Closing reports: date and employee filters; submitted, skipped, draft/not submitted and not required statuses. Salesman menu → My Daily Reports only returns their own records. There is no new cron or external API.
- Recorded daily activity includes leads currently assigned to the employee and created that date, their completed tasks, quotes they marked sent and deals they marked won. These are recorded CRM metrics, not independently verified activity.
- Attendance and report dates use Asia/Kolkata (IST), including when the server runs in UTC. An unfinished prior day is closed against its original date. A finalized day cannot be restarted on the same date; repeated end requests are idempotent. The next date allows a new day.
- Deploy backend first. `npm start` applies migration 022 automatically. For a custom start command run `npm run migrate` first. Then deploy the complete frontend and refresh installed PWA clients.

## Quotation quantities and module features

- Admin quotation settings: each package and add-on has optional Included features (one per line).
- Create/revise quotation: choose package quantity / outlets and each selected add-on's quantity (whole numbers 1–1000). Prices stay controlled by admin. Add-on quantities are separate, so use 2 for each module intended for two outlets.
- Server calculates unit price × quantity; the package percentage discount applies to all package units. Tax applies after discount. Existing saved revisions retain their prices and totals; missing historical quantities display as 1.
- Details and PDF show quantities, unit prices and line totals. Each module's features appear directly below that module. The requested billing-period sentence has been removed from the customer quote.
- PDF tries a compact readable layout if a regular layout exceeds one page. The included two-outlet example fits one page. Very long feature lists continue onto additional pages, keeping all details; no arbitrary truncation or tiny font to force one page.
- Brief remains unchanged, as requested. No quotation text was added to Brief.

## Verification of this update

30 backend tests pass, including policy combinations, required-report bypass prevention, skip-reason checks, stale settings/drafts, rollback on failed end, quantity validation and original feature tests. Frontend production build and DOM interaction checks pass for employee settings/edit/delete, draft and closing actions, skip reasons, admin/personal reports, quote quantities and existing quotation flows. The one-page example and a 360-feature multi-page stress PDF were checked; all features were preserved. Database queries were tested with mocks; migration 022 has not been run against your live PostgreSQL database. No deployment or real-device browser test was performed here.
