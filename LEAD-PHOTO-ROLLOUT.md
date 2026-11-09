# Lead photo rollout (Salesman only)

This feature reuses **one** existing DB field: `public.leads.photo_url`. The field contains only a private Storage object path, not the actual photo bytes or a public URL. There is no second photo metadata table.

## Requirements before merging / deploying

Configure these environment variables **in the Render backend service only**:

- `SUPABASE_URL=https://npocdmxgggvcaagomben.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY=<Supabase project's secret service-role key>`

Never put the secret key in the frontend, a commit, a PR comment, or a chat. Retrieve it directly from Supabase Project Settings → API Keys and set it in Render's Environment tab.

The `127_employee_lead_photos.sql` migration creates:
- a **private** `engage-lead-photos` Storage bucket (WebP, 150 KB max);
- `salesman_profiles.require_lead_photo`, default `false`;
- `lead_photo_cleanup_queue` for retrying removal of storage objects after the canonical photo reference is cleared/deleted. The queue is not a second photo-record table.

Backend has no direct access to storage files via PostgreSQL; Supabase Storage API credentials are essential for image upload, download and deletion.

## Validation checklist

1. Keep Photo Required OFF for existing staff and verify that normal lead creation still works without an image.
2. On an assigned salesman, choose an image in the 70/30 Category + Photo row; the browser compresses it to WebP, aiming near 80–100 KB and enforcing 150 KB.
3. Save the lead, confirm `leads.photo_url` stores a private path, view the photo in Salesman and Admin Lead Details, and confirm the bucket object is not publicly readable.
4. In Employee → Settings → Work Rules, enable Photo Required for one employee. Verify both the UI and POST /salesman/leads reject a new lead without photo. Verify another employee with OFF is unaffected.
5. Confirm only Admin can DELETE /admin/leads/:id/photo; Salesman cannot delete. Verify DB reference clears and Storage object disappears.
6. Permanently delete a lead with a photo and verify the canonical DB record and Storage object are both removed; if Storage fails, verify the retry queue eventually clears.
7. Verify existing GPS, attendance, follow-up, Admin Add Lead, and payment flows stay unchanged.
8. Review backend and frontend CI and production SHAs before calling the feature live.

Do not enable mandatory photos until an end-to-end upload has succeeded in production.
