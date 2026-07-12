"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleIncomingPayload = handleIncomingPayload;
exports.handleWebhook = handleWebhook;
/**
 * ManyChat (and future) webhook handler. Parse body, call pipeline, return 200.
 * In production mount this as POST /webhook or similar.
 */
const pipeline_js_1 = require("./pipeline.js");
const index_js_1 = require("../integrations/manychat/index.js");
/**
 * Deleted-message handling (Bucket D): when ManyChat forwards event="message_deleted",
 * wait ~2 minutes; if the lead sends nothing else in that window, send just "?".
 * NOTE: requires ManyChat to actually forward a deleted-message event — the default
 * payload today has no event field, so this path is inert until that's wired up.
 */
const pendingDeletedTimers = new Map();
function leadKey(p) {
    return `${p.platform}:${p.userId}`;
}
function scheduleDeletedMessageFallback(payload) {
    const key = leadKey(payload);
    const existing = pendingDeletedTimers.get(key);
    if (existing)
        clearTimeout(existing);
    const waitMs = parsePositiveIntEnv("DELETED_MESSAGE_WAIT_MS", 120000);
    const timer = setTimeout(() => {
        pendingDeletedTimers.delete(key);
        (0, index_js_1.sendDM)(payload.userId, "?").catch((e) => console.warn("[webhook] deleted-message fallback send failed:", e));
    }, waitMs);
    pendingDeletedTimers.set(key, timer);
}
function cancelDeletedMessageFallback(payload) {
    const key = leadKey(payload);
    const existing = pendingDeletedTimers.get(key);
    if (existing) {
        clearTimeout(existing);
        pendingDeletedTimers.delete(key);
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function parsePositiveIntEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return parsed;
}
function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}
function calcHumanDelayMs(reply) {
    // Defaults target a natural 3-5s feel while staying safely under common webhook timeout windows.
    const minMs = parsePositiveIntEnv("HUMAN_DELAY_MIN_MS", 1500);
    const maxMs = parsePositiveIntEnv("HUMAN_DELAY_MAX_MS", 7000);
    const baseMs = parsePositiveIntEnv("HUMAN_DELAY_BASE_MS", 1800);
    const perCharMs = parsePositiveIntEnv("HUMAN_DELAY_PER_CHAR_MS", 45);
    const jitterMs = parsePositiveIntEnv("HUMAN_DELAY_JITTER_MS", 800);
    const jitter = Math.floor(Math.random() * (jitterMs + 1));
    const raw = baseMs + reply.length * perCharMs + jitter;
    const boundedMax = Math.max(minMs, maxMs);
    return clamp(raw, minMs, boundedMax);
}
async function maybeApplyHumanDelay(reply, elapsedMs) {
    if (!reply)
        return;
    const enabled = process.env.HUMAN_DELAY_ENABLED !== "false";
    if (!enabled)
        return;
    // Keep total request time under a safe ceiling for webhook platforms.
    const maxTotalMs = parsePositiveIntEnv("HUMAN_DELAY_MAX_TOTAL_MS", 12000);
    const remaining = maxTotalMs - elapsedMs;
    if (remaining <= 0)
        return;
    const desiredDelay = calcHumanDelayMs(reply);
    const appliedDelay = Math.min(desiredDelay, remaining);
    if (appliedDelay > 0) {
        await sleep(appliedDelay);
    }
}
function parseBody(body) {
    if (!body || typeof body !== "object")
        return null;
    const b = body;
    const platform = typeof b.platform === "string" ? b.platform : "instagram";
    const userId = typeof b.user_id === "string" ? b.user_id : String(b.user_id ?? "");
    const username = typeof b.username === "string" ? b.username : null;
    const message = typeof b.message === "string" ? b.message : "";
    const commentOrDm = b.comment_or_dm === "comment" ? "comment" : "dm";
    const event = b.event === "message_deleted" ? "message_deleted" : "message";
    if (!userId)
        return null;
    return { platform, userId, username, message, commentOrDm, event };
}
async function handleIncomingPayload(payload) {
    if (payload.event === "message_deleted") {
        scheduleDeletedMessageFallback(payload);
        return { status: 200 };
    }
    // A real inbound message supersedes any pending deleted-message "?" fallback.
    cancelDeletedMessageFallback(payload);
    const start = Date.now();
    const { reply } = await (0, pipeline_js_1.run)(payload);
    const elapsed = Date.now() - start;
    await maybeApplyHumanDelay(reply ?? undefined, elapsed);
    return { status: 200, reply: reply ?? undefined };
}
async function handleWebhook(body) {
    try {
        console.log("[webhook] incoming payload:", body === undefined ? "(undefined)" : JSON.stringify(body));
    }
    catch {
        console.log("[webhook] incoming payload: (could not stringify)", body);
    }
    const payload = parseBody(body);
    if (!payload) {
        return { status: 400 };
    }
    return handleIncomingPayload(payload);
}
// Allow running as script for local test
if (process.argv[1]?.endsWith("webhook.ts")) {
    handleWebhook({
        platform: "instagram",
        user_id: "test-user",
        username: "testuser",
        message: "How much is this?",
        comment_or_dm: "dm",
    })
        .then((r) => console.log(r))
        .catch((e) => console.error(e));
}
