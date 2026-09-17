# Quotations update

This is the complete project with existing notifications, tasks, lead briefs, reports and onboarding preserved.

## Deploy

1. Deploy the backend first. `npm start` runs the new `021_quotations.sql` migration automatically, then starts the server. If using a custom start command, run `npm run migrate` before starting it.
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

27 backend tests passed, including quotation authorization/approval, price snapshots, revisions, PDF output and existing feature tests. Frontend production build and DOM interaction checks passed; sample and multi-page PDFs were rendered for visual review. A real PostgreSQL migration and deployed/mobile browser flow have not been run in this workspace.
