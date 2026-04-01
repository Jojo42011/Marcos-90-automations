"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleIncomingPayload = handleIncomingPayload;
exports.handleWebhook = handleWebhook;
/**
 * ManyChat (and future) webhook handler. Parse body, call pipeline, return 200 JSON { reply }.
 * No artificial delay before responding — keeps ManyChat External Request within typical timeouts.
 *
 * Instagram comment automation (first touch, no comment text in ManyChat):
 * omit `message` from the JSON body. Send e.g.
 *   { "platform": "instagram", "user_id": "<IG username>", "username": "<full name>", "comment_or_dm": "comment" }
 * The pipeline creates the lead and returns a fixed handshake line; the first DM supplies `message` and runs the AI flow.
 *
 * TikTok (Marco DMs first manually): on the subscriber’s first reply webhook, include the exact opener Marco
 * sent in-app as `marco_previous_outbound` so the server seeds that assistant line before `message`.
 */
const pipeline_js_1 = require("./pipeline.js");
const marcoLog_js_1 = require("./marcoLog.js");
function isPlainObject(v) {
    return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
/**
 * ManyChat / Make / custom proxies often nest fields or use different names than our web demo.
 * Merge known keys from nested objects so Instagram traffic matches what /simulate sends.
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
/** Explicit full name fields (ManyChat / Make). */
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
/**
 * ManyChat often maps Instagram Username → user_id and Full Name → username.
 * Store handle on Lead.username and full name on Lead.name when we can tell them apart.
 */
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
async function handleIncomingPayload(payload, log) {
    const requestId = log?.requestId ?? (0, marcoLog_js_1.newMarcoRequestId)();
    const correlationId = log?.correlationId ?? (0, marcoLog_js_1.marcoCorrelationId)(payload.platform, payload.userId);
    const ctx = { requestId, correlationId };
    const start = Date.now();
    const { reply } = await (0, pipeline_js_1.run)(payload, ctx);
    const elapsed = Date.now() - start;
    (0, marcoLog_js_1.marcoLog)("request_complete", {
        requestId,
        correlationId,
        pipeline_ms: elapsed,
        total_ms: elapsed,
        reply_chars: reply?.length ?? 0,
        reply_preview: (0, marcoLog_js_1.previewText)(reply),
    });
    return { status: 200, reply: reply ?? undefined };
}
async function handleWebhook(body) {
    const payload = parseBody(body);
    if (!payload) {
        (0, marcoLog_js_1.marcoLog)("inbound_rejected", { reason: "parse_body_failed_or_missing_user_id" });
        return { status: 400 };
    }
    const requestId = (0, marcoLog_js_1.newMarcoRequestId)();
    const correlationId = (0, marcoLog_js_1.marcoCorrelationId)(payload.platform, payload.userId);
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
    try {
        const keys = body && typeof body === "object" && !Array.isArray(body)
            ? Object.keys(body).slice(0, 60)
            : [];
        (0, marcoLog_js_1.marcoLogDebug)("inbound_raw_top_keys", { requestId, correlationId, keys });
    }
    catch {
        /* ignore */
    }
    (0, marcoLog_js_1.marcoLogDebug)("inbound_raw_json", {
        requestId,
        correlationId,
        body_preview: (0, marcoLog_js_1.previewText)((() => {
            try {
                return JSON.stringify(body);
            }
            catch {
                return "";
            }
        })(), 500),
    });
    return handleIncomingPayload(payload, { requestId, correlationId });
}
// Allow running as script for local test
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
