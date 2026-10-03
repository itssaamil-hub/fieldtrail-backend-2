const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const auth = read('src/routes/auth.routes.js');
const quotePdf = read('src/utils/quotationPDF.js');
const onboardingPdf = read('src/utils/onboardingPDF.js');
const onboardingRoutes = read('src/routes/onboarding.routes.js');
const collections = read('src/utils/collections.js');

test('business profile update propagates into quotation settings', () => {
  assert.match(auth, /jsonb_set\(config,'\{company\}'/);
  assert.match(auth, /business\.profile_updated/);
});

test('quotation and onboarding PDFs read canonical business identity', () => {
  assert.match(quotePdf, /getBusinessName/);
  assert.match(onboardingPdf, /getBusinessName/);
});

test('financial identity prefers current configured company over historical snapshots', () => {
  assert.match(collections, /config\.company[\s\S]*snapshot\.company/);
});

test('public onboarding uses canonical business identity when available', () => {
  assert.match(onboardingRoutes, /getBusinessName/);
  assert.match(onboardingRoutes, /businessLabel/);
});
