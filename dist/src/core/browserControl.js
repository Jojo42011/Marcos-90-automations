"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isConfigured = isConfigured;
exports.tokenMatches = tokenMatches;
exports.status = status;
exports.requestDisarm = requestDisarm;
exports.requestArm = requestArm;
exports.armLocked = armLocked;
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
/** Longest the server will hold a poll open. Must stay under Chrome's 30s
 *  service-worker idle kill, or the extension dies mid-wait. */
const MAX_LONG_POLL_MS = 20000;
/** Considered live if it polled recently. With long polling a healthy
 *  extension answers at least every MAX_LONG_POLL_MS, so the window has to
 *  clear that plus round-trip — 8s was right for 2s polling and would have
 *  reported a perfectly healthy browser as disconnected. */
const CONNECTED_WINDOW_MS = MAX_LONG_POLL_MS + 10000;
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
/**
 * Ask the extension to switch itself off at its next poll.
 *
 * Deliberately one-way: the server can DISARM a browser but can never arm
 * one. Arming has to stay a physical act by the human at the keyboard —
 * otherwise "turn it on" becomes something anyone holding the pairing token
 * can do to a signed-in browser. Turning it off is the safe direction, so
 * that half is allowed remotely.
 *
 * Exists because Harvey used to answer "browser control is now off" when he
 * had no way to do it — the toggle lived only in the popup. Saying it without
 * doing it is worse than refusing, since the operator then believes a control
 * is off while it is still armed.
 */
let disarmRequested = false;
let armRequested = false;
/** Set by the extension when the human has locked out remote arming. */
let armLockedByUser = false;
function requestDisarm() {
    const s = status();
    if (!s.connected)
        return { alreadyOff: !s.enabled, connected: false };
    if (!s.enabled)
        return { alreadyOff: true, connected: true };
    armRequested = false;
    disarmRequested = true;
    wakeWaiters();
    // Anything already queued must not run in the window before the extension
    // polls and disarms — "off" has to mean off immediately.
    queue = [];
    return { alreadyOff: false, connected: true };
}
/**
 * Ask the extension to switch itself on.
 *
 * This is the one control that can escalate rather than reduce capability, so
 * it is bounded on purpose:
 *   - it does nothing unless a human has already paired this browser, and
 *   - the human can set a lock in the popup that refuses it outright.
 *
 * The operator asked for it after finding that "turn it back on" was the only
 * step he still had to leave the conversation to do. The honest trade is
 * stated in the popup rather than hidden: anyone holding the pairing token can
 * re-arm a paired browser unless the lock is on.
 */
function requestArm() {
    const s = status();
    if (!s.connected)
        return { alreadyOn: s.enabled, connected: false, locked: armLockedByUser };
    if (armLockedByUser)
        return { alreadyOn: s.enabled, connected: true, locked: true };
    if (s.enabled)
        return { alreadyOn: true, connected: true, locked: false };
    disarmRequested = false;
    armRequested = true;
    wakeWaiters();
    return { alreadyOn: false, connected: true, locked: false };
}
function armLocked() {
    return armLockedByUser;
}
let waiters = [];
function wakeWaiters() {
    if (!waiters.length)
        return;
    const batch = waiters;
    waiters = [];
    for (const w of batch) {
        clearTimeout(w.timer);
        w.resolve(drain());
    }
}
/** Close out parked polls with an empty answer without handing them work. */
function retireWaiters() {
    if (!waiters.length)
        return;
    const batch = waiters;
    waiters = [];
    for (const w of batch) {
        clearTimeout(w.timer);
        w.resolve({ commands: [], disarm: false, arm: false });
    }
}
/** Hand over whatever is pending right now. */
function drain() {
    if (disarmRequested)
        return { commands: [], disarm: true, arm: false };
    if (armRequested)
        return { commands: [], disarm: false, arm: true };
    if (!extensionEnabled)
        return { commands: [], disarm: false, arm: false };
    const batch = queue;
    queue = [];
    return { commands: batch, disarm: false, arm: false };
}
/** Called on every extension poll. */
function recordPoll(enabled, page, opts = {}) {
    lastPollAt = Date.now();
    extensionEnabled = enabled;
    if (page)
        extensionPage = page;
    if (typeof opts.armLock === "boolean")
        armLockedByUser = opts.armLock;
    // Clear the one-shot directives once the extension confirms the new state,
    // so a poll that crossed the request in flight doesn't drop the instruction.
    if (disarmRequested && !enabled)
        disarmRequested = false;
    if (armRequested && enabled)
        armRequested = false;
    // Retire any older parked poll before doing anything else.
    //
    // There is one browser on this bus, so a newer poll means every earlier one
    // is stale — its socket may already be dead (laptop slept, wifi dropped,
    // browser closed). Left in place, a dead waiter still wins the race in
    // wakeWaiters(), drains the queue, and resolves into a socket nobody is
    // reading: the command is silently lost and the caller is told "the browser
    // didn't respond" about a browser that is sitting right there. Closing them
    // out with an empty answer is harmless — the extension re-polls — and it
    // guarantees commands can only ever go to the live connection.
    retireWaiters();
    const immediate = drain();
    const hasWork = immediate.commands.length > 0 || immediate.disarm || immediate.arm;
    const waitMs = Math.min(Math.max(Number(opts.waitMs) || 0, 0), MAX_LONG_POLL_MS);
    if (hasWork || waitMs === 0)
        return immediate;
    return new Promise((resolve) => {
        const w = {
            resolve,
            // Time out with an empty answer rather than holding forever: the
            // extension re-polls, which doubles as the liveness signal `connected`
            // depends on.
            timer: setTimeout(() => {
                waiters = waiters.filter((x) => x !== w);
                resolve({ commands: [], disarm: false, arm: false });
            }, waitMs),
        };
        waiters.push(w);
        opts.onAbort?.(() => {
            clearTimeout(w.timer);
            waiters = waiters.filter((x) => x !== w);
            resolve({ commands: [], disarm: false, arm: false });
        });
    });
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
    // Hand it straight to a parked long poll instead of letting it sit until the
    // next timer tick — this is where the latency saving actually lands.
    wakeWaiters();
    // `command.timeoutMs` is how long the PAGE should keep waiting; this timer is
    // how long the SERVER waits for an answer. Treating them as the same number
    // guarantees the server gives up a moment before the browser replies, and the
    // caller sees "the browser didn't respond" for a command that worked. Add
    // headroom for the round trip.
    const timeoutMs = opts.timeoutMs
        ?? (command.timeoutMs ? command.timeoutMs + 8000 : undefined)
        ?? 25_000;
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
