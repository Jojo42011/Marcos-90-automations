"use strict";
/**
 * Give Harvey the web, using the browser extension we already have.
 *
 * WHY THE BROWSER AND NOT AN API. The operator chose this path knowing the
 * trade: a search API can run unattended at 3am, and the browser cannot — it
 * needs Marco's Chrome open and armed. What the browser buys in exchange is
 * real: it reads the page a person would see, including sources behind a login
 * (MLS, a paid portal) that no search API can reach, and it needs no new vendor,
 * key or subscription.
 *
 * NO EXTENSION CHANGE. Everything here composes actions the installed extension
 * already understands — `navigate`, `extract`, `read`, `waitFor`. `pageExtract`
 * supports an `"a.result @href"` attribute syntax and returns hrefs already
 * resolved to absolute URLs, which is the one primitive that makes search-result
 * scraping possible from the server. So this ships without Marco reinstalling
 * anything.
 *
 * THE RULE THIS MODULE EXISTS TO KEEP: an empty result set and a broken scraper
 * look identical from the outside, and only one of them means "nothing was
 * found". Search-engine markup changes without warning, so every failure here is
 * reported as a failure — never flattened into "no results".
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchWeb = searchWeb;
exports.readWebPage = readWebPage;
exports.webResearchAvailable = webResearchAvailable;
const browserControl_js_1 = require("./browserControl.js");
/** Page text beyond this is noise for a research read; say so rather than truncate silently. */
const MAX_PAGE_CHARS = 14_000;
const NAV_TIMEOUT_MS = 30_000;
const DEFAULT_RESULTS = 6;
const MAX_RESULTS = 10;
/** DuckDuckGo hides the real URL behind /l/?uddg=<encoded>. */
function ddgUnwrap(href) {
    try {
        const u = new URL(href, "https://duckduckgo.com");
        const target = u.searchParams.get("uddg");
        return target ? decodeURIComponent(target) : href;
    }
    catch {
        return href;
    }
}
/** Bing sometimes routes through /ck/a?...&u=a1<base64url>. */
function bingUnwrap(href) {
    try {
        const u = new URL(href, "https://www.bing.com");
        if (!/\/ck\/a/.test(u.pathname))
            return href;
        const raw = u.searchParams.get("u");
        if (!raw || !raw.startsWith("a1"))
            return href;
        const b64 = raw.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        const decoded = Buffer.from(b64, "base64").toString("utf8");
        return /^https?:\/\//i.test(decoded) ? decoded : href;
    }
    catch {
        return href;
    }
}
const ENGINES = [
    {
        name: "duckduckgo",
        // The no-JS endpoint: plain server-rendered HTML, far more stable to read
        // than the app, and no scripts to wait on.
        url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
        schema: {
            titles: ".result__a",
            urls: ".result__a @href",
            snippets: ".result__snippet",
        },
        unwrap: ddgUnwrap,
        ready: ".result__a",
    },
    {
        name: "bing",
        url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
        schema: {
            titles: "#b_results .b_algo h2 a",
            urls: "#b_results .b_algo h2 a @href",
            snippets: "#b_results .b_algo .b_caption p",
        },
        unwrap: bingUnwrap,
        ready: "#b_results .b_algo h2 a",
    },
];
/* ───────────────────── browser preflight ───────────────────── */
/**
 * Why the browser can't be used right now, in words the operator can act on.
 *
 * Returning null means it is usable. Everything else is a specific, fixable
 * state — "not configured" and "closed" and "switched off" need different
 * actions, and collapsing them into "browser unavailable" sends someone
 * hunting in the wrong place.
 */
function browserProblem() {
    const s = (0, browserControl_js_1.status)();
    if (!s.configured) {
        return "Browser control is not configured on the server (BROWSER_CONTROL_TOKEN is not set).";
    }
    if (!s.connected) {
        return "No paired browser is connected. Open Chrome with the Harvey extension installed, then try again.";
    }
    if (!s.enabled) {
        return "The paired browser is connected but switched OFF. Arm it in the extension popup (or ask me to switch it on) and try again.";
    }
    return null;
}
/* ───────────────────────── helpers ───────────────────────── */
/**
 * Navigate, retrying once when the failure looks like a cold start.
 *
 * The extension creates its work window lazily, on the first command. That
 * first navigate pays the window-creation cost and can exceed the 25s server
 * timeout, or come back "No page open to act on yet" — so the FIRST search of a
 * session could fail for no reason other than being first. A research task that
 * dies on its opening move is a bad enough failure to be worth one retry.
 *
 * Only transient-looking failures are retried. A genuine dead site says so
 * ("showing an error page") and is returned immediately rather than making the
 * operator wait through a pointless second attempt.
 */
async function navigateWarm(url, device) {
    const go = () => (0, browserControl_js_1.run)({ action: "navigate", url, focus: false, timeoutMs: NAV_TIMEOUT_MS }, { device, timeoutMs: NAV_TIMEOUT_MS + 8000 });
    const first = await go();
    if (first.ok)
        return first;
    const cold = /didn't respond|did not respond|No page open/i.test(first.error || "");
    if (!cold)
        return first;
    const second = await go();
    return second.ok ? second : first; // report the ORIGINAL error, not the echo
}
function asList(v) {
    if (Array.isArray(v))
        return v.map((x) => String(x ?? "").trim());
    if (v == null || v === "")
        return [];
    return [String(v).trim()];
}
/**
 * Search pages are full of internal links; only outbound http(s) is a result.
 *
 * Filtered by HOST, not by path. Pattern-matching the paths an engine happens to
 * use today ("/search", "/l/") misses the rest — pagination, "more results",
 * settings, related-search chips — and each one that slips through becomes a
 * result Harvey may try to read and cite. No engine's own domain is ever a
 * source, so the whole host goes.
 */
