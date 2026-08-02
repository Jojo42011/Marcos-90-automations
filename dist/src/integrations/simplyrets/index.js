"use strict";
/**
 * SimplyRETS — the live MLS feed for SABOR (San Antonio Board of REALTORS).
 *
 * Vendor `sabor`, served through LERA. Plain REST + HTTP Basic auth, NOT the
 * RESO Web API: `GET https://api.simplyrets.com/properties` with
 * `Authorization: Basic base64(username:password)`.
 *
 * CREDENTIAL SHAPE, because it is genuinely confusing on the dashboard: the
 * column reads "Username/Server token" and shows the vendor name, while the
 * USERNAME is the account id (`pmarco_…`) and the PASSWORD is the 16-character
 * value issued alongside it. Both are required; the username alone authorises
 * nothing.
 *
 * PAGINATION is a `Link: …; rel="next"` header, not a page count — SimplyRETS
 * sends no `X-Total-Count`, so the only honest way to know whether more remain
 * is to follow the link until it stops appearing.
 *
 * SYNC IS TWO-PHASE, and it has to be. There is no "modified since" filter —
 * only `sort=-modified` (newest change first). So the steady state is a walk
 * from the top that stops at the first listing already held (`stopAtModified`).
 *
 * That alone is NOT enough. If the first pull is capped before reaching the
 * bottom of the board, a top-walk stops at record #1 on every later run and the
 * listings below the cap are never fetched — a mirror permanently missing its
 * older half while reporting itself healthy. So until the board has been walked
 * to the end once, sync runs in BACKFILL mode using `offset`, and only switches
 * to the incremental top-walk after a page comes back empty.
 *
 * NOTHING IS FAKED WHEN UNCONFIGURED. Missing credentials return an explicit
 * failure naming the variable, never an empty listing array — "no listings" and
 * "not switched on" look identical from the outside and only one of them means
 * the market is quiet.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.simplyRetsConfig = simplyRetsConfig;
exports.isMlsFeedConfigured = isMlsFeedConfigured;
exports.fetchProperties = fetchProperties;
exports.mlsPing = mlsPing;
const DEFAULT_BASE = "https://api.simplyrets.com";
/** SimplyRETS accepts 500; larger pages just mean fewer round trips. */
const PAGE_SIZE = 500;
const REQUEST_TIMEOUT_MS = 45_000;
function simplyRetsConfig() {
    const username = process.env.SIMPLYRETS_USERNAME?.trim();
    const password = process.env.SIMPLYRETS_PASSWORD?.trim();
    const vendor = process.env.SIMPLYRETS_VENDOR?.trim() || null;
    const baseUrl = (process.env.SIMPLYRETS_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
    if (!username) {
        return {
            ok: false,
            error: "MLS feed is not configured: SIMPLYRETS_USERNAME is not set.",
            fix: "Set SIMPLYRETS_USERNAME to the account id from the SimplyRETS credentials page (e.g. pmarco_…).",
        };
    }
    if (!password) {
        return {
            ok: false,
            error: "MLS feed is not configured: SIMPLYRETS_PASSWORD is not set.",
            fix: "Set SIMPLYRETS_PASSWORD to the password issued with that username. The username on its own authorises nothing.",
        };
    }
    return { baseUrl, username, password, vendor };
}
function isMlsFeedConfigured() {
    return !("ok" in simplyRetsConfig());
}
function authHeader(cfg) {
    return "Basic " + Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
}
/** SimplyRETS paginates with a Link header; pull out the rel="next" target. */
function nextLinkFrom(header) {
    if (!header)
        return null;
    for (const part of header.split(",")) {
        const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim());
        if (m)
            return m[1];
    }
    return null;
}
async function getPage(url, cfg) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { Authorization: authHeader(cfg), Accept: "application/json" },
            signal: ctl.signal,
        });
        const text = await res.text();
        if (!res.ok) {
            const fix = res.status === 401
                ? "SimplyRETS rejected the credentials. Check SIMPLYRETS_USERNAME and SIMPLYRETS_PASSWORD are the pair from the credentials page."
                : res.status === 403
                    ? "Authenticated but not authorised for this data. Check the vendor is active on the SimplyRETS account."
                    : undefined;
            return { ok: false, error: `SimplyRETS returned ${res.status}: ${text.slice(0, 300)}`, fix };
        }
        const body = JSON.parse(text);
        return {
            ok: true,
            records: Array.isArray(body) ? body : [],
            next: nextLinkFrom(res.headers.get("link")),
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            error: /abort/i.test(msg) ? `SimplyRETS did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.` : msg,
        };
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchProperties(opts = {}) {
    const cfg = simplyRetsConfig();
    if ("ok" in cfg)
        return cfg;
    const max = Math.max(1, opts.maxRecords ?? 2000);
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(PAGE_SIZE, max)));
    /* Newest change first. Also makes paging deterministic — an unsorted walk can
       repeat or skip rows as the feed shifts underneath it. */
    params.set("sort", "-modified");
    if (cfg.vendor)
        params.set("vendor", cfg.vendor);
    if (opts.offset && opts.offset > 0)
        params.set("offset", String(opts.offset));
    let url = `${cfg.baseUrl}/properties?${params.toString()}`;
    const records = [];
    let reachedKnown = false;
    let exhausted = false;
    let guard = 0;
    while (url && records.length < max && !reachedKnown) {
        /* A self-referential next link would otherwise spin forever against a
           metered API. */
        if (++guard > 200)
            break;
        const page = await getPage(url, cfg);
        if ("error" in page) {
            /* Keep what already succeeded rather than discarding a partial pull. */
            if (records.length)
                return { ok: true, records: records.slice(0, max), truncated: true, exhausted: false };
            return page;
        }
        for (const rec of page.records) {
            const mod = typeof rec.modified === "string" ? rec.modified : null;
            if (opts.stopAtModified && mod && mod <= opts.stopAtModified) {
                reachedKnown = true;
                break;
            }
            records.push(rec);
            if (records.length >= max)
                break;
        }
        /* An empty page is the feed telling us there is nothing further down.
           That, not a record count, is what ends a backfill. */
        if (!page.records.length) {
            exhausted = true;
            break;
        }
        if (!page.next) {
            exhausted = true;
            break;
        }
        url = page.next;
    }
    return {
        ok: true,
        records: records.slice(0, max),
        /* Only "truncated" if the cap stopped us, not if we stopped because we
           caught up — those mean very different things to the caller. */
        truncated: !reachedKnown && !exhausted && records.length >= max,
        exhausted,
    };
}
/**
 * Cheapest call that proves the credentials work, used by the status endpoint.
 *
 * Returns the field names the feed ACTUALLY sends, because a mapping built
 * against documentation and a mapping built against the live payload are not
 * the same thing, and the difference shows up as a wrong price in a DM.
 */
async function mlsPing() {
    const cfg = simplyRetsConfig();
    if ("ok" in cfg)
        return cfg;
    const params = new URLSearchParams({ limit: "1" });
    if (cfg.vendor)
        params.set("vendor", cfg.vendor);
    const page = await getPage(`${cfg.baseUrl}/properties?${params.toString()}`, cfg);
    if ("error" in page)
        return page;
    const first = page.records[0] ?? null;
    return {
        ok: true,
        vendor: cfg.vendor,
        sampleFields: first ? Object.keys(first).sort() : [],
        sample: first
            ? {
                mlsId: first.mlsId,
                listingId: first.listingId,
                listPrice: first.listPrice,
                status: first.mls?.status,
                city: first.address?.city,
                modified: first.modified,
            }
            : null,
    };
}
