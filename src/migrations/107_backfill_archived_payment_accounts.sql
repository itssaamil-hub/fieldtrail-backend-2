UPDATE collection_accounts a
SET archived_at = now(),
    archive_reason = 'Deal is currently ' || l.status,
    version = version + 1
FROM leads l
WHERE a.lead_id = l.id
  AND l.status <> 'won'
  AND a.voided_at IS NULL
  AND a.archived_at IS NULL;

UPDATE collection_accounts a
SET archived_at = NULL,
    archive_reason = NULL,
    version = version + 1
FROM leads l
WHERE a.lead_id = l.id
  AND l.status = 'won'
  AND a.voided_at IS NULL
  AND a.archived_at IS NOT NULL;
