const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const routes = require("../src/routes/restaurantFinder.routes")._test;

test("Search inputs are validated and restricted to named India restaurant categories", () => {
  assert.deepEqual(routes.normalizeSearch({city:" Lucknow ",area:" Gomti Nagar ",category:"cafe"}),{
    city:"Lucknow",area:"Gomti Nagar",category:"cafe",pageToken:""
  });
  assert.equal(routes.TYPE_LABELS.qsr,"quick service restaurants");
  assert.throws(()=>routes.normalizeSearch({city:"",area:"",category:"restaurant"}),/Invalid city/);
  assert.throws(()=>routes.normalizeSearch({city:"Lucknow",area:"",category:"pharmacy"}),/Invalid restaurant type/);
  assert.throws(()=>routes.normalizeSearch({city:"Lucknow",area:"",category:"restaurant",pageToken:"bad\nvalue"}),/Invalid page token/);
});

test("Google Place results are transformed without persisting or trusting unverified external URLs", () => {
  const p=routes.normalizePlace({id:"ChIJabc123",displayName:{text:"Brew & Bun"},formattedAddress:"Gomti Nagar, Lucknow",googleMapsUri:"https://www.google.com/maps/place/example"});
  assert.equal(p.name,"Brew & Bun");
  assert.equal(p.address,"Gomti Nagar, Lucknow");
  assert.match(p.mapsUrl,/^https:\/\/www\.google\.com\//);
  assert.equal(routes.safeExternalUrl("javascript:alert(1)"),null);
  assert.equal(routes.safeExternalUrl("https://not-google.example/maps",["www.google.com"]),null);
  assert.match(routes.SEARCH_FIELDS,/places\.displayName/);
  assert.doesNotMatch(routes.SEARCH_FIELDS,/PhoneNumber|websiteUri|rating/);
  assert.match(routes.DETAIL_FIELDS,/internationalPhoneNumber/);
});

test("The finder enforces admin middleware and ledger-backed usage caps", () => {
  const src=fs.readFileSync(require.resolve("../src/routes/restaurantFinder.routes"),"utf8");
  const app=fs.readFileSync(require.resolve("../src/app"),"utf8");
  const migration=fs.readFileSync(require("node:path").join(__dirname,"../src/migrations/124_restaurant_finder_usage.sql"),"utf8");
  assert.match(src,/router\.use\(requireAuth, requireRole\("admin"\)\)/);
  assert.match(app,/app\.use\("\/admin\/restaurant-finder", require\("\.\/routes\/restaurantFinder\.routes"\)\)/);
  assert.match(src,/pg_advisory_xact_lock/);
  assert.match(src,/if \(reserve && \(today >= max\.daily \|\| month >= max\.monthly\)\)/);
  assert.match(src,/PLACES_ENABLE_CONTACTS/);
  assert.match(migration,/ENABLE ROW LEVEL SECURITY/);
  assert.match(migration,/kind IN \('search','contact'\)/);
  assert.doesNotMatch(src,/INSERT INTO leads|INSERT INTO contacts/);
  assert.deepEqual(routes.limits(),{
    search:{daily:50,monthly:500},
    contact:{daily:3,monthly:25}
  });
});

test("Google error diagnostics identify safe reason without exposing raw error message or key", () => {
  const raw={error:{status:"PERMISSION_DENIED",message:"Sensitive API key AIzaShouldNeverAppear",details:[{"@type":"type.googleapis.com/google.rpc.ErrorInfo",reason:"API_KEY_SERVICE_BLOCKED",metadata:{consumer:"projects/sensitive-project"}}]}};
  const err=routes.googlePlacesError(403,raw);
  assert.match(err.message,/HTTP 403 · PERMISSION_DENIED · API_KEY_SERVICE_BLOCKED/);
  assert.match(err.message,/Enable Places API \(New\)/);
  assert.equal(err.status,503);
  assert.doesNotMatch(err.message,/AIzaShouldNeverAppear|sensitive-project/);
  const billing=routes.googlePlacesError(403,{error:{status:"PERMISSION_DENIED",details:[{reason:"BILLING_NOT_ENABLED"}]}});
  assert.match(billing.message,/Enable billing/);
  const invalid=routes.googlePlacesError(400,{error:{status:"INVALID_ARGUMENT",message:"do not echo body",details:[{reason:"ARBITRARY_UNTRUSTED_REASON"}]}});
  assert.match(invalid.message,/HTTP 400 · INVALID_ARGUMENT/);
  assert.doesNotMatch(invalid.message,/ARBITRARY_UNTRUSTED_REASON|do not echo body/);
  const quota=routes.googlePlacesError(429,{error:{status:"RESOURCE_EXHAUSTED"}});
  assert.equal(quota.status,429);
  assert.match(quota.message,/quota exceeded/i);
});
