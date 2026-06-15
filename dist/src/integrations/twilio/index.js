"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTwilioConfigured = isTwilioConfigured;
exports.normalizeToE164 = normalizeToE164;
exports.normalizeToUsE164 = normalizeToUsE164;
exports.sendTwilioMessage = sendTwilioMessage;
exports.validateTwilioSignature = validateTwilioSignature;
exports.claimTwilioInboundSid = claimTwilioInboundSid;
/**
 * Twilio — outbound SMS and inbound webhook helpers.
 *
 * Env:
 * - TWILIO_ACCOUNT_SID
 * - TWILIO_AUTH_TOKEN
 * - TWILIO_FROM_NUMBER (E.164)
 * - TWILIO_WEBHOOK_AUTH_TOKEN (optional; defaults to TWILIO_AUTH_TOKEN for signature validation)
 */
const twilio_1 = __importDefault(require("twilio"));
const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
const fromNumber = process.env.TWILIO_FROM_NUMBER?.trim();
let client = null;
const processedInboundSids = new Map();
const MAX_SID_CACHE = 4000;
function rememberSid(sid) {
    if (!sid)
        return true;
    if (processedInboundSids.has(sid))
        return false;
    processedInboundSids.set(sid, Date.now());
    if (processedInboundSids.size > MAX_SID_CACHE) {
        const cutoff = Date.now() - 48 * 3600000;
        for (const [h, t] of processedInboundSids) {
            if (t < cutoff)
                processedInboundSids.delete(h);
        }
    }
    return true;
}
function getClient() {
    if (!client) {
        if (!accountSid || !authToken) {
            throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured");
        }
        client = (0, twilio_1.default)(accountSid, authToken);
    }
    return client;
}
function isTwilioConfigured() {
    return Boolean(accountSid && authToken && fromNumber);
}
/** US E.164 for Twilio `to` / `from`. */
function normalizeToE164(phone) {
    const t = phone.trim();
    if (t.startsWith("+")) {
        const d = t.replace(/\D/g, "");
        if (d.length === 11 && d.startsWith("1"))
            return `+${d}`;
        if (d.length === 10)
            return `+1${d}`;
        return t;
    }
    const d = t.replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("1"))
        return `+${d}`;
    if (d.length === 10)
        return `+1${d}`;
    return t.startsWith("+") ? t : `+${d}`;
}
/** Alias matching legacy Sendblue helper name used across server routes. */
function normalizeToUsE164(input) {
    return normalizeToE164(input);
}
function resolveSendArgs(toOrParams, content) {
    if (typeof toOrParams === "string") {
        return { to: toOrParams, body: content ?? "" };
    }
    return { to: toOrParams.to, body: toOrParams.content };
}
/**
 * Send an SMS via Twilio REST API.
 * Accepts `(to, content)` or `{ to, content }` for drop-in compatibility.
 */
async function sendTwilioMessage(toOrParams, content) {
    const { to, body } = resolveSendArgs(toOrParams, content);
    if (!isTwilioConfigured()) {
        console.warn("[Twilio] Not configured — skipping send to", to);
        return { success: false, error: "Twilio not configured" };
    }
    const trimmed = body.trim();
    if (!trimmed) {
        return { success: false, error: "Message content is empty." };
    }
    try {
        const toE164 = normalizeToE164(to);
        const message = await getClient().messages.create({
            body: trimmed,
            from: fromNumber,
            to: toE164,
        });
        console.log("[Twilio] Sent message", message.sid, "to", toE164);
        return { success: true, messageSid: message.sid };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Twilio] Send error:", msg);
        return { success: false, error: msg };
    }
}
/**
 * Validate an inbound Twilio webhook request signature.
 */
function validateTwilioSignature(signature, url, params) {
    const token = process.env.TWILIO_WEBHOOK_AUTH_TOKEN?.trim() || authToken;
    if (!token) {
        console.warn("[Twilio] No webhook auth token configured — skipping signature validation (INSECURE)");
        return true;
    }
    return twilio_1.default.validateRequest(token, signature, url, params);
}
/** Idempotent: returns false if this MessageSid was already processed in-process. */
function claimTwilioInboundSid(messageSid) {
    if (!messageSid?.trim())
        return true;
    return rememberSid(messageSid.trim());
}
