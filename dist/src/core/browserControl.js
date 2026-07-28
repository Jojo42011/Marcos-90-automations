"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isConfigured = isConfigured;
exports.tokenMatches = tokenMatches;
exports.status = status;
exports.recordPoll = recordPoll;
exports.submitResult = submitResult;
exports.run = run;
exports.recentActivity = recentActivity;
exports._resetForTests = _resetForTests;
/**
 * 1.2 — Browser control bus.
 *
 * Lets Harvey drive a real browser: navigate, click, fill forms, pull data
 * off pages that have no API (a listing portal, a title company's form, an
 * MLS back office). The extension does the driving; this module is the queue
 * between Harvey and it.
 *
 * Why a queue and not a socket: the server cannot reach into a browser, so
 * the extension polls. Polling is unglamorous but it survives sleeping
 * laptops, dropped wifi and Fly restarts without reconnect logic, and there
 * is no new dependency (the overlay deploy path can't npm install).
 *
 * SECURITY — read before extending this.
 * This is the most dangerous surface in the app: it executes actions in a
 * signed-in human's browser, with their cookies, on their behalf. Three
 * things hold it in check and none of them are optional:
 *   1. A pairing token. Without BROWSER_CONTROL_TOKEN set, the bus refuses
 *      to arm at all — it fails closed, not open.
 *   2. The extension is off by default and the human turns it on per session.
 *      A connected extension that is switched off accepts nothing.
 *   3. Every command is recorded with its result, so what Harvey did to a
 *      browser is auditable after the fact.
 * Deliberately NOT offered: reading cookies, localStorage, password fields,
 * or executing arbitrary JavaScript. Those turn "fill in this form" into
 * "exfiltrate this session", and no use case in the spec needs them.
 */
const crypto_1 = require("crypto");
/** Commands handed out but not yet answered. */
const pending = new Map();
/** Waiting to be picked up by the extension's next poll. */
let queue = [];
/** Rolling audit trail. */
const history = [];
const MAX_HISTORY = 200;
let lastPollAt = 0;
let extensionEnabled = false;
let extensionPage = {};
/** Considered live if it polled recently — the extension polls every ~2s. */
const CONNECTED_WINDOW_MS = 8000;
function isConfigured() {
    return Boolean(process.env.BROWSER_CONTROL_TOKEN?.trim());
}
function tokenMatches(token) {
    const expected = process.env.BROWSER_CONTROL_TOKEN?.trim();
    // Fail closed. An unset token must never mean "everyone is allowed" the way
    // DASHBOARD_TOKEN does elsewhere in this app — the blast radius here is a
    // human's live browser session.
    if (!expected)
        return false;
    return typeof token === "string" && token.trim() === expected;
}
function status() {
    return {
        configured: isConfigured(),
        connected: Date.now() - lastPollAt < CONNECTED_WINDOW_MS,
        enabled: extensionEnabled,
        lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
        queued: queue.length,
        awaitingResult: pending.size,
        page: extensionPage,
    };
}
/** Called on every extension poll. */
function recordPoll(enabled, page) {
    lastPollAt = Date.now();
    extensionEnabled = enabled;
    if (page)
        extensionPage = page;
    // A switched-off extension still polls (so the UI can show it's there) but
    // is handed nothing to run.
    if (!enabled)
        return [];
    const batch = queue;
    queue = [];
    return batch;
}
function submitResult(result) {
    const entry = pending.get(result.id);
    if (!entry)
        return false;
    clearTimeout(entry.timer);
    pending.delete(result.id);
    const full = { ...result, at: new Date().toISOString() };
    if (full.url || full.title)
        extensionPage = { url: full.url, title: full.title };
    const h = history.find((x) => x.command.id === result.id);
    if (h)
        h.result = full;
    entry.resolve(full);
    return true;
}
/**
 * Queue a command and wait for the extension to report back.
 *
 * Resolves with `ok:false` rather than throwing on timeout or a disconnected
 * extension, so Harvey gets a usable explanation ("the extension isn't
 * connected") instead of a stack trace it will paraphrase badly.
 */
function run(command, opts = {}) {
    const s = status();
    if (!s.configured) {
        return Promise.resolve(fail("", "Browser control is not configured — BROWSER_CONTROL_TOKEN is not set on the server."));
    }
    if (!s.connected) {
        return Promise.resolve(fail("", "The Harvey browser extension isn't connected. Open Chrome, make sure the extension is installed and paired."));
    }
    if (!s.enabled) {
        return Promise.resolve(fail("", "The extension is connected but switched OFF. Turn on 'Let Harvey control this browser' in the extension popup."));
    }
    const full = {
        ...command,
        id: (0, crypto_1.randomUUID)(),
        createdAt: new Date().toISOString(),
        issuedBy: opts.issuedBy || "harvey",
    };
    history.unshift({ command: full });
    if (history.length > MAX_HISTORY)
        history.length = MAX_HISTORY;
    queue.push(full);
    const timeoutMs = opts.timeoutMs ?? command.timeoutMs ?? 25_000;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pending.delete(full.id);
            queue = queue.filter((c) => c.id !== full.id);
            const timedOut = fail(full.id, `The browser didn't respond within ${Math.round(timeoutMs / 1000)}s.`);
            const h = history.find((x) => x.command.id === full.id);
            if (h)
                h.result = timedOut;
            resolve(timedOut);
        }, timeoutMs);
        pending.set(full.id, { command: full, resolve, timer });
    });
}
function fail(id, error) {
    return { id, ok: false, error, at: new Date().toISOString() };
}
/** Audit trail — what Harvey did to this browser. */
function recentActivity(limit = 20) {
    return history.slice(0, limit).map((h) => ({
        action: h.command.action,
        selector: h.command.selector,
        url: h.command.url,
        at: h.command.createdAt,
        ok: h.result?.ok,
        error: h.result?.error,
        issuedBy: h.command.issuedBy,
    }));
}
/** Test hook — resets bus state between runs. */
function _resetForTests() {
    for (const p of pending.values())
        clearTimeout(p.timer);
    pending.clear();
    queue = [];
    history.length = 0;
    lastPollAt = 0;
    extensionEnabled = false;
    extensionPage = {};
}
