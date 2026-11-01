const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const SEARCH_FIELDS = "nextPageToken,places.id,places.displayName,places.formattedAddress,places.googleMapsUri,places.attributions";
const DETAIL_FIELDS = "id,internationalPhoneNumber,nationalPhoneNumber,websiteUri,attributions";
const TYPE_LABELS = Object.freeze({
  restaurant: "restaurants",
  cafe: "cafes",
  bakery: "bakeries",
  qsr: "quick service restaurants"
});

const positiveBound = (value, fallback, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};
function limits() {
  return {
    search: {
      daily: positiveBound(process.env.PLACES_SEARCH_DAILY_LIMIT, 10, 50),
      monthly: positiveBound(process.env.PLACES_SEARCH_MONTHLY_LIMIT, 100, 500)
    },
    contact: {
      daily: positiveBound(process.env.PLACES_CONTACT_DAILY_LIMIT, 3, 10),
      monthly: positiveBound(process.env.PLACES_CONTACT_MONTHLY_LIMIT, 25, 100)
    }
  };
}
function contactsEnabled() {
  return process.env.PLACES_ENABLE_CONTACTS === "true";
}
function keyConfigured() {
  return Boolean(String(process.env.GOOGLE_PLACES_API_KEY || "").trim());
}
function textInput(value, max, label, required = false) {
  if (typeof value !== "string") throw Object.assign(new Error(label + " must be text."), { status: 400 });
  const result = value.trim().replace(/\s+/g, " ");
  if ((required && result.length < 2) || result.length > max || /[<>\x00-\x1f]/.test(result)) {
    throw Object.assign(new Error("Invalid " + label.toLowerCase() + "."), { status: 400 });
  }
  return result;
}
function normalizeSearch(body) {
  const city = textInput(body?.city, 80, "City", true);
  const area = textInput(body?.area ?? "", 90, "Locality");
  const category = body?.category ?? "restaurant";
  if (!Object.hasOwn(TYPE_LABELS, category)) throw Object.assign(new Error("Invalid restaurant type."), { status: 400 });
  const pageToken = body?.pageToken == null ? "" : textInput(body.pageToken, 2048, "Page token");
  if (pageToken && !/^[\x21-\x7e]+$/.test(pageToken)) throw Object.assign(new Error("Invalid page token."), { status: 400 });
  return { city, area, category, pageToken };
}
function safeExternalUrl(value, hosts = null) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (hosts && !hosts.includes(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}
function mapAttributions(values) {
  return Array.isArray(values) ? values.slice(0, 5).map(a => ({
    provider: String(a.provider || "").slice(0, 150),
    providerUri: safeExternalUrl(a.providerUri)
  })).filter(a => a.provider || a.providerUri) : [];
}
function normalizePlace(p) {
  if (!p || typeof p.id !== "string" || !p.id) return null;
  return {
    id: p.id,
    name: String(p.displayName?.text || "Unnamed restaurant").slice(0, 250),
    address: String(p.formattedAddress || "").slice(0, 500),
    mapsUrl: safeExternalUrl(p.googleMapsUri, ["www.google.com", "google.com", "maps.google.com"]) ||
      "https://www.google.com/maps/search/?api=1&query_place_id=" + encodeURIComponent(p.id),
    attributions: mapAttributions(p.attributions)
  };
}
// IST day/month limits are reserved atomically across Render instances. Failed API
// requests still count toward the application budget: fail closed, not over budget.
async function usage(kind, reserve = false) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    if (reserve) await client.query("SELECT pg_advisory_xact_lock(72810433)");
    const { rows } = await client.query(`
      SELECT
        count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS today,
        count(*) FILTER (WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS month
      FROM restaurant_finder_usage WHERE kind=$1
    `, [kind]);
    const today = Number(rows[0]?.today || 0), month = Number(rows[0]?.month || 0);
    const max = limits()[kind];
    if (reserve && (today >= max.daily || month >= max.monthly)) {
      await client.query("COMMIT");
      return { today, month, limit: max, allowed: false };
    }
    if (reserve) await client.query("INSERT INTO restaurant_finder_usage (kind) VALUES ($1)", [kind]);
    await client.query("COMMIT");
    return { today: today + (reserve ? 1 : 0), month: month + (reserve ? 1 : 0), limit: max, allowed: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function callPlaces(url, fields, options = {}) {
  const res = await fetch(url, {
    method: options.body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask": fields
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) {
    const err = new Error(res.status === 403 || res.status === 400
      ? "Google Places rejected this request. Check the API key, restrictions and billing."
      : res.status === 429 ? "Google Places quota exceeded. Please retry later."
      : "Google Places is unavailable right now.");
    err.status = res.status === 429 ? 429 : 503;
    throw err;
  }
  return res.json();
}

router.get("/status", async (_req, res) => {
  const [search, contact] = await Promise.all([usage("search"), usage("contact")]);
  res.json({ configured: keyConfigured(), contactEnabled: contactsEnabled() && keyConfigured(), search, contact });
});

router.post("/search", async (req, res) => {
  const input = normalizeSearch(req.body);
  if (!keyConfigured()) return res.status(503).json({ error: "Google Places API key is not configured in Render yet." });
  const quota = await usage("search", true);
  if (!quota.allowed) return res.status(429).json({ error: "Lead Finder search limit reached. Try again after the quota resets.", usage: quota });
  const textQuery = [TYPE_LABELS[input.category], input.area, input.city, "India"].filter(Boolean).join(" in ");
  const request = { textQuery, regionCode: "IN", languageCode: "en", pageSize: 20 };
  if (input.pageToken) request.pageToken = input.pageToken;
  const data = await callPlaces(SEARCH_URL, SEARCH_FIELDS, { body: request });
  res.json({
    places: (data.places || []).map(normalizePlace).filter(Boolean),
    nextPageToken: typeof data.nextPageToken === "string" ? data.nextPageToken : null,
    usage: quota
  });
});

// Contact data is Enterprise-billed and requires an explicit admin click,
// plus an opt-in server flag and its own hard per-day/month usage ledger.
router.post("/contact", async (req, res) => {
  if (!contactsEnabled()) return res.status(403).json({ error: "Contact lookups are disabled. Enable them after reviewing Google pricing." });
  if (!keyConfigured()) return res.status(503).json({ error: "Google Places API key is not configured in Render yet." });
  const id = textInput(req.body?.placeId, 256, "Place ID", true);
  if (!/^[A-Za-z0-9_-]{5,256}$/.test(id)) return res.status(400).json({ error: "Invalid place ID." });
  const quota = await usage("contact", true);
  if (!quota.allowed) return res.status(429).json({ error: "Contact lookup limit reached.", usage: quota });
  const data = await callPlaces("https://places.googleapis.com/v1/places/" + encodeURIComponent(id), DETAIL_FIELDS);
  res.json({
    phone: typeof data.internationalPhoneNumber === "string" ? data.internationalPhoneNumber : (data.nationalPhoneNumber || null),
    website: safeExternalUrl(data.websiteUri),
    attributions: mapAttributions(data.attributions),
    usage: quota
  });
});

module.exports = router;
module.exports._test = { normalizeSearch, safeExternalUrl, normalizePlace, limits, TYPE_LABELS, SEARCH_FIELDS, DETAIL_FIELDS };
