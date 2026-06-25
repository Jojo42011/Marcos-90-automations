"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleIncomingPayload = handleIncomingPayload;
exports.handleWebhook = handleWebhook;
/**
 * ManyChat (and future) webhook handler. Parse body, call pipeline, return 200 JSON { reply }.
 *
 * Instagram DMs arrive via POST /webhook (ManyChat External Request) with flat JSON:
 *   { "platform": "instagram", "user_id": "...", "message": "...", "comment_or_dm": "dm" }
 * NOT via Meta Graph API entry[0].messaging (optional fallback parser included).
 *
 * Instagram comment automation (first touch, no comment text in ManyChat):
 * omit `message` from the JSON body. Send e.g.
 *   { "platform": "instagram", "user_id": "<IG username>", "username": "<full name>", "comment_or_dm": "comment" }
 */
const pipeline_js_1 = require("./pipeline.js");
const conversationUtils_js_1 = require("./conversationUtils.js");
const marcoLog_js_1 = require("./marcoLog.js");
const IG_DEBOUNCE_MS = 4000;
/** Prevent overlapping pipeline runs for the same lead. */
const processingLeads = new Set();
function leadProcessingKey(platform, userId) {
    return `${platform}:${userId}`;
}
function extractMessageHandle(rawBody) {
    if (!rawBody || typeof rawBody !== "object")
        return null;
    const b = normalizeWebhookRecord(rawBody);
    const keys = [
        "message_handle",
        "messageHandle",
        "message_id",
        "messageId",
        "mid",
        "ig_mid",
        "igMid",
        "last_message_id",
        "lastMessageId",
    ];
    for (const k of keys) {
        const v = b[k];
        if (typeof v === "string" && v.trim())
            return v.trim();
        if (typeof v === "number" && Number.isFinite(v))
            return String(v);
    }
    return null;
}
/** Instagram-only burst queue — module level so it persists across requests. */
const igMessageQueue = {};
/** Prevent overlapping batch processing for the same sender. */
const igProcessingSenders = new Set();
function isInstagramPlatform(platform) {
    return platform.toLowerCase().includes("insta");
}
function isPlainObject(v) {
    return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
/**
 * TEMP DIAGNOSTIC — remove after ManyChat image-URL capture test.
 * Set DEBUG_RAW_WEBHOOK=true to log the full inbound JSON for Instagram DMs only.
 * TODO(cleanup): delete logRawWebhookPayloadForDiagnostic + call site once payload is captured.
 */
function logRawWebhookPayloadForDiagnostic(body) {
    if (process.env.DEBUG_RAW_WEBHOOK?.trim().toLowerCase() !== "true")
        return;
    if (!isPlainObject(body))
        return;
    const platform = String(body.platform ?? "").toLowerCase();
    const commentOrDm = body.comment_or_dm ?? body.commentOrDm;
    const isInstagramDm = platform.includes("insta") && commentOrDm !== "comment" && commentOrDm !== "Comment";
    if (!isInstagramDm)
        return;
    console.log("[DIAGNOSTIC-RAW-PAYLOAD]", JSON.stringify(body));
}
/**
 * Meta Graph API Instagram DM shape (if ever wired directly):
 * entry[0].messaging[0].sender.id / .message.text / .message.is_echo
 */
function tryParseMetaInstagramDm(body) {
    const entry = body.entry;
    if (!Array.isArray(entry) || !isPlainObject(entry[0]))
        return null;
    const messaging = entry[0].messaging;
    if (!Array.isArray(messaging) || !isPlainObject(messaging[0]))
        return null;
    const m = messaging[0];
    const sender = m.sender;
    const message = m.message;
    if (!isPlainObject(sender) || !isPlainObject(message))
        return null;
    const senderId = sender.id;
    if (senderId === undefined || senderId === null)
        return null;
    const text = typeof message.text === "string" ? message.text.trim() : "";
    return {
        senderId: String(senderId),
        text,
        isEcho: message.is_echo === true,
    };
}
/**
 * Stable Instagram sender key for the queue.
 * Prefer ManyChat subscriber_id (numeric) over username so every tap hits the same queue.
 */
function extractInstagramSenderId(rawBody, parsed) {
    if (rawBody && typeof rawBody === "object") {
        const meta = tryParseMetaInstagramDm(rawBody);
        if (meta?.senderId)
            return meta.senderId;
    }
    const b = normalizeWebhookRecord(rawBody && typeof rawBody === "object" ? rawBody : {});
    const stableKeys = [
        "subscriber_id",
        "subscriberId",
        "contact_id",
        "contactId",
    ];
    for (const k of stableKeys) {
        const v = b[k];
        if (typeof v === "string" && v.trim())
            return v.trim();
        if (typeof v === "number" && Number.isFinite(v))
            return String(v);
    }
    if (isPlainObject(b.subscriber)) {
        const sid = b.subscriber.id ?? b.subscriber.subscriber_id ?? b.subscriber.subscriberId;
        if (typeof sid === "string" && sid.trim())
            return sid.trim();
        if (typeof sid === "number" && Number.isFinite(sid))
            return String(sid);
    }
    if (isPlainObject(b.contact)) {
        const cid = b.contact.id ?? b.contact.contact_id;
        if (typeof cid === "string" && cid.trim())
            return cid.trim();
        if (typeof cid === "number" && Number.isFinite(cid))
            return String(cid);
    }
    return parsed.userId;
}
function extractInstagramMessageText(rawBody, parsed) {
    if (rawBody && typeof rawBody === "object") {
        const meta = tryParseMetaInstagramDm(rawBody);
        if (meta)
            return meta.text;
    }
    return parsed.message.trim();
}
function isInstagramEcho(rawBody) {
    if (!rawBody || typeof rawBody !== "object")
        return false;
    const body = rawBody;
    const meta = tryParseMetaInstagramDm(body);
    if (meta?.isEcho)
        return true;
    if (body.is_echo === true || body.isEcho === true)
        return true;
    if (body.message_echo === true || body.messageEcho === true)
        return true;
    return false;
}
/**
 * Flush Instagram DM batch: one pipeline run; last waiter gets reply, earlier waiters get none.
 */
async function flushInstagramDm(senderId) {
    const entry = igMessageQueue[senderId];
    if (!entry)
        return;
    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }
    delete igMessageQueue[senderId];
    const combinedInput = entry.messages.join(" ");
    const payloadTemplate = entry.payloadTemplate;
    const batchLog = entry.log;
    const waiters = entry.waiters;
    const lastWaiter = waiters[waiters.length - 1];
    if (waiters.length > 1) {
        console.log(`[ig] Batching ${waiters.length} webhooks for ${senderId}`);
    }
    console.log(`Processing for ${senderId}: "${combinedInput}"`);
    if (igProcessingSenders.has(senderId)) {
        console.log(`[ig] Skipping duplicate batch for ${senderId} — already processing`);
        for (const w of waiters) {
            w.resolve({ status: 200, reply: undefined });
        }
        return;
    }
    const leadLockKey = leadProcessingKey(payloadTemplate.platform, payloadTemplate.userId);
    if (processingLeads.has(leadLockKey)) {
        console.log(`[webhook] Lead ${leadLockKey} already processing — dropping duplicate IG batch`);
        for (const w of waiters) {
            w.resolve({ status: 200, reply: undefined });
        }
        return;
    }
    igProcessingSenders.add(senderId);
    processingLeads.add(leadLockKey);
    try {
        const payload = {
            ...payloadTemplate,
            message: combinedInput,
        };
        const start = Date.now();
        const { reply } = await (0, pipeline_js_1.run)(payload, batchLog);
        const elapsed = Date.now() - start;
        (0, marcoLog_js_1.marcoLog)("request_complete", {
            requestId: batchLog.requestId,
            correlationId: batchLog.correlationId,
            pipeline_ms: elapsed,
            total_ms: elapsed,
            debounced: true,
            ig_sender_id: senderId,
            reply_chars: reply?.length ?? 0,
            reply_preview: (0, marcoLog_js_1.previewText)(reply),
        });
        if (reply) {
            console.log(`[ig] One reply for ${senderId} (${reply.length} chars): ${(0, marcoLog_js_1.previewText)(reply, 120)}`);
        }
        const result = {
            status: 200,
            reply: reply ?? undefined,
        };
        for (const w of waiters) {
            if (w === lastWaiter) {
                w.resolve(result);
            }
            else {
                w.resolve({ status: 200, reply: undefined });
            }
        }
    }
    catch (err) {
        console.error(`[ig] Batch processing failed for ${senderId}:`, err);
        for (const w of waiters) {
            w.reject(err);
        }
    }
    finally {
        igProcessingSenders.delete(senderId);
        processingLeads.delete(leadLockKey);
    }
}
/**
 * Instagram DM hybrid debounce: holds HTTP open until timer + pipeline complete.
 * Only the last webhook in a burst receives `reply`; earlier ones get reply undefined.
 */
