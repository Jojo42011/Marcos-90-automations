"use strict";
/**
 * Brivity Core API import — pulls Marco's real Brivity people/contacts and
 * serves them to the new CRM (/crm) as raw lead rows in the same shape as
 * /api/dashboard/data leads, so the front-end can merge both sources.
 *
 * Endpoint + auth proven by scripts/brivity-api-export-csv.mjs:
 *   GET https://api.brivity.com/api/people?limit=5000
 *   Authorization: Token token=<BRIVITY_API_KEY>
 *
 * Results are cached in memory (default 10 min) — Brivity rate limits are
 * unknown, and the CRM reloads on every page open.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.brivityConfigured = brivityConfigured;
exports.personToRow = personToRow;
exports.getBrivityPeople = getBrivityPeople;
exports.getBrivityImportStatus = getBrivityImportStatus;
const brivityMapping_js_1 = require("./brivityMapping.js");
const CORE_BASE = (process.env.BRIVITY_CORE_URL || "https://api.brivity.com").replace(/\/$/, "");
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_LIMIT = 5000;
let cache = null;
let lastError = null;
let inflight = null;
function apiKey() {
    return (process.env.BRIVITY_API_KEY || "").trim();
}
function brivityConfigured() {
    return apiKey().length > 0;
}
/** Exported so the import suites can run the real export through the real
 *  mapper, rather than a reimplementation of it that can drift. */
function personToRow(p) {
    const name = `${(p.first_name || "").trim()} ${(p.last_name || "").trim()}`.trim();
    const phone = (p.phone_number || "").trim() || null;
    const email = (p.email_address || "").trim() || null;
    if (!name && !phone && !email)
        return null;
    /* A CONFIRMED postal address. It used to be written to `criteria.location`,
       which is the slot for an address GUESSED out of a DM conversation — so the
       CRM deliberately never promoted it to the contact's address book, and
       Brivity's real address never appeared on the profile. It goes to `address`
       now, which is what that field is for. Postal code and country were dropped
       entirely before. */
    const address = [p.street_address, p.city, p.locality, p.postal_code, p.country]
        .map((x) => String(x ?? "").trim()).filter(Boolean).join(", ") || null;
    const v = (0, brivityMapping_js_1.mapVocabulary)(p);
    const tags = Array.isArray(p.tags) ? p.tags.map(String).filter(Boolean) : [];
    for (const t of v.addTags)
        if (!tags.includes(t))
            tags.push(t);
    return {
        id: `brivity-${p.id ?? `${name}-${phone || email || ""}`}`,
        brivityId: String(p.id ?? ""),
        brivityLeadId: p.lead_id != null ? String(p.lead_id) : null,
        brivityUuid: p.uuid ? String(p.uuid) : null,
        brivityUrl: p.brivity_contact_detail_url ? String(p.brivity_contact_detail_url) : null,
        recordKind: (0, brivityMapping_js_1.recordKind)(p.type),
        platform: "brivity",
        name: name || "Unknown",
        username: null,
        phone,
        email,
        source: (p.source || "").trim() || "Brivity CRM",
        crmStatus: v.status,
        crmStage: v.stage,
        /* Brivity said nothing for 1,353 of these. Defaulting to "buyer" invented an
           intention for half the database, so the null is carried and the caller
           decides. */
        crmIntent: v.intent,
        crmPriority: null,
        crmCallQueue: null,
        crmNotes: (p.description || "").trim() || null,
        propertyInquired: null,
        criteria: {},
        address,
        tags,
        /* The real counts, which were hard-coded to zero before even though both
           numbers are on every record. */
        alerts: 0,
        reports: Number(p.market_report_count ?? 0) || 0,
        activeReports: Number(p.active_market_report_count ?? 0) || 0,
        unmapped: v.unmapped,
        /* Brivity's integration API returns no timestamps at all — see the
           BrivityPerson note. Nulls here are honest, not missing data. */
        createdAt: null,
        updatedAt: null,
        lastActivity: null,
        lastMessageAt: null,
        messages: [],
        activity: [],
        autoPlanEnrollments: [],
    };
}
/**
 * Pulling all ~2,600 people takes 27-30s, so the original 30s timeout sat right
 * on the edge and failed intermittently — which mattered once an import started
 * depending on it. Generous ceiling plus one retry.
 */
const FETCH_TIMEOUT_MS = 90_000;
async function fetchOnce(key) {
    return fetch(`${CORE_BASE}/api/people?limit=${FETCH_LIMIT}`, {
        headers: { Authorization: `Token token=${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
}
async function fetchFromBrivity() {
    const key = apiKey();
    if (!key)
        throw new Error("BRIVITY_API_KEY not set");
    let res;
    try {
        res = await fetchOnce(key);
    }
    catch (err) {
        console.warn("[Brivity] people fetch failed, retrying once:", err.message);
        res = await fetchOnce(key);
    }
    if (!res.ok) {
        throw new Error(`Brivity API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json());
    const list = Array.isArray(data)
        ? data
        : Array.isArray(data.people)
            ? (data.people)
            : [];
    const rows = list.map(personToRow).filter((r) => r !== null);
    /* Brivity returns no timestamps, so there is nothing to sort by. The old
       sort compared two nulls on every pair and did nothing; leaving the API's
       own order is at least honest about that. */
    return rows;
}
async function getBrivityPeople(forceRefresh = false) {
    if (!brivityConfigured())
        return [];
    if (!forceRefresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS)
        return cache.rows;
    if (inflight)
        return inflight;
    inflight = fetchFromBrivity()
        .then((rows) => {
        cache = { rows, fetchedAt: Date.now() };
        lastError = null;
        console.log(`[Brivity] imported ${rows.length} people from Core API`);
        return rows;
    })
        .catch((err) => {
        lastError = err instanceof Error ? err.message : String(err);
        console.error("[Brivity] people import failed:", lastError);
        // Serve the stale cache (if any) rather than dropping live data.
        return cache?.rows ?? [];
    })
        .finally(() => {
        inflight = null;
    });
    return inflight;
}
function getBrivityImportStatus() {
    return {
        configured: brivityConfigured(),
        cachedCount: cache?.rows.length ?? 0,
        fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
        lastError,
    };
}
