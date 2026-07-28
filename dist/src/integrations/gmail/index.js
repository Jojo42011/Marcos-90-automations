"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storeGmailRefreshToken = storeGmailRefreshToken;
exports.recordGmailAuthError = recordGmailAuthError;
exports.getGmailAuthInfo = getGmailAuthInfo;
exports.isGmailConfigured = isGmailConfigured;
exports.getMarcoEmail = getMarcoEmail;
exports.getGmailSenderAddress = getGmailSenderAddress;
exports.checkGmailAuth = checkGmailAuth;
exports.getGmailAccessToken = getGmailAccessToken;
exports.resolveEmailRecipient = resolveEmailRecipient;
exports.sendEmail = sendEmail;
exports.sendPropertyEmail = sendPropertyEmail;
/**
 * Gmail — send email via OAuth refresh token (Marco's linked account).
 *
 * Token precedence: a refresh token stored in the email DB (linked through the
 * in-app "Reconnect Gmail" OAuth flow) wins over GMAIL_REFRESH_TOKEN from the
 * environment. The env token went stale once already (invalid_grant, June 22)
 * and rotating a Fly secret needs CLI access — the DB path lets Marco re-link
 * from the browser and survive deploys.
 */
const emailStore_js_1 = require("../../core/emailStore.js");
let cachedAccessToken = null;
let cachedFromAddress = null;
const KV_REFRESH_TOKEN = "gmail_refresh_token";
const KV_LINKED_EMAIL = "gmail_linked_email";
const KV_LINKED_AT = "gmail_linked_at";
const KV_AUTH_ERROR = "gmail_auth_error";
const KV_AUTH_ERROR_AT = "gmail_auth_error_at";
function storedRefreshToken() {
    try {
        return (0, emailStore_js_1.kvGet)(KV_REFRESH_TOKEN);
    }
    catch {
        return null;
    }
}
/** Persist a freshly minted refresh token (from the in-app OAuth relink). */
function storeGmailRefreshToken(refreshToken, linkedEmail) {
    (0, emailStore_js_1.kvSet)(KV_REFRESH_TOKEN, refreshToken);
    (0, emailStore_js_1.kvSet)(KV_LINKED_AT, new Date().toISOString());
    if (linkedEmail)
        (0, emailStore_js_1.kvSet)(KV_LINKED_EMAIL, linkedEmail);
    (0, emailStore_js_1.kvSet)(KV_AUTH_ERROR, "");
    // Invalidate caches so the next call uses the new token immediately.
    cachedAccessToken = null;
    cachedFromAddress = linkedEmail || null;
}
function recordGmailAuthError(message) {
    try {
        (0, emailStore_js_1.kvSet)(KV_AUTH_ERROR, message);
        (0, emailStore_js_1.kvSet)(KV_AUTH_ERROR_AT, new Date().toISOString());
    }
    catch {
        /* bookkeeping only */
    }
}
function getGmailAuthInfo() {
    const db = storedRefreshToken();
    const env = process.env.GMAIL_REFRESH_TOKEN?.trim();
    return {
        configured: isGmailConfigured(),
        tokenSource: db ? "db" : env ? "env" : "none",
        linkedEmail: (0, emailStore_js_1.kvGet)(KV_LINKED_EMAIL),
        linkedAt: (0, emailStore_js_1.kvGet)(KV_LINKED_AT),
        authError: (0, emailStore_js_1.kvGet)(KV_AUTH_ERROR) || null,
        authErrorAt: (0, emailStore_js_1.kvGet)(KV_AUTH_ERROR_AT),
    };
}
function isGmailConfigured() {
    return Boolean(process.env.GMAIL_CLIENT_ID?.trim() &&
        process.env.GMAIL_CLIENT_SECRET?.trim() &&
        (storedRefreshToken() || process.env.GMAIL_REFRESH_TOKEN?.trim()));
}
/** Marco's inbox — for "email me" when Harvey doesn't infer an address. */
function getMarcoEmail() {
    return (process.env.MARCO_EMAIL?.trim() ||
        process.env.GMAIL_FROM?.trim() ||
        process.env.GMAIL_USER?.trim() ||
        cachedFromAddress ||
        null);
}
/** OAuth-linked sender address (cached after first send or profile lookup). */
async function getGmailSenderAddress() {
    if (!isGmailConfigured())
        return null;
    try {
        const cfg = getConfig();
        if (cfg.fromAddress)
            return cfg.fromAddress;
        const accessToken = await fetchAccessToken(cfg);
        return await resolveFromAddress(cfg, accessToken);
    }
    catch {
        return getMarcoEmail();
    }
}
/**
 * Actually exercise the refresh token and say whether Gmail can send.
 *
 * Exists because `getGmailSenderAddress()` is NOT a health check: it returns
 * `GMAIL_FROM`/`GMAIL_USER` (or a cached address) without ever calling Google,
 * and swallows failures. Anything built on it reports a healthy connection
 * while every send is bouncing — which is exactly what happened on
 * 2026-07-28, where the status endpoint said "verified" for a token Google
 * had been rejecting for hours.
 */
