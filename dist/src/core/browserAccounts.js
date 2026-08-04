"use strict";
/**
 * Harvey Connect accounts — one pairing token per person, not one for everyone.
 *
 * THE PROBLEM THIS FIXES. There was a single `BROWSER_CONTROL_TOKEN`, so
 * Marco, Carlos and Wesley all pasted the same string into their extensions.
 * Every browser then landed in ONE pool: an unaddressed command went to
 * whoever ranked highest by priority, so two people working at the same time
 * fought over the bus, and a command meant for one desk ran on another's
 * signed-in browser. Revoking one person meant rotating the token for all.
 *
 * Each account now has its own token. A browser belongs to the account whose
 * token it paired with, commands resolve inside that account, and a chat
 * opened from the extension only ever drives that account's own browsers.
 * Revoking one person is deleting one line.
 *
 * CONFIGURATION. `BROWSER_CONTROL_TOKENS` holds `name:token` pairs separated
 * by newlines or commas:
 *
 *     BROWSER_CONTROL_TOKENS="marco:abc123,carlos:def456,wesley:ghi789"
 *
 * The legacy single `BROWSER_CONTROL_TOKEN` still works and becomes an account
 * of its own, so nothing breaks for a browser that is already paired — this
 * ships without anyone having to re-pair on the day it deploys.
 *
 * SECURITY. Comparison is length-safe and constant-time-ish (see `sameToken`),
 * tokens are never logged or returned by any endpoint, and an unset config
 * still fails CLOSED: no accounts means nothing can pair, exactly as before.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isConfigured = isConfigured;
exports.resolveAccount = resolveAccount;
exports.listAccounts = listAccounts;
exports.accountById = accountById;
exports._resetAccountCache = _resetAccountCache;
const crypto_1 = require("crypto");
/* Parsed on demand rather than at import: env can be set after module load in
   tests, and Fly injects secrets before boot either way. Cached against the
   raw strings so a normal request does no parsing work. */
let cache = null;
function rawConfig() {
    const multi = process.env.BROWSER_CONTROL_TOKENS?.trim() || "";
    const single = process.env.BROWSER_CONTROL_TOKEN?.trim() || "";
    return `${multi}${single}`;
}
function slug(name) {
    return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "account";
}
function parse() {
    const raw = rawConfig();
    if (cache && cache.raw === raw)
        return cache.accounts;
    const accounts = [];
    const seenIds = new Set();
    const seenTokens = new Set();
    const multi = process.env.BROWSER_CONTROL_TOKENS?.trim() || "";
    for (const entry of multi.split(/[\n,]+/)) {
        const line = entry.trim();
        if (!line || line.startsWith("#"))
            continue;
        /* Split on the FIRST colon only: a token may legitimately contain colons,
           and silently truncating someone's token would look like a typo'd
           password rather than a config bug. */
        const idx = line.indexOf(":");
        if (idx <= 0)
            continue;
        const name = line.slice(0, idx).trim();
        const token = line.slice(idx + 1).trim();
        if (!name || !token)
            continue;
        let id = slug(name);
        /* Two accounts named the same would silently merge their device pools —
           the exact interference this module exists to end. Suffix instead. */
        let n = 2;
        while (seenIds.has(id))
            id = `${slug(name)}-${n++}`;
        /* A token reused across two accounts is ambiguous: the first match would
           win and the second person would silently act as the first. Drop it. */
        if (seenTokens.has(token)) {
            console.warn(`[browser-accounts] duplicate token for "${name}" ignored — give each account its own`);
            continue;
        }
        seenIds.add(id);
        seenTokens.add(token);
        accounts.push({ id, name, token, legacy: false });
    }
    const single = process.env.BROWSER_CONTROL_TOKEN?.trim() || "";
    if (single && !seenTokens.has(single)) {
        const name = process.env.BROWSER_CONTROL_TOKEN_NAME?.trim() || "Marco";
        let id = slug(name);
        let n = 2;
        while (seenIds.has(id))
            id = `${slug(name)}-${n++}`;
        accounts.push({ id, name, token: single, legacy: true });
    }
    cache = { raw, accounts };
    return accounts;
}
/** Length-safe constant-time compare — never leaks token length by returning early. */
function sameToken(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) {
        // Still burn a comparison so a wrong-length guess isn't measurably faster.
        (0, crypto_1.timingSafeEqual)(ab, ab);
        return false;
    }
    return (0, crypto_1.timingSafeEqual)(ab, bb);
}
/** Any account configured at all. Unset config = nothing can pair (fail closed). */
function isConfigured() {
    return parse().length > 0;
}
/** Which account a pairing token belongs to, or null when it matches none. */
function resolveAccount(token) {
    if (typeof token !== "string")
        return null;
    const t = token.trim();
    if (!t)
        return null;
    for (const a of parse()) {
        if (sameToken(a.token, t))
            return { id: a.id, name: a.name, legacy: a.legacy };
    }
    return null;
}
/** Accounts without their tokens — safe to show an operator. */
function listAccounts() {
    return parse().map(({ id, name, legacy }) => ({ id, name, legacy }));
}
function accountById(id) {
    const hit = parse().find((a) => a.id === id.trim().toLowerCase());
    return hit ? { id: hit.id, name: hit.name, legacy: hit.legacy } : null;
}
/** Test hook — forces a re-read after env changes. */
function _resetAccountCache() {
    cache = null;
}