function enqueueInstagramDm(senderId, messageText, payload, log) {
    return new Promise((resolve, reject) => {
        if (!igMessageQueue[senderId]) {
            igMessageQueue[senderId] = {
                timer: null,
                messages: [],
                payloadTemplate: payload,
                log,
                waiters: [],
            };
        }
        const userQueue = igMessageQueue[senderId];
        userQueue.payloadTemplate = payload;
        userQueue.log = log;
        userQueue.waiters.push({ resolve, reject });
        if (messageText) {
            if (!userQueue.messages.includes(messageText)) {
                userQueue.messages.push(messageText);
                console.log(`Queued for ${senderId}: "${messageText}" - queue size: ${userQueue.messages.length}`);
            }
            else {
                console.log(`Duplicate ignored for ${senderId}: "${messageText}"`);
            }
        }
        if (userQueue.timer) {
            clearTimeout(userQueue.timer);
            console.log(`Timer reset for ${senderId}`);
        }
        userQueue.timer = setTimeout(() => {
            void flushInstagramDm(senderId);
        }, IG_DEBOUNCE_MS);
    });
}
/**
 * ManyChat / Make / custom proxies often nest fields or use different names than our web demo.
 */
function normalizeWebhookRecord(body) {
    const out = { ...body };
    const mergeKeys = [
        "user_id",
        "userId",
        "subscriber_id",
        "subscriberId",
        "message",
        "last_input_text",
        "last_input",
        "text",
        "body",
        "message_text",
        "input",
        "username",
        "user_name",
        "full_name",
        "fullName",
        "display_name",
        "displayName",
        "name",
        "instagram_username",
        "instagram_handle",
        "platform",
        "comment_or_dm",
        "marco_previous_outbound",
        "marcoPreviousOutbound",
        "marco_last_outbound",
        "marcoLastOutbound",
        "manual_marco_opener",
        "manualMarcoOpener",
    ];
    const mergeFrom = (inner, mapInnerIdToUserId) => {
        if (!isPlainObject(inner))
            return;
        for (const k of mergeKeys) {
            const v = inner[k];
            const cur = out[k];
            const empty = cur === undefined || cur === null || cur === "";
            if (empty && v != null && v !== "") {
                out[k] = v;
            }
        }
        if (mapInnerIdToUserId) {
            const curUid = out.user_id ?? out.userId;
            const emptyUid = curUid === undefined || curUid === null || curUid === "";
            if (emptyUid) {
                const sid = inner.id ?? inner.subscriber_id ?? inner.subscriberId;
                if (typeof sid === "string" && sid.trim()) {
                    out.user_id = sid.trim();
                }
                else if (typeof sid === "number" && Number.isFinite(sid)) {
                    out.user_id = String(sid);
                }
            }
        }
    };
    mergeFrom(body.data, false);
    mergeFrom(body.contact, true);
    mergeFrom(body.subscriber, true);
    return out;
}
function pickUserId(b) {
    const keys = ["user_id", "userId", "subscriber_id", "subscriberId", "contact_id", "contactId"];
    for (const k of keys) {
        const v = b[k];
        if (typeof v === "string" && v.trim())
            return v.trim();
        if (typeof v === "number" && Number.isFinite(v))
            return String(v);
    }
    return "";
}
function pickMarcoPreviousOutbound(b) {
    const keys = [
        "marco_previous_outbound",
        "marcoPreviousOutbound",
        "marco_last_outbound",
        "marcoLastOutbound",
        "manual_marco_opener",
        "manualMarcoOpener",
    ];
    for (const k of keys) {
        const v = b[k];
        if (typeof v === "string" && v.trim())
            return v.trim();
    }
    return null;
}
function pickMessage(b) {
    const keys = [
        "message",
        "last_input_text",
        "last_input",
        "text",
        "body",
        "message_text",
        "input",
        "user_message",
        "content",
    ];
    for (const k of keys) {
        const v = b[k];
        if (typeof v === "string")
            return v.trim();
    }
    return "";
}
function pickUsername(b) {
    const keys = ["username", "user_name", "handle", "ig_username", "instagram_username", "name"];
    for (const k of keys) {
        const v = b[k];
        if (typeof v === "string" && v.trim())
            return v.trim();
    }
    return null;
}
function pickExplicitDisplayName(b) {
    const keys = ["full_name", "fullName", "display_name", "displayName", "name"];
    for (const k of keys) {
        const v = b[k];
        if (typeof v === "string" && v.trim())
            return v.trim();
    }
    return null;
}
function looksLikePersonFullName(s) {
    const t = s.trim();
    return t.length > 1 && /\s/.test(t) && /[a-zA-Z]/.test(t);
}
function resolveHandleAndDisplayName(b, userId) {
    const explicit = pickExplicitDisplayName(b);
    if (explicit && explicit.trim() !== userId.trim()) {
        return { handle: userId, displayName: explicit };
    }
    const raw = typeof b.username === "string" ? b.username.trim() : "";
    if (raw && raw !== userId && looksLikePersonFullName(raw)) {
        return { handle: userId, displayName: raw };
    }
    const legacy = pickUsername(b);
    if (legacy && legacy === userId) {
        return { handle: userId, displayName: null };
    }
    if (legacy && legacy !== userId && !looksLikePersonFullName(legacy)) {
        return { handle: legacy, displayName: null };
    }
    return { handle: userId, displayName: null };
}
function parseBody(body) {
    if (!body || typeof body !== "object")
        return null;
    const meta = tryParseMetaInstagramDm(body);
    if (meta && !meta.isEcho) {
        return {
            platform: "instagram",
            userId: meta.senderId,
            username: null,
            displayName: null,
            message: meta.text,
            commentOrDm: "dm",
            marcoPreviousOutbound: null,
        };
    }
    const b = normalizeWebhookRecord(body);
    const platform = typeof b.platform === "string" ? b.platform : "instagram";
    const userId = pickUserId(b);
    const { handle, displayName } = resolveHandleAndDisplayName(b, userId);
    const message = pickMessage(b);
    const commentOrDm = b.comment_or_dm === "comment" || b.comment_or_dm === "Comment" ? "comment" : "dm";
    if (!userId)
        return null;
    if (!message.trim() && commentOrDm !== "comment") {
        console.warn("[webhook] inbound message text is empty after parsing; check ManyChat JSON field names. Keys present:", Object.keys(b).slice(0, 40).join(", "));
    }
    return {
        platform,
        userId,
        username: handle,
        displayName,
        message,
        commentOrDm,
        marcoPreviousOutbound: pickMarcoPreviousOutbound(b),
    };
}
/**
 * Direct pipeline entry — used by Twilio/Sinch SMS, TikTok, and Instagram comment handshakes.
 */