async function checkGmailAuth() {
    if (!isGmailConfigured())
        return { ok: false, error: "Gmail OAuth not configured" };
    try {
        await fetchAccessToken(getConfig());
        return { ok: true };
    }
    catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
function getConfig() {
    const clientId = process.env.GMAIL_CLIENT_ID?.trim();
    const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();
    const refreshToken = storedRefreshToken() || process.env.GMAIL_REFRESH_TOKEN?.trim();
    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error("Gmail OAuth not configured — set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN");
    }
    return {
        clientId,
        clientSecret,
        refreshToken,
        fromAddress: process.env.GMAIL_FROM?.trim() || process.env.GMAIL_USER?.trim(),
    };
}
async function fetchAccessToken(cfg) {
    if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
        return cachedAccessToken.token;
    }
    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            refresh_token: cfg.refreshToken,
            grant_type: "refresh_token",
        }),
    });
    const data = (await res.json().catch(() => ({})));
    if (!res.ok || !data.access_token) {
        // Report Google's error CODE alongside its description. The description
        // alone is often just "Bad Request", which says nothing about the cause —
        // the code is what distinguishes a dead refresh token (invalid_grant)
        // from bad app credentials (invalid_client). Relinking fixes the first
        // and cannot fix the second, so the difference matters.
        const detail = [data.error, data.error_description].filter(Boolean).join(": ") ||
            `HTTP ${res.status}`;
        // "invalid_grant"/"Bad Request" = the refresh token itself is dead
        // (revoked or expired). Record it so the dashboard can show a
        // "Reconnect Gmail" prompt instead of failing silently for weeks.
        recordGmailAuthError(`token refresh failed: ${detail}`);
        throw new Error(`Gmail token refresh failed: ${detail}`);
    }
    const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
        ? data.expires_in
        : 3600;
    cachedAccessToken = {
        token: data.access_token,
        expiresAt: Date.now() + expiresIn * 1000,
    };
    return data.access_token;
}
/** Shared access token for other Gmail modules (inbox reads). */
async function getGmailAccessToken() {
    return fetchAccessToken(getConfig());
}
async function resolveFromAddress(cfg, accessToken) {
    if (cfg.fromAddress)
        return cfg.fromAddress;
    if (cachedFromAddress)
        return cachedFromAddress;
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json().catch(() => ({})));
    if (!res.ok || !data.emailAddress?.trim()) {
        throw new Error("Gmail profile lookup failed — set GMAIL_FROM in env");
    }
    cachedFromAddress = data.emailAddress.trim();
    return cachedFromAddress;
}
function encodeRawMessage(lines) {
    return Buffer.from(lines.join("\r\n"))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}
function isValidEmail(addr) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}
const MARCO_RECIPIENT_ALIASES = new Set([
    "marco",
    "me",
    "myself",
    "my email",
    "my inbox",
    "marco puga",
]);
/** Resolve "email me" / "marco" shorthands to Marco's real address. */
async function resolveEmailRecipient(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return trimmed;
    if (!MARCO_RECIPIENT_ALIASES.has(trimmed.toLowerCase()))
        return trimmed;
    const marco = getMarcoEmail() || (await getGmailSenderAddress());
    if (!marco) {
        throw new Error("Marco email not configured — set MARCO_EMAIL (or GMAIL_FROM) so Harvey can send to you");
    }
    return marco;
}
async function sendEmail(opts) {
    const to = await resolveEmailRecipient(opts.to);
    const subject = opts.subject.trim();
    const body = opts.body.trim();
    if (!to || !subject || !body) {
        throw new Error("to, subject, and body are required");
    }
    if (!isValidEmail(to)) {
        throw new Error(`Invalid recipient email: ${to}`);
    }
    const cfg = getConfig();
    const accessToken = await fetchAccessToken(cfg);
    const from = await resolveFromAddress(cfg, accessToken);
    const contentType = opts.html
        ? "text/html; charset=utf-8"
        : "text/plain; charset=utf-8";
    const raw = encodeRawMessage([
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        `Content-Type: ${contentType}`,
        "",
        body,
    ]);
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw }),
    });
    const data = (await res.json().catch(() => ({})));
    if (!res.ok || !data.id) {
        const detail = data.error?.message || `HTTP ${res.status}`;
        throw new Error(`Gmail send failed: ${detail}`);
    }
    console.log(`[gmail] Sent to ${to} subject="${subject.slice(0, 60)}" id=${data.id}`);
    return { ok: true, messageId: data.id, to, from };
}
/** Module 07 + Harvey tool alias — curated property email body. */
async function sendPropertyEmail(to, subject, body) {
    await sendEmail({ to, subject, body, html: true });
}
