const express = require('express');
const db = require('../db');
const { bad, str } = require('../utils/quotations');
const { parsePublicQuoteToken } = require('../utils/publicQuotation');
const { getBusinessName } = require('../utils/businessProfile');

const router = express.Router();
const buckets = new Map();

function rateLimit(req, res, next) {
  const now = Date.now(), windowMs = 10 * 60 * 1000;
  if (buckets.size > 5000) buckets.clear();
  const key = `${req.ip || 'unknown'}:${req.method}`;
  const current = buckets.get(key);
  const limit = req.method === 'POST' ? 12 : 90;
  if (!current || current.reset <= now) buckets.set(key, { count: 1, reset: now + windowMs });
  else {
    current.count += 1;
    if (current.count > limit) return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
  }
  next();
}
router.use(rateLimit);

function cleanEmail(value) {
  const email = str(value || '', 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address');
  return email;
}
function cleanPhone(value) {
  const phone = str(value || '', 30);
  if (phone && !/^[+\d ()-]+$/.test(phone)) throw bad('Enter a valid phone number');
  return phone;
}

async function transaction(fn) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client.query.bind(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

async function loadLink(query, token, lock = false) {
  const linkId = parsePublicQuoteToken(token);
  if (!linkId) throw bad('This quotation link is invalid.', 404);
  const { rows } = await query(
    `SELECT l.id,l.quote_id,l.revision,l.expires_at,l.revoked_at,l.first_viewed_at,
            q.number,q.owner_id,q.current_revision,
            r.status,r.version,r.expires_on::text AS expires_on,r.snapshot
       FROM quotation_public_links l
       JOIN quotations q ON q.id=l.quote_id
       JOIN quotation_revisions r ON r.quote_id=l.quote_id AND r.revision=l.revision
      WHERE l.id=$1${lock ? ' FOR UPDATE OF l,q,r' : ''}`,
    [linkId]
  );
  if (!rows.length) throw bad('This quotation link is invalid.', 404);
  return rows[0];
}

async function responseFor(query, row) {
  const { rows } = await query(
    `SELECT action,customer_name,designation,email,phone,message,created_at
       FROM quotation_public_responses WHERE quote_id=$1 AND revision=$2`,
    [row.quote_id, row.revision]
  );
  return rows[0] || null;
}

function state(row, response) {
  const expired = new Date(row.expires_at).getTime() <= Date.now() && row.status !== 'accepted';
  const superseded = Number(row.current_revision) !== Number(row.revision);
  const revoked = !!row.revoked_at;
  const closed = !['ready','sent'].includes(row.status);
  return { expired, superseded, revoked, canRespond: !expired && !superseded && !revoked && !closed && !response };
}

router.get('/:token', async (req, res) => {
  const row = await loadLink(db.query, req.params.token);
  const response = await responseFor(db.query, row);
  const status = state(row, response);
  if (!row.revoked_at) {
    await db.query(
      `UPDATE quotation_public_links
          SET first_viewed_at=COALESCE(first_viewed_at,now()),last_viewed_at=now()
        WHERE id=$1`,
      [row.id]
    );
  }
  const businessName = await getBusinessName() || row.snapshot.company || 'Business';
  const s = row.snapshot;
  res.json({
    businessName,
    logo: s.logo || '',
    companyContact: s.companyContact || '',
    supportContact: s.supportContact || '',
    quoteNumber: `${s.prefix}-${String(row.number).padStart(5,'0')}`,
    revision: row.revision,
    customer: { name: s.customer.name, contact: s.customer.contact || '', phone: s.customer.phone || '' },
    currency: s.currency,
    package: s.package,
    addons: s.addons || [],
    discount: s.discount,
    discountMinor: s.discountMinor,
    taxPercent: s.taxPercent,
    taxMinor: s.taxMinor,
    totalMinor: s.totalMinor,
    advancePercent: s.advancePercent,
    terms: s.terms || '',
    footer: s.footer || '',
    issuedOn: s.issuedOn,
    expiresOn: s.expiresOn,
    quotationStatus: row.status,
    ...status,
    response: response ? {
      action: response.action,
      customerName: response.customer_name,
      designation: response.designation,
      createdAt: response.created_at,
    } : null,
  });
});

router.post('/:token/respond', async (req, res) => {
  const action = req.body?.action;
  if (!['accepted','changes_requested'].includes(action)) throw bad('Choose a valid response');
  const customerName = str(req.body?.customerName, 180, true);
  const designation = str(req.body?.designation || '', 120);
  const email = cleanEmail(req.body?.email);
  const phone = cleanPhone(req.body?.phone);
  const message = str(req.body?.message || '', 1500, action === 'changes_requested');
  if (action === 'changes_requested' && message.length < 3) throw bad('Tell us what you would like changed');
  const ipAddress = String(req.ip || '').slice(0, 100);
  const userAgent = String(req.get('user-agent') || '').slice(0, 500);

  const result = await transaction(async query => {
    const row = await loadLink(query, req.params.token, true);
    const existing = await responseFor(query, row);
    if (existing) {
      if (existing.action === action) return { action: existing.action, customerName: existing.customer_name, createdAt: existing.created_at, idempotent: true };
      throw bad('This quotation revision already has a customer response.', 409);
    }
    const st = state(row, null);
    if (st.revoked) throw bad('This quotation link has been revoked.', 410);
    if (st.expired) throw bad('This quotation has expired. Please ask for a new quotation.', 410);
    if (st.superseded) throw bad('A newer quotation revision is available. Please ask for the latest link.', 409);
    if (!['ready','sent'].includes(row.status)) throw bad('This quotation is no longer open for a customer response.', 409);

    const { rows } = await query(
      `INSERT INTO quotation_public_responses
         (quote_id,revision,action,customer_name,designation,email,phone,message,ip_address,user_agent)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING action,customer_name,created_at`,
      [row.quote_id,row.revision,action,customerName,designation,email,phone,message,ipAddress,userAgent]
    );
    await query(
      `UPDATE quotation_revisions
          SET status=$3,version=version+1,sent_at=COALESCE(sent_at,now())
        WHERE quote_id=$1 AND revision=$2`,
      [row.quote_id,row.revision,action]
    );
    await query('UPDATE quotations SET updated_at=now() WHERE id=$1',[row.quote_id]);
    const eventNote = action === 'accepted'
      ? `Customer online acceptance by ${customerName}${designation ? ` (${designation})` : ''}`
      : `Customer requested changes by ${customerName}: ${message}`;
    await query(
      `INSERT INTO quotation_events(quote_id,revision,actor_id,action,note)
       VALUES($1,$2,NULL,$3,$4)`,
      [row.quote_id,row.revision,action,eventNote]
    );
    if (row.owner_id) {
      await query(
        `INSERT INTO quotation_alerts(user_id,quote_id,revision,kind)
         VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [row.owner_id,row.quote_id,row.revision,action === 'accepted' ? 'accepted' : 'changes_requested']
      );
    }
    return { action: rows[0].action, customerName: rows[0].customer_name, createdAt: rows[0].created_at, idempotent: false };
  });
  res.json(result);
});

router.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
});

module.exports = router;
module.exports.loadLink = loadLink;
module.exports.state = state;
