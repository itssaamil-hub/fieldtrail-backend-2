# Payment collections update

Built from the supplied deployed backend-2-main (17) and frontend-3-main (25) ZIPs.

## Deploy
1. Deploy the complete backend first. `npm start` applies pending migrations automatically, including `042_payment_collections.sql`. With a custom server command, run `npm run migrate` before starting the server.
2. Deploy the complete frontend, keeping the existing backend URL/environment settings. Refresh installed PWA clients after deployment.
3. No new package dependencies, external APIs, payment gateway, cron job or environment variables are required. This feature records payments already received; it does not collect money electronically.

## Where to find it
- Admin and salesman: three-line menu → Payment collections.
- Admin: Reports → Payment due → Collections, receipts & quotation accounts. Existing Won-lead reports and their exports remain available.
- Accepted quotation: Create / open payment account. Pick an optional balance due date; the account starts without a new payment.
- Onboarding checklist: View customer payments opens that lead's account. Checklist completion remains manual.

## Quotation linking
The current revision must be accepted. Its customer details, modules, quantities, branding, currency and agreed total are copied into the account. One account per quotation and one account per linked lead prevent double counting. Repeat conversion opens the existing account; later quotation revisions do not silently change an existing payment agreement.

For a quotation linked to a CRM lead: the lead must be Won, assigned to the salesman (or accessible by admin), use INR, and have a deal value exactly matching the quote total. The API explains any mismatch; it does not silently change lead status or value. Existing partial payments are preserved when linking. A quotation without a lead can create a standalone account in INR, AED or SAR; it does not automatically create a lead or onboarding checklist.

Existing Won leads with a deal value appear without bulk copying old payments. Their first payment/due-date update creates an account as needed. Unlinked accounts continue using the lead's live deal value. Quote-linked accounts use the saved agreed amount even if the lead's forecast value is later edited. Deleting a quotation preserves its payment account and saved agreement.

## Payment records and receipts
- Record amount, payment date (IST), method, optional transaction reference and internal note.
- Server validates amounts and dates, rejects overpayments, checks ownership, and serializes writes on the account/lead. UI saves carry a retry key so resubmitting a failed request does not duplicate a payment. Legacy admin payment writers use the same balance validation and locks.
- Existing payments receive receipt numbers during migration. Unknown historical methods show Not recorded; no method is invented.
- Receipt → Download PDF, or WhatsApp → review number/message → Open WhatsApp. Attach the downloaded PDF manually and tap Send. There are no automatic messages or public receipt links.
- Internal notes are omitted from customer receipts and messages. Receipts acknowledge recorded payments; they are not tax invoices or proof of bank clearance.
- Admin can correct amounts/notes or permanently delete mistaken payments after confirmation. Corrections increase the receipt version. Previously shared copies do not change when records are corrected/deleted.
- Current payment history shows the latest 100 entries per account; balances include every entry.

## Collections report
Collected is the sum received within the selected inclusive IST date range. Pending and overdue are current balances; overdue is included in pending, not an extra amount. Accounts without due dates are not labelled overdue. Search, salesman and currency filters affect the displayed summary. Currency totals are kept separate. Salesman rollups use the account's current assigned employee, while individual receipts show who recorded each payment.

The existing export buttons still export the legacy Won-lead report. Standalone quotation accounts are included in the new collection view, not the old Won-lead export. Existing onboarding, notifications, tasks, Day Closing, Brief and other reports are retained.

## Verification
- New collection API tests pass: authentication, assignment/ownership, amount validation, overpayment rejection, transactional rollback, retry deduplication, old-payment preservation, receipt/PDF access, corrections/deletion, accepted-revision gates, lead/value mismatch checks, and standalone quotation conversion.
- DOM interaction checks pass: list/detail navigation, partial payment and balance updates, failed-save retention with stable retry key, receipt/WhatsApp preview, admin-only correction/deletion controls, confirmation cancellation and quotation conversion.
- Frontend production build passes. Receipt PDF rendered and visually checked.
- Uploaded baseline: 44 tests, 34 passed and 10 failed. Updated suite: 46 tests, 36 passed and the same 10 baseline failures. The existing failures are in Day Closing/start-end and salesman Brief tests; these areas were not changed. No claim is made that these baseline tests pass.
- Database operations were tested with mocks, not a live PostgreSQL instance. Migration 042 and deployed/mobile flows have not been run against your production system here. No deployment was performed.