const ENGINE_HOSTS = /(^|\.)(duckduckgo\.com|bing\.com|google\.[a-z.]+|search\.yahoo\.com|ecosia\.org|startpage\.com)$/i;
function usableUrl(u) {
    if (!/^https?:\/\//i.test(u))
        return false;
    try {
        return !ENGINE_HOSTS.test(new URL(u).hostname);
    }
    catch {
        return false;
    }
}
/* ───────────────────────── search ───────────────────────── */
/**
 * Search the web by driving the paired browser.
 *
 * Tries each engine until one yields results. If every engine returns nothing,
 * that is reported as a SCRAPE FAILURE rather than an empty result set —
 * because after a markup change those are the same observation, and calling it
 * "no results found" would turn a broken tool into a confident wrong answer.
 */
async function searchWeb(query, opts = {}) {
    const q = String(query || "").trim();
    const limit = Math.min(Math.max(Number(opts.limit) || DEFAULT_RESULTS, 1), MAX_RESULTS);
    if (!q)
        return { ok: false, query: q, results: [], error: "A search query is required." };
    const problem = browserProblem();
    if (problem) {
        return { ok: false, query: q, results: [], error: problem, browserProblem: problem };
    }
    const tried = [];
    for (const engine of ENGINES) {
        tried.push(engine.name);
        const nav = await navigateWarm(engine.url(q), opts.device);
        if (!nav.ok)
            continue; // engine unreachable — try the next one
        // Results are server-rendered, but a slow network still beats us to the read.
        await (0, browserControl_js_1.run)({ action: "waitFor", selector: engine.ready, timeoutMs: 8000 }, { device: opts.device, timeoutMs: 16_000 });
        const ex = await (0, browserControl_js_1.run)({ action: "extract", schema: engine.schema }, { device: opts.device, timeoutMs: 25_000 });
        if (!ex.ok || !ex.data || typeof ex.data !== "object")
            continue;
        const d = ex.data;
        const titles = asList(d.titles);
        const urls = asList(d.urls).map((u) => (engine.unwrap ? engine.unwrap(u) : u));
        const snippets = asList(d.snippets);
        const results = [];
        const seen = new Set();
        for (let i = 0; i < urls.length && results.length < limit; i++) {
            const url = urls[i];
            if (!usableUrl(url) || seen.has(url))
                continue;
            seen.add(url);
            results.push({
                title: titles[i] || url,
                url,
                snippet: snippets[i] || "",
            });
        }
        if (results.length) {
            return {
                ok: true,
                engine: engine.name,
                query: q,
                results,
                note: "Snippets only. Call read_web_page on a result to read the actual source before relying on it.",
            };
        }
    }
    return {
        ok: false,
        query: q,
        results: [],
        error: `Could not read search results from ${tried.join(" or ")}. This is a SCRAPE FAILURE, not an empty result set — ` +
            "the engines' markup may have changed, or the page did not load in the browser.",
        note: "Do not report this as 'nothing found'. Say the search itself failed.",
    };
}
/* ─────────────────────── read a page ─────────────────────── */
/**
 * Open a URL in the paired browser and return its readable text.
 *
 * This is the half a search API cannot do: snippets are not sources. It is also
 * the half that works on a page behind a login, because it is the operator's own
 * signed-in browser.
 */
async function readWebPage(url, opts = {}) {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) {
        return { ok: false, error: "Give a full URL starting with http:// or https://" };
    }
    const problem = browserProblem();
    if (problem)
        return { ok: false, error: problem, browserProblem: problem };
    const nav = await navigateWarm(target, opts.device);
    if (!nav.ok) {
        return { ok: false, url: target, error: nav.error || "The page did not load." };
    }
    const read = await (0, browserControl_js_1.run)({ action: "read", selector: opts.selector || undefined }, { device: opts.device, timeoutMs: 30_000 });
    if (!read.ok) {
        return { ok: false, url: nav.url || target, title: nav.title, error: read.error || "Could not read the page." };
    }
    const raw = typeof read.data === "string" ? read.data : JSON.stringify(read.data ?? "");
    const text = raw.replace(/\n{3,}/g, "\n\n").trim();
    const truncated = text.length > MAX_PAGE_CHARS;
    /* A login wall reads as a short page about signing in. Saying so is the
       difference between "this source had nothing" and "I could not see it". */
    const needsLogin = Boolean(read.meta?.needsLogin);
    return {
        ok: true,
        url: read.url || nav.url || target,
        title: read.title || nav.title,
        text: truncated ? text.slice(0, MAX_PAGE_CHARS) : text,
        truncated,
        needsLogin,
        note: needsLogin
            ? "This page is behind a sign-in wall. What came back is the login page, NOT the source — say so rather than summarising it."
            : truncated
                ? `Truncated at ${MAX_PAGE_CHARS} characters. Say the read was partial if it matters.`
                : undefined,
    };
}
/** Whether these tools should be offered at all. */
function webResearchAvailable() {
    return (0, browserControl_js_1.status)().configured;
}