async function handleIncomingPayload(payload, log) {
    const requestId = log?.requestId ?? (0, marcoLog_js_1.newMarcoRequestId)();
    const correlationId = log?.correlationId ?? (0, marcoLog_js_1.marcoCorrelationId)(payload.platform, payload.userId);
    const ctx = { requestId, correlationId };
    const lockKey = leadProcessingKey(payload.platform, payload.userId);
    if (processingLeads.has(lockKey)) {
        console.log(`[webhook] Lead ${lockKey} already processing — dropping duplicate request`);
        return { status: 200, reply: undefined };
    }
    processingLeads.add(lockKey);
    const start = Date.now();
    try {
        const { reply } = await (0, pipeline_js_1.run)(payload, ctx);
        const elapsed = Date.now() - start;
        (0, marcoLog_js_1.marcoLog)("request_complete", {
            requestId,
            correlationId,
            pipeline_ms: elapsed,
            total_ms: elapsed,
            debounced: false,
            reply_chars: reply?.length ?? 0,
            reply_preview: (0, marcoLog_js_1.previewText)(reply),
        });
        return { status: 200, reply: reply ?? undefined };
    }
    finally {
        processingLeads.delete(lockKey);
    }
}
/**
 * POST /webhook and POST /simulate entry.
 * Instagram DMs: hybrid debounce — hold HTTP until 4s silence + pipeline; last waiter gets reply.
 * TikTok / other: synchronous pipeline (unchanged).
 */
