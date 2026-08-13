"use strict";
/**
 * Quo — Marco's business phone line (SMS + calls).
 *
 * Base URL https://api.quo.com. Authentication is the API key sent RAW in the
 * Authorization header: `Authorization: <key>`, with no "Bearer " prefix.
 * Quo's own docs call this out explicitly, and sending Bearer fails with 401.
 *
 * WHAT THE ACCOUNT ACTUALLY LOOKS LIKE (measured against the live workspace
 * before any of this was written, because it changes the design):
 *   - one number, "Primary" +1 737 283 4703 (PNo1mCxawI)
 *   - 286 conversations, and the LARGE majority are calls, not texts
 * That last point is the important one. `GET /v1/conversations` returns call
 * threads and message threads in one list with nothing on the row to tell them
 * apart, so the only way to know a thread has texts is to ask for its messages
 * and see. A sync that assumed "conversation = text thread" would fill the CRM
 * with hundreds of empty call logs pretending to be SMS.
 *
 * The other shape that dictates the code: `GET /v1/messages` REQUIRES both
 * `phoneNumberId` and `participants`. There is no "give me the inbox" call, so
 * a full sync is necessarily conversations-first, then messages per thread.
 * Arrays go on the query string as a repeated single-valued key
 * (`participants=%2B1210...`) — `participants[]=` is rejected as "Expected
 * array", which is a confusing error for the syntax that usually means array.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuoError = void 0;
exports.getQuoApiKey = getQuoApiKey;
exports.isQuoConfigured = isQuoConfigured;
exports.getQuoPhoneNumberId = getQuoPhoneNumberId;
exports.getQuoPhoneNumber = getQuoPhoneNumber;
exports.listPhoneNumbers = listPhoneNumbers;
exports.listConversations = listConversations;
exports.listMessages = listMessages;
exports.sendText = sendText;
exports.listWebhooks = listWebhooks;
exports.ensureMessageWebhook = ensureMessageWebhook;
exports.checkQuo = checkQuo;
exports.quoWebhookSecret = quoWebhookSecret;
exports.phoneKey = phoneKey;
exports.toE164 = toE164;
const crypto_1 = require("crypto");
const BASE = "https://api.quo.com";
function getQuoApiKey() {
    return process.env.QUO_API_KEY?.trim() || null;
}
function isQuoConfigured() {
    return Boolean(getQuoApiKey());
}
/** The number texts are sent from. Discovered from the API when not pinned. */
function getQuoPhoneNumberId() {
    return process.env.QUO_PHONE_NUMBER_ID?.trim() || null;
}
function getQuoPhoneNumber() {
    return process.env.QUO_PHONE_NUMBER?.trim() || null;
}
class QuoError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = "QuoError";
    }
}
exports.QuoError = QuoError;
async function call(path, init = {}) {
    const key = getQuoApiKey();
    if (!key)
        throw new QuoError("QUO_API_KEY is not set", 0);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 25000);
    try {
        const res = await fetch(BASE + path, {
            method: init.method || "GET",
            headers: {
                /* Raw key, NOT "Bearer <key>" — Quo rejects the bearer form. */
                Authorization: key,
                ...(init.body ? { "Content-Type": "application/json" } : {}),
            },
            body: init.body ? JSON.stringify(init.body) : undefined,
            signal: ctrl.signal,
        });
        const text = await res.text();
        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        }
        catch {
            parsed = { raw: text.slice(0, 400) };
        }
        if (!res.ok) {
            const msg = (parsed && typeof parsed === "object" && "message" in parsed
                ? String(parsed.message)
                : "") || `HTTP ${res.status}`;
            throw new QuoError(`Quo ${init.method || "GET"} ${path} failed: ${msg}`, res.status, parsed);
        }
        return parsed;
    }
    catch (err) {
        if (err instanceof QuoError)
            throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new QuoError(`Quo ${init.method || "GET"} ${path} failed: ${msg}`, 0);
    }
    finally {
        clearTimeout(timer);
    }
}
async function listPhoneNumbers() {
    const res = await call("/v1/phone-numbers");
    return res.data || [];
}
/** All conversations, following pagination. Calls AND texts — see the header. */
async function listConversations(opts = {}) {
    const out = [];
    let token = null;
    const maxPages = opts.maxPages ?? 20;
    for (let page = 0; page < maxPages; page++) {
        const params = new URLSearchParams({ maxResults: "100" });
        if (token)
            params.set("pageToken", token);
        if (opts.updatedAfter)
            params.set("updatedAfter", opts.updatedAfter);
        const res = await call(`/v1/conversations?${params.toString()}`);
        out.push(...(res.data || []));
        token = res.nextPageToken || null;
        if (!token)
            break;
    }
    return out;
}
/**
 * Messages exchanged with `participants` on `phoneNumberId`.
 *
 * `participants` is serialised as a repeated single key. URLSearchParams'
 * append does exactly that, and it is the only form the API accepts.
 */
