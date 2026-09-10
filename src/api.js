// ---------------------------------------------------------------------------
// Talks to the real FieldTrail backend (Express + Postgres, from the
// architecture doc). No mock data lives here — if the backend URL isn't
// configured or a request fails, callers surface that to the user rather
// than silently falling back to fake numbers.
// ---------------------------------------------------------------------------

const LS_API_BASE = "fieldtrail:apiBase";
const LS_SESSION = "fieldtrail:session";
const LS_DEVICE_ID = "fieldtrail:deviceId";
const LS_QUEUED_LEADS = "fieldtrail:queuedLeads";
const LS_DAY_STARTED = "fieldtrail:dayStarted";

export function getApiBase() {
  return localStorage.getItem(LS_API_BASE) || import.meta.env.VITE_API_BASE_URL || "";
}
export function setApiBase(url) {
  const clean = url.trim().replace(/\/+$/, "");
  localStorage.setItem(LS_API_BASE, clean);
}
export function clearApiBase() {
  localStorage.removeItem(LS_API_BASE);
}
export function getWsBase() {
  const base = getApiBase();
  if (!base) return "";
  return base.replace(/^http/, "ws");
}

export function getSession() {
  try {
    const raw = localStorage.getItem(LS_SESSION);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
export function setSession(session) {
  localStorage.setItem(LS_SESSION, JSON.stringify(session));
}
export function clearSession() {
  localStorage.removeItem(LS_SESSION);
}

export function getDeviceId() {
  let id = localStorage.getItem(LS_DEVICE_ID);
  if (!id) {
    id = "web-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem(LS_DEVICE_ID, id);
  }
  return id;
}

export function getDayStarted(userId) {
  return localStorage.getItem(`${LS_DAY_STARTED}:${userId}`) === "1";
}
export function setDayStartedFlag(userId, val) {
  if (val) localStorage.setItem(`${LS_DAY_STARTED}:${userId}`, "1");
  else localStorage.removeItem(`${LS_DAY_STARTED}:${userId}`);
}

// Offline lead queue — a lead saved with no connection sits here (keyed by
// its own client-generated UUID, the same idempotency key the backend uses
// to dedupe retries) until it can be POSTed successfully.
export function getQueuedLeads() {
  try {
    return JSON.parse(localStorage.getItem(LS_QUEUED_LEADS) || "[]");
  } catch {
    return [];
  }
}
export function setQueuedLeads(list) {
  localStorage.setItem(LS_QUEUED_LEADS, JSON.stringify(list));
}
export function pushQueuedLead(payload) {
  const list = getQueuedLeads();
  list.push(payload);
  setQueuedLeads(list);
}
export function removeQueuedLead(clientUuid) {
  setQueuedLeads(getQueuedLeads().filter((l) => l.clientUuid !== clientUuid));
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = "GET", body, auth = true } = {}) {
  const base = getApiBase();
  if (!base) throw new ApiError("No backend configured yet.", 0);
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const session = getSession();
    if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  }
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError("Could not reach the server — check the backend URL and your connection.", 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty/non-JSON body is fine for some endpoints */
  }
  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

export const api = {
  login: (phone, password) => request("/auth/login", { method: "POST", body: { phone, password }, auth: false }),
  health: () => request("/health", { auth: false }),

  adminSummary: () => request("/admin/dashboard/summary"),
  adminSalesmen: () => request("/admin/salesmen"),
  adminCreateSalesman: (payload) => request("/admin/salesmen", { method: "POST", body: payload }),
  adminUpdateSalesman: (id, payload) => request(`/admin/salesmen/${id}`, { method: "PATCH", body: payload }),
  adminDeleteSalesman: (id) => request(`/admin/salesmen/${id}`, { method: "DELETE" }),
  adminLeads: (params = {}) => {
    const entries = Object.entries(params).filter(([, v]) => v != null && v !== "" && v !== "all");
    const qs = new URLSearchParams(entries).toString();
    return request(`/admin/leads${qs ? `?${qs}` : ""}`);
  },
  adminUpdateLeadStatus: (id, status) => request(`/admin/leads/${id}/status`, { method: "PATCH", body: { status } }),
  adminUpdateLead: (id, payload) => request(`/admin/leads/${id}`, { method: "PATCH", body: payload }),
  adminDeleteLead: (id) => request(`/admin/leads/${id}`, { method: "DELETE" }),
  adminGetSettings: () => request("/admin/settings"),
  adminUpdateSettings: (payload) => request("/admin/settings", { method: "PATCH", body: payload }),
  adminExportSheetsInfo: (params = {}) => {
    const entries = Object.entries(params).filter(([, v]) => v != null && v !== "" && v !== "all");
    const qs = new URLSearchParams(entries).toString();
    return request(`/admin/leads/export-sheets-info${qs ? `?${qs}` : ""}`);
  },
  adminSalesmanHistory: (id, date) => request(`/admin/salesmen/${id}/history?date=${date}`),
  adminSendMessage: (payload) => request("/admin/messages", { method: "POST", body: payload }),
  adminGetMessages: (salesmanId) => request(`/admin/messages${salesmanId ? `?salesmanId=${salesmanId}` : ""}`),
  adminDeleteMessage: (id) => request(`/admin/messages/${id}`, { method: "DELETE" }),
  adminGetLeadOptions: () => request("/admin/lead-options"),
  adminAddLeadOption: (fieldKey, value) => request("/admin/lead-options", { method: "POST", body: { fieldKey, value } }),
  adminDeleteLeadOption: (id) => request(`/admin/lead-options/${id}`, { method: "DELETE" }),

  salesmanDayStart: (lat, lng) => request("/salesman/day/start", { method: "POST", body: { lat, lng } }),
  salesmanDayEnd: (lat, lng) => request("/salesman/day/end", { method: "POST", body: { lat, lng } }),
  salesmanPing: (payload) => request("/salesman/location/ping", { method: "POST", body: payload }),
  salesmanLeads: () => request("/salesman/leads"),
  salesmanLead: (id) => request(`/salesman/leads/${id}`),
  salesmanCreateLead: (payload) => request("/salesman/leads", { method: "POST", body: payload }),
  salesmanUpdateLead: (id, payload) => request(`/salesman/leads/${id}`, { method: "PATCH", body: payload }),
  salesmanGetSettings: () => request("/salesman/settings"),
  salesmanGetProfile: () => request("/salesman/profile"),
  salesmanGetLeadOptions: () => request("/salesman/lead-options"),
  salesmanGetMessages: () => request("/salesman/messages"),
  salesmanMarkMessageRead: (id) => request(`/salesman/messages/${id}/read`, { method: "PATCH" }),
  salesmanDeleteMessage: (id) => request(`/salesman/messages/${id}`, { method: "DELETE" }),
};

// Builds a downloadable export URL (CSV/XLSX) that includes the auth token
// as a query param, since these are opened as plain navigations/downloads
// rather than fetch() calls — a normal Authorization header isn't possible
// for a direct link click.
export function buildExportUrl(format, params = {}) {
  const base = getApiBase();
  const session = getSession();
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== "" && v !== "all");
  const qs = new URLSearchParams(entries);
  if (session?.token) qs.set("token", session.token);
  return `${base}/admin/leads/export.${format}?${qs.toString()}`;
}

