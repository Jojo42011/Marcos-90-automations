"use strict";
/**
 * Automated Brivity transactions sync, via the team's Google Sheet.
 *
 * WHY A SHEET AND NOT BRIVITY ITSELF. Researched 2026-08-04: Brivity exposes
 * no automatable transaction data anywhere — the Core API is people/leads
 * only (transactions endpoints all 406), the Zapier app has three lead
 * triggers and nothing else, there is no scheduled/emailed transaction
 * report, and even commercial middleware (RealSynch) resorts to logging into
 * the web app with the owner's credentials. The team already maintains a
 * Google Sheet mirroring Brivity's transactions because Brivity cannot
 * export them; this module makes that sheet the pipe. Edit the sheet, and
 * the numbers land in Command on the next sync — nobody downloads a file.
 *
 * HOW. `TRANSACTIONS_SHEET_URL` names the sheet. On a schedule (and on
 * demand) the server fetches it as CSV straight from Google and runs it
 * through the SAME plan/apply importer as the manual upload — same column
 * aliases, same dedupe, same "closed deals are worth what they sold for"
 * rule, same import log. One parser, one behavior, however the data arrives.
 *
 * THE SHEET MUST BE LINK-READABLE (Share → Anyone with the link → Viewer).
 * Google's CSV export endpoint answers an HTML sign-in page otherwise; that
 * case is detected and reported as exactly what it is rather than as "no
 * transactions found".
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSheetSyncConfigured = isSheetSyncConfigured;
exports.sheetSyncStatus = sheetSyncStatus;
exports.normalizeSheetUrl = normalizeSheetUrl;
exports.runSheetSync = runSheetSync;
const transactionImport_js_1 = require("./transactionImport.js");
/** Most recent run, whatever triggered it — for the status endpoint. */
let lastRun = null;
let running = false;
function isSheetSyncConfigured() {
    return Boolean(process.env.TRANSACTIONS_SHEET_URL?.trim());
}
function sheetSyncStatus() {
    return { configured: isSheetSyncConfigured(), running, lastRun };
}
/**
 * Normalize whatever URL a person pastes into the CSV-export form.
 *
 * People paste the URL in their address bar, which is the EDIT page —
 * `/spreadsheets/d/<id>/edit?gid=123` — and that returns HTML. The export
 * endpoint for the same sheet is derived from it. A published-to-web CSV
 * link (`/pub?output=csv`, or `/d/e/2PACX…`) already serves CSV and passes
 * through untouched, as does any non-Google URL.
 */
function normalizeSheetUrl(raw) {
    const url = raw.trim();
    const m = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(url);
    if (!m || url.includes("/d/e/") || /output=csv/.test(url))
        return url;
    const gid = /[?#&]gid=(\d+)/.exec(url)?.[1] ?? "0";
    return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}
/**
 * Fetch the sheet and import it. `apply` defaults to true; pass false for a
 * dry-run preview (used by the endpoint so an operator can sanity-check the
 * mapping before turning the schedule loose).
 */
async function runSheetSync(opts) {
    const at = new Date().toISOString();
    const raw = process.env.TRANSACTIONS_SHEET_URL?.trim();
    if (!raw) {
        return { ok: false, at, error: "TRANSACTIONS_SHEET_URL is not set — there is no sheet to sync from." };
    }
    if (running) {
        return { ok: false, at, error: "A sync is already running." };
    }
    running = true;
    const url = normalizeSheetUrl(raw);
    try {
        let res;
        try {
            res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
        }
        catch (err) {
            return finish({ ok: false, at, url, error: `Could not reach Google Sheets: ${err instanceof Error ? err.message : String(err)}` });
        }
        if (!res.ok) {
            return finish({ ok: false, at, url, error: `Google answered ${res.status} for the sheet. If it's 401/403/404, the sheet is not shared as "Anyone with the link — Viewer".` });
        }
        const text = await res.text();
        /* Google serves its sign-in page (or an interstitial) as 200 HTML.
           Reporting that as "no transactions found" would be a lie with a
           plausible face — the single worst kind. */
        if (/^\s*</.test(text) || /<html/i.test(text.slice(0, 500))) {
            return finish({ ok: false, at, url, error: 'The sheet URL returned a web page, not CSV — the sheet is probably not shared as "Anyone with the link — Viewer".' });
        }
        const plan = (0, transactionImport_js_1.planTransactionImport)(text);
        if (plan.errors.length && !plan.rows.length) {
            return finish({ ok: false, at, url, error: plan.errors.join(" | "), rowsSeen: plan.rowsSeen });
        }
        if (opts?.apply === false) {
            return finish({
                ok: true, at, url, rowsSeen: plan.rowsSeen,
                created: plan.create, updated: plan.update, skipped: plan.skip,
                unmappedHeaders: plan.unmappedHeaders, noChanges: plan.create === 0 && plan.update === 0,
            });
        }
        /* Nothing to write means nothing to log — a sync that records an import
           row every N hours forever would bury the real imports in noise. The
           importer updates matched rows unconditionally, so "update: N" here
           means N rows matched, not N rows changed; the run is only skipped when
           the sheet matched nothing at all. */
        if (plan.create === 0 && plan.update === 0) {
            return finish({
                ok: true, at, url, rowsSeen: plan.rowsSeen,
                created: 0, updated: 0, skipped: plan.skip,
                unmappedHeaders: plan.unmappedHeaders, noChanges: true,
            });
        }
        const result = (0, transactionImport_js_1.applyTransactionImport)(plan, { filename: "google-sheet", source: "google-sheet" });
        console.log(`[sheetSync] imported from sheet: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`);
        return finish({
            ok: true, at, url, rowsSeen: result.rowsSeen,
            created: result.created, updated: result.updated, skipped: result.skipped,
            unmappedHeaders: result.unmappedHeaders, noChanges: false,
        });
    }
    finally {
        running = false;
    }
    function finish(r) {
        lastRun = r;
        if (!r.ok)
            console.warn(`[sheetSync] failed: ${r.error}`);
        return r;
    }
}
