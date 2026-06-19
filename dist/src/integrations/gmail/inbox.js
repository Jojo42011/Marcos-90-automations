"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listGmailMessages = listGmailMessages;
exports.getGmailMessage = getGmailMessage;
exports.extractSenderEmail = extractSenderEmail;
/**
 * Gmail read API — inbox list, message detail, thread snippets.
 * Requires OAuth scope: https://www.googleapis.com/auth/gmail.readonly (or gmail.modify)
 */
const index_js_1 = require("./index.js");
let cachedAccessToken = null;
function getConfig() {
    const clientId = process.env.GMAIL_CLIENT_ID?.trim();
    const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN?.trim();
    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error("Gmail OAuth not configured");
    }
    return { clientId, clientSecret, refreshToken };
}
async function getAccessToken() {
    if (!(0, index_js_1.isGmailConfigured)())
        throw new Error("Gmail not configured");
    if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
        return cachedAccessToken.token;
    }
    const cfg = getConfig();
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
        throw new Error(data.error_description || "Gmail token refresh failed");
    }
    cachedAccessToken = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };
    return data.access_token;
}
function headerValue(headers, name) {
    const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
    return h?.value?.trim() || "";
}
function decodeBase64Url(data) {
    const padded = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(padded, "base64").toString("utf8");
}
function extractBody(payload) {
    if (!payload)
        return { text: "", html: "" };
    let text = "";
    let html = "";
    const walk = (part) => {
        const mime = part.mimeType || "";
        const raw = part.body?.data;
        if (raw) {
            const decoded = decodeBase64Url(raw);
            if (mime.includes("text/html"))
                html += decoded;
            else if (mime.includes("text/plain"))
                text += decoded;
        }
        part.parts?.forEach(walk);
    };
    walk(payload);
    if (!text && html)
        text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { text: text.trim(), html: html.trim() };
}
function parseEmailAddress(raw) {
    const m = raw.match(/<([^>]+)>/);
    return (m ? m[1] : raw).trim().toLowerCase();
}
async function listGmailMessages(opts) {
    const token = await getAccessToken();
    const maxResults = Math.min(opts?.maxResults ?? 25, 50);
    const q = opts?.query ?? "in:inbox OR in:sent";
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("maxResults", String(maxResults));
    listUrl.searchParams.set("q", q);
    const listRes = await fetch(listUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` },
    });
    const listData = (await listRes.json().catch(() => ({})));
    if (!listRes.ok) {
        throw new Error(listData.error?.message || `Gmail list failed HTTP ${listRes.status}`);
    }
    const ids = listData.messages || [];
    const out = [];
    for (const m of ids.slice(0, maxResults)) {
        try {
            const detail = await getGmailMessage(m.id);
            out.push(detail);
        }
        catch (err) {
            console.warn("[gmail/inbox] skip message", m.id, err);
        }
    }
    return out;
}
async function getGmailMessage(messageId) {
    const token = await getAccessToken();
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
    const data = (await res.json().catch(() => ({})));
    if (!res.ok || !data.id) {
        throw new Error(data.error?.message || `Gmail get message failed HTTP ${res.status}`);
    }
    const headers = data.payload?.headers;
    const from = headerValue(headers, "From");
    const to = headerValue(headers, "To");
    const subject = headerValue(headers, "Subject") || "(no subject)";
    const labels = data.labelIds || [];
    const direction = labels.includes("SENT")
        ? "outbound"
        : labels.includes("INBOX")
            ? "inbound"
            : "unknown";
    const { text, html } = extractBody(data.payload);
    const date = data.internalDate
        ? new Date(Number(data.internalDate)).toISOString()
        : new Date().toISOString();
    return {
        id: data.id,
        threadId: data.threadId || "",
        from,
        to,
        subject,
        snippet: data.snippet || text.slice(0, 200),
        date,
        labelIds: labels,
        direction,
        bodyText: text,
        bodyHtml: html,
    };
}
function extractSenderEmail(fromHeader) {
    return parseEmailAddress(fromHeader);
}