async function listMessages(input) {
    const out = [];
    let token = null;
    const maxPages = input.maxPages ?? 5;
    for (let page = 0; page < maxPages; page++) {
        const params = new URLSearchParams();
        params.set("phoneNumberId", input.phoneNumberId);
        for (const p of input.participants)
            params.append("participants", p);
        params.set("maxResults", String(Math.min(100, Math.max(1, input.maxResults ?? 100))));
        if (input.createdAfter)
            params.set("createdAfter", input.createdAfter);
        if (token)
            params.set("pageToken", token);
        const res = await call(`/v1/messages?${params.toString()}`);
        out.push(...(res.data || []));
        token = res.nextPageToken || null;
        if (!token)
            break;
    }
    return out;
}
/**
 * Send a text. Resolves only on Quo's 202 accept; anything else throws with
 * Quo's own words, because "message sent" must never be reported on a guess.
 *
 * A2P: an unregistered/unapproved brand returns 400 with an A2P message. That
 * is a carrier-registration problem on the Quo account, not something this
 * code can retry around, so it is surfaced verbatim.
 */
async function sendText(input) {
    const from = input.from || getQuoPhoneNumberId() || getQuoPhoneNumber();
    if (!from)
        throw new QuoError("No Quo sending number configured (QUO_PHONE_NUMBER_ID)", 0);
    const content = String(input.content || "").trim();
    if (!content)
        throw new QuoError("Message text is required", 0);
    if (content.length > 1600)
        throw new QuoError("Quo caps a message at 1600 characters", 0);
    const to = String(input.to || "").trim();
    if (!/^\+[1-9]\d{1,14}$/.test(to)) {
        throw new QuoError(`Recipient must be E.164 (e.g. +12105550123), got "${to}"`, 0);
    }
    const res = await call("/v1/messages", {
        method: "POST",
        body: { content, from, to: [to], ...(input.userId ? { userId: input.userId } : {}) },
    });
    return res.data;
}
async function listWebhooks() {
    const res = await call("/v1/webhooks");
    return res.data || [];
}
/**
 * Point Quo at our inbound endpoint. Idempotent: an existing webhook on the
 * same URL is left alone rather than duplicated, because Quo will happily
 * register the same URL twice and then deliver everything twice.
 *
 * The only valid events are `message.received` and `message.delivered` — the
 * API rejects anything else, which is how that list was established.
 */
async function ensureMessageWebhook(url) {
    const existing = await listWebhooks();
    const match = existing.find((w) => w.url === url);
    if (match)
        return { created: false, webhook: match };
    const res = await call("/v1/webhooks/messages", {
        method: "POST",
        body: { url, events: ["message.received", "message.delivered"] },
    });
    return { created: true, webhook: res.data };
}
/** Verify the key and report the line it belongs to, without sending anything. */
async function checkQuo() {
    if (!isQuoConfigured())
        return { ok: false, error: "QUO_API_KEY is not set" };
    try {
        const numbers = await listPhoneNumbers();
        return { ok: true, numbers };
    }
    catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
/**
 * Shared secret for the inbound webhook, carried as `?key=` on the URL we
 * register with Quo.
 *
 * Quo's webhook create call takes only a URL and an event list — it offers no
 * signing secret — so an unguarded endpoint would let anyone who guessed the
 * path post fabricated texts into the CRM. Deriving the guard from the API key
 * means there is no second secret to provision or rotate, and it changes
 * automatically if the key is ever replaced.
 */
function quoWebhookSecret() {
    const key = getQuoApiKey();
    if (!key)
        return null;
    return (0, crypto_1.createHash)("sha256").update("quo-webhook:" + key).digest("hex").slice(0, 24);
}
/** Digits-only comparison key, so +1 (210) 555-0123 and 2105550123 match. */
function phoneKey(raw) {
    const digits = String(raw || "").replace(/\D/g, "");
    return digits.length > 10 ? digits.slice(-10) : digits;
}
/** Best-effort E.164 for a US 10-digit number typed by a human. */
function toE164(raw) {
    const s = String(raw || "").trim();
    if (/^\+[1-9]\d{1,14}$/.test(s))
        return s;
    const digits = s.replace(/\D/g, "");
    if (digits.length === 10)
        return "+1" + digits;
    if (digits.length === 11 && digits.startsWith("1"))
        return "+" + digits;
    return null;
}
