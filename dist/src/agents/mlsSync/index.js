"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMlsSync = runMlsSync;
exports.mlsStatus = mlsStatus;
exports.scheduleMlsSync = scheduleMlsSync;
const index_js_1 = require("../../integrations/bridge/index.js");
const listingsStore_js_1 = require("../../core/listingsStore.js");
/**
 * Keeps the local MLS mirror current.
 *
 * INCREMENTAL BY DESIGN. Each run asks Bridge only for records whose
 * ModificationTimestamp is newer than the newest one already stored. The first
 * run therefore does the heavy pull and every run after it is small, which is
 * what makes a 30-minute cadence affordable against a metered, rate-limited
 * feed.
 *
 * Every attempt is recorded, successes and failures alike. A feed that quietly
 * stopped returning data looks exactly like a quiet market from the dashboard,
 * and the only way to tell them apart is a visible last-successful-sync time.
 */
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
/** First run pulls more, since it is building the mirror from nothing. */
const FIRST_RUN_MAX = 5000;
const INCREMENTAL_MAX = 2000;
let running = false;
async function runMlsSync() {
    if (!(0, index_js_1.isBridgeConfigured)()) {
        const cfg = (0, index_js_1.bridgeConfig)();
        const problem = "ok" in cfg ? cfg : { error: "Bridge is not configured.", fix: undefined };
        return { ran: false, ok: false, error: problem.error, fix: problem.fix };
    }
    /* Overlapping runs would double-fetch a metered feed and interleave writes
       for no benefit; a skipped tick costs nothing because the next one resumes
       from the same high-water mark. */
    if (running)
        return { ran: false, error: "A sync is already in progress." };
    running = true;
    const since = (0, listingsStore_js_1.newestModificationTs)();
    const runId = (0, listingsStore_js_1.startSyncRun)();
    try {
        const res = await (0, index_js_1.fetchProperties)({
            since,
            maxRecords: since ? INCREMENTAL_MAX : FIRST_RUN_MAX,
        });
        if ("error" in res) {
            (0, listingsStore_js_1.finishSyncRun)(runId, { ok: false, error: res.error });
            console.error("[MlsSync] failed:", res.error);
            return { ran: true, ok: false, error: res.error, fix: res.fix };
        }
        const rows = res.records
            .map(listingsStore_js_1.fromResoProperty)
            .filter((r) => r.listingKey);
        const upserted = (0, listingsStore_js_1.upsertListings)(rows);
        (0, listingsStore_js_1.finishSyncRun)(runId, { ok: true, fetched: res.records.length, upserted });
        console.log(`[MlsSync] ${res.records.length} fetched, ${upserted} stored${res.truncated ? " (capped — more remain, next run continues)" : ""}`);
        return { ran: true, ok: true, fetched: res.records.length, upserted, truncated: res.truncated };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        (0, listingsStore_js_1.finishSyncRun)(runId, { ok: false, error: message });
        console.error("[MlsSync] crashed:", message);
        return { ran: true, ok: false, error: message };
    }
    finally {
        running = false;
    }
}
/**
 * Status an operator can act on.
 *
 * Reports staleness as a NUMBER OF HOURS rather than a boolean, because "is the
 * MLS working" has a different answer at two hours and at eleven days, and a
 * green tick would hide the difference.
 */
function mlsStatus() {
    const configured = (0, index_js_1.isBridgeConfigured)();
    const cfg = (0, index_js_1.bridgeConfig)();
    const counts = (0, listingsStore_js_1.listingCounts)();
    const last = (0, listingsStore_js_1.lastSuccessfulSync)();
    const ageHours = last?.finishedAt
        ? (Date.now() - new Date(last.finishedAt).getTime()) / 3_600_000
        : null;
    return {
        configured,
        ...(configured ? {} : { error: "ok" in cfg ? cfg.error : undefined, fix: "ok" in cfg ? cfg.fix : undefined }),
        dataset: configured && !("ok" in cfg) ? cfg.dataset : null,
        listings: counts.total,
        byStatus: counts.byStatus,
        lastSuccessfulSyncAt: last?.finishedAt ?? null,
        hoursSinceLastSync: ageHours == null ? null : Math.round(ageHours * 10) / 10,
        stale: ageHours == null ? true : ageHours > 6,
        recentRuns: (0, listingsStore_js_1.recentSyncRuns)(5),
        note: configured
            ? counts.total === 0
                ? "Configured but nothing stored yet — run a sync."
                : undefined
            : "Not connected to Bridge. Listing tools will say so rather than return an empty market.",
    };
}
function scheduleMlsSync() {
    if (!(0, index_js_1.isBridgeConfigured)()) {
        console.log("[MlsSync] Not scheduled — Bridge is not configured (BRIDGE_SERVER_TOKEN / BRIDGE_DATASET).");
        return;
    }
    /* Delayed so the first pull does not compete with boot, and so a crash-loop
       cannot hammer a metered API once per restart. */
    setTimeout(() => void runMlsSync(), 90 * 1000);
    setInterval(() => void runMlsSync(), SYNC_INTERVAL_MS);
    console.log(`[MlsSync] Scheduled — first pull in 90s, then every ${SYNC_INTERVAL_MS / 60000} min`);
}
