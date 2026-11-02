// Geoapify provider for the admin-only Restaurant Lead Finder.
// The API key stays server-side. Neither raw upstream errors nor keys are
// returned to the browser, logged or stored in Engage's customer tables.
const GEOCODE_URL = "https://api.geoapify.com/v1/geocode/search";
const PLACES_URL = "https://api.geoapify.com/v2/places";
const CATEGORY_KEYS = Object.freeze({
  restaurant: "catering.restaurant",
  cafe: "catering.cafe",
  bakery: "catering.bakery",
  qsr: "catering.fast_food"
});
const PAGE_SIZE = 20;

function configured() {
  return Boolean(String(process.env.GEOAPIFY_API_KEY || "").trim());
}
function badUpstream(status, service) {
  const message = status === 401 || status === 403
    ? "Geoapify denied access to " + service + ". Check the Geoapify API key and enable both Places API and Geocoding API."
    : status === 429
    ? "Geoapify quota reached. Check the Geoapify dashboard and retry later."
    : "Geoapify " + service + " is temporarily unavailable (HTTP " + status + ").";
  return Object.assign(new Error(message), { status: status === 429 ? 429 : 503 });
}
async function getGeoapify(url, service, fetcher = fetch) {
  const response = await fetcher(url.toString(), { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw badUpstream(response.status, service);
  // The parsed JSON never includes the API key.
  return response.json();
}
function pageOffset(pageToken) {
  if (!pageToken) return 0;
  if (!/^(?:[1-9][0-9]*)$/.test(pageToken)) {
    throw Object.assign(new Error("Invalid Geoapify page token."), { status: 400 });
  }
  const value = Number(pageToken);
  if (!Number.isSafeInteger(value) || value % PAGE_SIZE || value > 480) {
    throw Object.assign(new Error("Invalid Geoapify page token."), { status: 400 });
  }
  return value;
}
function normalPlace(feature) {
  const p = feature?.properties;
  const point = feature?.geometry?.coordinates;
  if (!p || !p.place_id || !p.name || !Array.isArray(point)) return null;
  const [lon, lat] = point;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return {
    id: "geo_" + String(p.place_id).slice(0, 256),
    name: String(p.name).slice(0, 250),
    address: String(p.formatted || [p.address_line1, p.address_line2].filter(Boolean).join(", ")).slice(0, 500),
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(lat + "," + lon),
    attributions: [{ provider: "© OpenStreetMap contributors", providerUri: "https://www.openstreetmap.org/copyright" }]
  };
}
async function findRestaurants(input, fetcher = fetch) {
  if (!configured()) throw Object.assign(new Error("Geoapify is not connected. Set GEOAPIFY_API_KEY in the Render backend."), { status: 503 });
  const offset = pageOffset(input.pageToken);
  const key = process.env.GEOAPIFY_API_KEY;
  const text = [input.area, input.city, "India"].filter(Boolean).join(", ");
  const geocodeUrl = new URL(GEOCODE_URL);
  geocodeUrl.search = new URLSearchParams({
    text, format: "json", filter: "countrycode:in", limit: "1", lang: "en", apiKey: key
  }).toString();
  const geo = await getGeoapify(geocodeUrl, "Geocoding API", fetcher);
  const place = Array.isArray(geo?.results) ? geo.results[0] : null;
  const lon = Number(place?.lon), lat = Number(place?.lat);
  if (!place || !Number.isFinite(lat) || !Number.isFinite(lon) || place.country_code !== "in" ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw Object.assign(new Error("Geoapify could not locate that area in India. Try a more specific city and locality."), { status: 422 });
  }
  // Locality results use a defined 3 km search radius. City-only searches
  // use a wider 10 km radius rather than implying whole-city coverage.
  const radius = input.area ? 3000 : 10000;
  const placesUrl = new URL(PLACES_URL);
  placesUrl.search = new URLSearchParams({
    categories: CATEGORY_KEYS[input.category],
    filter: "circle:" + lon + "," + lat + "," + radius,
    bias: "proximity:" + lon + "," + lat,
    lang: "en", limit: String(PAGE_SIZE), offset: String(offset), apiKey: key
  }).toString();
  const places = await getGeoapify(placesUrl, "Places API", fetcher);
  const raw = Array.isArray(places?.features) ? places.features : [];
  return {
    places: raw.map(normalPlace).filter(Boolean),
    nextPageToken: raw.length === PAGE_SIZE && offset + PAGE_SIZE <= 480 ? String(offset + PAGE_SIZE) : null,
    coverage: { area: String(place.formatted || text).slice(0, 180), radiusKm: radius / 1000 }
  };
}

module.exports = { configured, findRestaurants, normalPlace, pageOffset, CATEGORY_KEYS };
