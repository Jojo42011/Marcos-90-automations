"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendSMS = sendSMS;
exports.receiveInbound = receiveInbound;
/**
 * Sinch Conversation API — outbound SMS and inbound webhook parsing.
 */
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const SINCH_BASE = "https://us.conversation.api.sinch.com";
const REQUIRED_SEND_ENV = [
    "SINCH_PROJECT_ID",
    "SINCH_ACCESS_KEY",
    "SINCH_ACCESS_SECRET",
    "SINCH_APP_ID",
    "SINCH_SENDER_NUMBER",
];
let warnedMissingEnv = false;
function warnMissingSinchSendEnv() {
    if (warnedMissingEnv)
        return;
    warnedMissingEnv = true;
    const missing = REQUIRED_SEND_ENV.filter((k) => !process.env[k]?.trim());
    if (missing.length) {
        console.warn("[Sinch] Missing env vars — sendSMS disabled until set:", missing.join(", "));
    }
}
function getSendConfig() {
    warnMissingSinchSendEnv();
    const projectId = process.env.SINCH_PROJECT_ID?.trim();
    const accessKey = process.env.SINCH_ACCESS_KEY?.trim();
    const accessSecret = process.env.SINCH_ACCESS_SECRET?.trim();
    const appId = process.env.SINCH_APP_ID?.trim();
    const senderNumber = process.env.SINCH_SENDER_NUMBER?.trim();
    if (!projectId || !accessKey || !accessSecret || !appId || !senderNumber) {
        return null;
    }
    return { projectId, accessKey, accessSecret, appId, senderNumber };
}
/**
 * Send an SMS via Sinch Conversation API messages:send.
 * Returns false if env incomplete or request fails (logs, does not throw).
 */
async function sendSMS(toNumber, message) {
    const cfg = getSendConfig();
    if (!cfg) {
        return false;
    }
    const url = `${SINCH_BASE}/v1/projects/${cfg.projectId}/messages:send`;
    const body = {
        app_id: cfg.appId,
        recipient: {
            identified_by: {
                channel_identities: [{ channel: "SMS", identity: toNumber }],
            },
        },
        message: { text_message: { text: message } },
        channel_properties: { SMS_SENDER: cfg.senderNumber },
    };
    try {
        await axios_1.default.post(url, body, {
            auth: {
                username: cfg.accessKey,
                password: cfg.accessSecret,
            },
            headers: { "Content-Type": "application/json" },
            timeout: 20000,
        });
        return true;
    }
    catch (err) {
        console.error("[Sinch] sendSMS failed:", err);
        return false;
    }
}
function isRecord(x) {
    return typeof x === "object" && x !== null && !Array.isArray(x);
}
/** Find first text_message.text in nested object (depth-limited). */
function extractTextMessageText(obj, depth = 0) {
    if (depth > 12 || !isRecord(obj))
        return null;
    const tm = obj.text_message;
    if (isRecord(tm) && typeof tm.text === "string" && tm.text.trim()) {
        return tm.text.trim();
    }
    for (const v of Object.values(obj)) {
        if (v === null || v === undefined)
            continue;
        if (typeof v === "object") {
            const found = extractTextMessageText(v, depth + 1);
            if (found)
                return found;
        }
    }
    return null;
}
/** Find first SMS channel identity string in nested object. */
function extractSmsIdentity(obj, depth = 0) {
    if (depth > 12 || obj === null || obj === undefined)
        return null;
    if (Array.isArray(obj)) {
        for (const item of obj) {
            const found = extractSmsIdentity(item, depth + 1);
            if (found)
                return found;
        }
        return null;
    }
    if (!isRecord(obj))
        return null;
    const identities = obj.channel_identities;
    if (Array.isArray(identities)) {
        for (const id of identities) {
            if (!isRecord(id))
                continue;
            if (id.channel === "SMS" && typeof id.identity === "string" && id.identity.trim()) {
                return id.identity.trim();
            }
        }
    }
    for (const v of Object.values(obj)) {
        if (typeof v === "object" && v !== null) {
            const found = extractSmsIdentity(v, depth + 1);
            if (found)
                return found;
        }
    }
    return null;
}
/**
 * Map Sinch inbound callback body to our pipeline shape.
 * Supports common nested layouts (message + contact, or wrapped events).
 */
function receiveInbound(payload) {
    if (!isRecord(payload))
        return null;
    const messageBlob = isRecord(payload.message) ? payload.message : payload;
    const text = extractTextMessageText(messageBlob) || extractTextMessageText(payload);
    const userId = extractSmsIdentity(payload) ||
        extractSmsIdentity(messageBlob) ||
        (typeof payload.contact_id === "string" ? payload.contact_id.trim() : null) ||
        (typeof payload.contactId === "string" ? payload.contactId.trim() : null);
    if (!userId || !text) {
        return null;
    }
    return {
        platform: "sms",
        userId,
        username: null,
        displayName: null,
        message: text,
        commentOrDm: "dm",
        marcoPreviousOutbound: null,
        listingRef: null,
    };
}
