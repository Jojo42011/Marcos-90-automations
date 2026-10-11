"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_ATTEMPTS = void 0;
exports.claimScheduled = claimScheduled;
exports.markUncertain = markUncertain;
exports.scheduleMessage = scheduleMessage;
exports.listScheduled = listScheduled;
exports.getScheduled = getScheduled;
exports.dueMessages = dueMessages;
exports.cancelScheduled = cancelScheduled;
exports.markSent = markSent;
exports.markAttemptFailed = markAttemptFailed;
exports.rescheduleMessage = rescheduleMessage;
exports.scheduledCounts = scheduledCounts;
const atomicJson_js_1 = require("./atomicJson.js");
const tenantData_js_1 = require("./tenantData.js");
/** Account-local scheduled messages. Pending and unresolved work is never pruned. */
const fs_1 = require("fs");
const crypto_1 = require("crypto");
function resolvePath() {
    const explicit = process.env.SCHEDULED_MESSAGES_PATH?.trim();
    if (explicit)
        return explicit;
    if ((0, fs_1.existsSync)((0, tenantData_js_1.dataPath)("")))
        return (0, tenantData_js_1.dataPath)("scheduled-messages.json");
    return (0, tenantData_js_1.dataPath)("scheduled-messages.json");
}
const PATH = resolvePath();
const MAX_KEPT = 5000;
/** Give up after this many tries so a bad number can't retry forever. */
exports.MAX_ATTEMPTS = 3;
let state = { messages: [] };
let loaded = false;
let committed = JSON.stringify(state);
function load() {
    if (loaded)
        return;
    if ((0, fs_1.existsSync)(PATH)) {
        const data = JSON.parse((0, fs_1.readFileSync)(PATH, "utf8"));
        if (!data || !Array.isArray(data.messages))
            throw new Error("Invalid scheduled message store; preserved for recovery");
        state = data;
        // A provider may have accepted an interrupted send. Never automatically replay it.
        for (const message of state.messages)
            if (message.status === "sending") {
                message.status = "uncertain";
                message.error = "Delivery interrupted; verify with the provider before scheduling another send.";
            }
    }
    committed = JSON.stringify(state);
    loaded = true;
}
function persist() {
    try {
        const terminal = state.messages.filter(m => ["sent", "canceled"].includes(m.status));
        const keep = new Set(terminal.slice(-MAX_KEPT).map(m => m.id));
        state.messages = state.messages.filter(m => !["sent", "canceled"].includes(m.status) || keep.has(m.id));
        (0, atomicJson_js_1.atomicJson)(PATH, state);
        committed = JSON.stringify(state);
    }
    catch (error) {
        state = JSON.parse(committed);
        throw error;
    }
}
function claimScheduled(id) {
    load();
    const message = state.messages.find(m => m.id === id && m.status === "pending");
    if (!message)
        return;
    message.status = "sending";
    message.attempts++;
    persist();
    return { ...message };
}
function markUncertain(id, error) {
    load();
    const message = state.messages.find(m => m.id === id);
    if (!message)
        return;
    message.status = "uncertain";
    message.error = error;
    persist();
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
    if (m.status !== "sending")
        m.attempts += 1;
    m.error = error;
    m.status = m.attempts >= exports.MAX_ATTEMPTS ? "failed" : "pending";
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
    const out = { pending: 0, sending: 0, uncertain: 0, sent: 0, failed: 0, canceled: 0 };
    for (const m of state.messages)
        out[m.status]++;
    return out;
}
