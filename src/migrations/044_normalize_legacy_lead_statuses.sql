-- Normalize every live lead onto the current CRM funnel.
-- Historical lead_status_history rows are intentionally preserved so audit
-- trails remain truthful, but current leads may only use the eight active stages.

UPDATE leads
SET status = 'cold'
WHERE status::text IN (
  'new',
  'contacted',
  'follow_up',
  'demo_scheduled',
  'proposal_sent',
  'warm'
);

ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS leads_current_funnel_status_check;

ALTER TABLE leads
  ADD CONSTRAINT leads_current_funnel_status_check
  CHECK (status::text IN (
    'cold',
    'conversation',
    'hot',
    'demo',
    'negotiation',
    'won',
    'lost',
    'nurture'
  ));
