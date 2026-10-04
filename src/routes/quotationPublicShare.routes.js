const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { UUID, bad, customerSummary } = require('../utils/quotations');
const { makePublicQuoteToken, publicQuoteUrl } = require('../utils/publicQuotation');

const router = express.Router();
router.use(requireAuth);

async function currentQuote(user, id) {
  if (!UUID.test(id)) throw bad('Invalid quotation');
  const { rows } = await db.query(
    `SELECT q.*, r.revision, r.version, r.status, r.expires_on::text AS expires_on, r.snapshot
       FROM quotations q
       JOIN quotation_revisions r ON r.quote_id=q.id AND r.revision=q.current_revision
      WHERE q.id=$1 AND ($2::uuid IS NULL OR q.owner_id=$2)`,
    [id, user.role === 'admin' ? null : user.id]
  );
  if (!rows.length) throw bad('Quotation not found', 404);
  const row = rows[0];
  return {
    quote: { id: row.id, number: row.number, owner_id: row.owner_id, lead_id: row.lead_id, current_revision: row.current_revision },
    revision: { revision: row.revision, version: row.version, status: row.status, expires_on: row.expires_on, snapshot: row.snapshot },
  };
}

async function ensureLink(query, quote, revision, userId) {
  let { rows } = await query(
    `SELECT id FROM quotation_public_links
      WHERE quote_id=$1 AND revision=$2 AND revoked_at IS NULL AND expires_at>now()
      ORDER BY created_at DESC LIMIT 1`,
    [quote.id, revision.revision]
  );
  if (!rows.length) {
    ({ rows } = await query(
      `INSERT INTO quotation_public_links(quote_id,revision,expires_at,created_by)
       VALUES($1,$2,(($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'),$4)
       RETURNING id`,
      [quote.id, revision.revision, revision.expires_on, userId]
    ));
  }
  const token = makePublicQuoteToken(rows[0].id);
  return { token, url: publicQuoteUrl(token) };
}

// This intentionally overrides the legacy summary route. The existing Engage UI
// keeps the same button and response shape; the WhatsApp text simply gains a
// secure customer view/acceptance link.
router.get('/:id/summary', async (req, res) => {
  const { quote, revision } = await currentQuote(req.user, req.params.id);
  const summary = customerSummary(quote, revision);
  const link = await ensureLink(db.query, quote, revision, req.user.id);
  const label = revision.status === 'accepted' ? 'View quotation' : 'View and respond online';
  res.json({
    ...summary,
    publicUrl: link.url,
    text: `${summary.text}\n\n${label}: ${link.url}`,
  });
});

router.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
});

module.exports = router;
module.exports.ensureLink = ensureLink;