// ---------------------------------------------------------------------------
// Field-name adapters: backend rows (snake_case, Postgres-shaped) -> the
// camelCase shapes the UI components use.
// ---------------------------------------------------------------------------
export function mapSalesmanRow(row) {
  return {
    id: row.id,
    name: row.full_name,
    phone: row.phone,
    area: row.area || "Unassigned",
    employeeCode: row.employee_code || "",
    dailyTarget: row.daily_target || 8,
    monthlyTarget: row.monthly_target || 200,
    lat: row.last_lat != null ? Number(row.last_lat) : null,
    lng: row.last_lng != null ? Number(row.last_lng) : null,
    battery: row.last_battery_pct != null ? Number(row.last_battery_pct) : null,
    speed: row.last_speed_mps != null ? Number(row.last_speed_mps) * 3.6 : 0,
    status: row.status || "offline",
    isActive: row.is_active !== false,
    lastUpdate: row.last_seen_at ? new Date(row.last_seen_at) : null,
    distanceM: row.total_distance_m != null ? Number(row.total_distance_m) : 0,
  };
}

export function mapLeadRow(row) {
  const hasLocation = row.latitude != null && row.longitude != null;
  return {
    id: row.id,
    clientUuid: row.client_uuid,
    salesmanId: row.salesman_id,
    salesmanName: row.salesman_name || row.salesmanName || "",
    business: row.business_name,
    subLocation: row.sub_location || "",
    posName: row.pos_name || "",
    renewalMonth: row.renewal_month || "",
    renewalDate: row.renewal_date || "",
    dealValue: row.deal_value != null ? Number(row.deal_value) : null,
    owner: row.contact_name,
    phone: row.phone,
    category: row.category,
    status: row.status,
    hasLocation,
    lat: hasLocation ? Number(row.latitude) : null,
    lng: hasLocation ? Number(row.longitude) : null,
    accuracy: row.accuracy_m,
    verification: row.verification_status,
    createdAt: new Date(row.created_at),
    notes: row.notes || "",
    syncStatus: "synced",
  };
}