async function handleWebhook(body) {
    logRawWebhookPayloadForDiagnostic(body);
    if (isInstagramEcho(body)) {
        console.log("[ig] Echo message ignored");
        return { status: 200 };
    }
    const messageHandle = extractMessageHandle(body);
    if (messageHandle && (0, conversationUtils_js_1.isDuplicateHandle)(messageHandle)) {
        (0, marcoLog_js_1.marcoLog)("inbound_rejected", { reason: "duplicate_message_handle", message_handle: messageHandle });
        return { status: 200 };
    }
    const payload = parseBody(body);
    if (!payload) {
        (0, marcoLog_js_1.marcoLog)("inbound_rejected", { reason: "parse_body_failed_or_missing_user_id" });
        return { status: 400 };
    }
    const requestId = (0, marcoLog_js_1.newMarcoRequestId)();
    const correlationId = (0, marcoLog_js_1.marcoCorrelationId)(payload.platform, payload.userId);
    const log = { requestId, correlationId };
    (0, marcoLog_js_1.marcoLog)("inbound_accepted", {
        requestId,
        correlationId,
        platform: payload.platform,
        comment_or_dm: payload.commentOrDm,
        message_chars: payload.message.length,
        message_preview: (0, marcoLog_js_1.previewText)(payload.message),
        username_set: Boolean(payload.username),
        display_name_set: Boolean(payload.displayName),
        marco_previous_outbound_set: Boolean(payload.marcoPreviousOutbound?.trim()),
    });
    const isIg = isInstagramPlatform(payload.platform) && payload.commentOrDm === "dm";
    if (isIg) {
        if (!payload.message.trim()) {
            return handleIncomingPayload(payload, log);
        }
        const senderId = extractInstagramSenderId(body, payload);
        const messageText = extractInstagramMessageText(body, payload);
        console.log(`[ig] Inbound from sender ${senderId} (lead key ${payload.userId})`);
        return await enqueueInstagramDm(senderId, messageText, payload, log);
    }
    if (!payload.message.trim()) {
        return handleIncomingPayload(payload, log);
    }
    return handleIncomingPayload(payload, log);
}
if (process.argv[1]?.endsWith("webhook.ts")) {
    handleWebhook({
        platform: "instagram",
        user_id: "test-user",
        username: "Test User",
        comment_or_dm: "comment",
    })
        .then((r) => console.log(r))
        .catch((e) => console.error(e));
}
