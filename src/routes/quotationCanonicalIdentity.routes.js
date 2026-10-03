const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { bad } = require('../utils/quotations');

const router = express.Router();

router.use(requireAuth);

router.use(async (req, _res, next) => {
  const { rows } = await db.query('SELECT business_name FROM business_profile WHERE id = 1');
  const businessName = typeof rows[0]?.business_name === 'string' ? rows[0].business_name.trim() : '';

  if (!businessName) {
    throw bad('Business name is not configured. Set it in My Account.', 409);
  }

  // Keep the quotation configuration synchronized with the single workspace
  // business identity without bumping the pricing/settings version.
  await db.query(
    `UPDATE quotation_settings
     SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{company}', to_jsonb($1::text), true)
     WHERE id = 1
       AND COALESCE(config->>'company', '') IS DISTINCT FROM $1`,
    [businessName]
  );

  // The legacy quotation settings validator still expects a company field.
  // Inject the canonical value so an empty/stale UI copy cannot trigger the
  // generic "Missing or invalid text field" error while saving settings.
  if (req.method === 'PUT' && req.path === '/settings' && req.body?.config && typeof req.body.config === 'object') {
    req.body.config = { ...req.body.config, company: businessName };
  }

  next();
});

module.exports = router;
