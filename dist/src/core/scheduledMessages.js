"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_ATTEMPTS = void 0;
exports.scheduleMessage = scheduleMessage;
exports.listScheduled = listScheduled;
exports.getScheduled = getScheduled;
exports.dueMessages = dueMessages;
exports.cancelScheduled = cancelScheduled;
exports.markSent = markSent;
exports.markAttemptFailed = markAttemptFailed;
exports.rescheduleMessage = rescheduleMessage;
exports.scheduledCounts = scheduledCounts;
/**
 * Scheduled sending — queue a text or an email to go out later.
 *
 * Two ways in, both landing in the same queue:
 *   1. The user picks a send time in the CRM.
 *   2. Harvey queues it, either at a time described in plain language
 *      ("send this Tuesday morning") or at a suggested good hour.
 *
 * File-backed JSON on the /data volume, same pattern as teamStore — the
 * volume is what makes a queue survive the deploys this app does constantly.
 *
 * IMPORTANT — this queue is real, but delivery depends on credentials this
 * app does not currently have. As of 2026-07-28 Twilio is unconfigured and
 * the Gmail refresh token is dead, so a due message will attempt, fail, and
 * be recorded `status: "failed"` with the provider's reason. That is the
 * honest behaviour: nothing is silently dropped and nothing pretends to have
 * sent. `canSendOn()` lets callers say so up front instead of queueing into
 * a channel that cannot deliver.
 */
const fs_1 = require("fs");
const path_1 = require("path");
const crypto_1 = require("crypto");
function resolvePath() {
    const explicit = process.env.SCHEDULED_MESSAGES_PATH?.trim();
    if (explicit)
        return explicit;
    if ((0, fs_1.existsSync)("/data"))
        return "/data/scheduled-messages.json";
    return (0, path_1.join)(process.cwd(), "data", "scheduled-messages.json");
}
const PATH = resolvePath();
const MAX_KEPT = 5000;
/** Give up after this many tries so a bad number can't retry forever. */
exports.MAX_ATTEMPTS = 3;
let state = { messages: [] };
let loaded = false;
function load() {
    if (loaded)
        return;
    loaded = true;
    try {
        if (!(0, fs_1.existsSync)(PATH))
            return;
        const raw = (0, fs_1.readFileSync)(PATH, "utf8");
        if (!raw.trim())
            return;
        const data = JSON.parse(raw);
        state.messages = Array.isArray(data.messages) ? data.messages : [];
    }
    catch (err) {
        console.error("[scheduled] load failed:", err);
    }
}
function persist() {
    try {
        (0, fs_1.mkdirSync)((0, path_1.dirname)(PATH), { recursive: true });
        if (state.messages.length > MAX_KEPT) {
            state.messages = state.messages.slice(-MAX_KEPT);
        }
        (0, fs_1.writeFileSync)(PATH, JSON.stringify(state), "utf8");
    }
    catch (err) {
        console.error("[scheduled] persist failed:", err);
    }
}
const nowIso = () => new Date().toISOString();
function scheduleMessage(input) {
    load();
    const entry = {
        id: (0, crypto_1.randomUUID)(),
        leadId: input.leadId,
        leadName: input.leadName || "",
        channel: input.channel,
        to: input.to,
        subject: input.subject,
        body: input.body,
        sendAt: input.sendAt,
        status: "pending",
        createdBy: input.createdBy,
        requestedTime: input.requestedTime,
        createdAt: nowIso(),
        attempts: 0,
    };
    state.messages.push(entry);
    persist();
    return entry;
}
/** Newest-scheduled first. */
function listScheduled(opts = {}) {
    load();
    let out = state.messages.slice();
    if (opts.status)
        out = out.filter((m) => m.status === opts.status);
    if (opts.leadId)
        out = out.filter((m) => m.leadId === opts.leadId);
    if (opts.channel)
        out = out.filter((m) => m.channel === opts.channel);
    out.sort((a, b) => b.sendAt.localeCompare(a.sendAt));
    return opts.limit ? out.slice(0, opts.limit) : out;
}
function getScheduled(id) {
    load();
    return state.messages.find((m) => m.id === id);
}
/** Pending and due now. */
function dueMessages(at = new Date()) {
    load();
    const cutoff = at.toISOString();
    return state.messages.filter((m) => m.status === "pending" && m.sendAt <= cutoff);
}
function cancelScheduled(id) {
    load();
    const m = state.messages.find((x) => x.id === id);
    // Only a pending message can be canceled — "cancel" on something already
    // sent would be a lie.
    if (!m || m.status !== "pending")
        return false;
    m.status = "canceled";
    persist();
    return true;
}
function markSent(id) {
    load();
    const m = state.messages.find((x) => x.id === id);
    if (!m)
        return;
    m.status = "sent";
    m.sentAt = nowIso();
    m.attempts += 1;
    persist();
}
/**
 * Record a failed attempt. Stays `pending` for another try until
 * MAX_ATTEMPTS, then sticks as `failed` with the last error — so a transient
 * outage recovers on its own but a genuinely bad address stops.
 */
function markAttemptFailed(id, error) {
    load();
    const m = state.messages.find((x) => x.id === id);
    if (!m)
        return;
    m.attempts += 1;
    m.error = error;
    if (m.attempts >= exports.MAX_ATTEMPTS)
        m.status = "failed";
    persist();
}
/** Reschedule a pending message. Returns false if it already went out. */
function rescheduleMessage(id, sendAt) {
    load();
    const m = state.messages.find((x) => x.id === id);
    if (!m || m.status !== "pending")
        return false;
    m.sendAt = sendAt;
    persist();
    return true;
}
function scheduledCounts() {
    load();
    const out = { pending: 0, sent: 0, failed: 0, canceled: 0 };
    for (const m of state.messages)
        out[m.status]++;
    return out;
}
