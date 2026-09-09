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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.brivityConfigured = brivityConfigured;
exports.personToRow = personToRow;
exports.getBrivityPeople = getBrivityPeople;
exports.getBrivityImportStatus = getBrivityImportStatus;
exports.primeBrivityMirrorStore = primeBrivityMirrorStore;
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
/**
 * Brivity's notes, plus the two fields this CRM has nowhere else to put.
 *
 * `company` (148 contacts) and `job_title` (14) have no counterpart here, and
 * dropping them would lose real information — among the messier entries are
 * actual title companies and brokerages ("Nu World Title", "KWCV") that say who
 * a contact is. Adding schema fields for 162 records, most of a free-text field
 * Marco filled inconsistently ("Buyer", "cold call"), would cost more than it
 * returns. They are appended to the notes instead, labelled as coming from
 * Brivity so nobody mistakes them for something typed here.
 */
function notesFrom(p) {
    const parts = [];
    const desc = (p.description || "").trim();
    if (desc)
        parts.push(desc);
    const extra = [];
    const company = (p.company || "").trim();
    const title = (p.job_title || "").trim();
    if (company)
        extra.push(`Company: ${company}`);
    if (title)
        extra.push(`Title: ${title}`);
    if (extra.length)
        parts.push(`[from Brivity] ${extra.join(" · ")}`);
    return parts.join("\n\n") || null;
}
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
        crmNotes: notesFrom(p),
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
    /* Named precisely, because this is the whole chain in one sentence. With no
       key the CRM's live Brivity merge silently pulls nothing AND the migration
       cannot even build a plan — so "no Brivity contacts anywhere" and "the
       import button does not work" are the same cause, and the fix is one
       command on the server rather than anything in this codebase. */
    if (!key) {
        throw new Error("BRIVITY_API_KEY is not set on this server, so nothing can be read from Brivity — " +
            "neither the live contact list nor a migration plan. Set it as a secret on the Fly app " +
            "(flyctl secrets set BRIVITY_API_KEY=…) and try again.");
    }
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
/**
 * Pull from Brivity and write the result to the durable mirror.
 *
 * Separated from `getBrivityPeople()` so a refresh can run in the background
 * without anyone waiting on it — the 25-30s round trip is why the CRM used to
 * sit empty on a cold load.
 */
async function refreshBrivityMirror() {
    const startedAt = new Date().toISOString();
    const mirror = await Promise.resolve().then(() => __importStar(require("./brivityMirrorStore.js")));
    primeBrivityMirrorStore(mirror);
    const { replaceBrivityMirror, recordBrivitySyncFailure } = mirror;
    try {
        const rows = await fetchFromBrivity();
        cache = { rows, fetchedAt: Date.now() };
        lastError = null;
        try {
            replaceBrivityMirror(rows, startedAt);
            console.log(`[Brivity] mirrored ${rows.length} people to SQLite`);
        }
        catch (err) {
            /* A failed WRITE must not fail the READ — the rows are good, they just
               did not persist this time. Say so and carry on serving them. */
            console.error("[Brivity] mirror write failed:", err.message);
        }
        return rows;
    }
    catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error("[Brivity] people fetch failed:", lastError);
        try {
            recordBrivitySyncFailure(startedAt, lastError);
        }
        catch { /* the log is a nicety, never a reason to throw */ }
        throw err;
    }
}
/**
 * Brivity's contacts, served from the durable mirror.
 *
 * WHAT CHANGED AND WHY. This used to await a 25-30s network fetch behind a
 * 10-minute in-memory cache, so a cold load — a deploy, a restart, an idle
 * machine — blocked the whole CRM on Brivity's response time, and nothing at
 * all survived the process. Now the last known good list comes back from SQLite
 * immediately and the network refresh happens behind it.
 *
 * The ordering matters: mirror first, memory second, network last. Anything
 * that returns rows NOW beats anything that returns them eventually, because
 * the caller is a page render.
 */
async function getBrivityPeople(forceRefresh = false) {
    if (!brivityConfigured())
        return [];
    if (!forceRefresh) {
        if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS)
            return cache.rows;
        try {
            const mirror = await Promise.resolve().then(() => __importStar(require("./brivityMirrorStore.js")));
            primeBrivityMirrorStore(mirror);
            const { readBrivityMirror, getBrivityMirrorStatus } = mirror;
            const mirrored = readBrivityMirror();
            if (mirrored.length) {
                cache = { rows: mirrored, fetchedAt: Date.now() };
                const status = getBrivityMirrorStatus();
                /* Kick off a refresh but DO NOT await it — that is the entire point. */
                if (isMirrorStale(status.lastSyncedAt) && !inflight) {
                    inflight = refreshBrivityMirror()
                        .catch(() => cache?.rows ?? mirrored)
                        .finally(() => { inflight = null; });
                }
                return mirrored;
            }
        }
        catch (err) {
            /* A broken mirror file is not a reason to serve nothing — fall through to
               the network, which is what happened before this store existed. */
            console.error("[Brivity] mirror read failed:", err.message);
        }
    }
    /* Nothing local to serve (first ever run, or an explicit refresh): this is
       the one path that still waits on Brivity. */
    if (inflight)
        return inflight;
    inflight = refreshBrivityMirror()
        .catch(() => cache?.rows ?? [])
        .finally(() => { inflight = null; });
    return inflight;
}
/** Refresh in the background once the mirror is older than the cache window. */
function isMirrorStale(lastSyncedAt) {
    if (!lastSyncedAt)
        return true;
    const t = Date.parse(lastSyncedAt);
    return !Number.isFinite(t) || Date.now() - t > CACHE_TTL_MS;
}
function getBrivityImportStatus() {
    let mirroredCount = 0;
    let mirrorSyncedAt = null;
    let mirrorError = null;
    try {
        /* Synchronous require-shaped access: this is called from response paths
           that are not async, and a status probe must never be the thing that
           throws. A missing mirror simply reports zero. */
        const store = getMirrorStoreSync();
        if (store) {
            const st = store.getBrivityMirrorStatus();
            mirroredCount = st.count;
            mirrorSyncedAt = st.lastSyncedAt;
            mirrorError = st.lastError;
        }
    }
    catch (err) {
        mirrorError = err.message;
    }
    return {
        configured: brivityConfigured(),
        cachedCount: cache?.rows.length ?? 0,
        fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
        lastError,
        mirroredCount,
        mirrorSyncedAt,
        mirrorError,
    };
}
/* The mirror is loaded lazily and cached here so the synchronous status path
   can reach it without an await. */
let mirrorStore = null;
function getMirrorStoreSync() {
    return mirrorStore;
}
function primeBrivityMirrorStore(mod) {
    mirrorStore = mod;
}
