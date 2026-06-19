"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEmailConfigured = isEmailConfigured;
exports.sendEmail = sendEmail;
exports.verifyEmailConnection = verifyEmailConnection;
/**
 * Email marketing sender — Gmail OAuth2 (wraps integrations/gmail).
 * Auth: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (not SMTP app password).
 */
const index_js_1 = require("../gmail/index.js");
function isEmailConfigured() {
    return (0, index_js_1.isGmailConfigured)();
}
async function sendEmail(to, subject, body) {
    if (!isEmailConfigured()) {
        console.warn("[Email] Not configured — skipping send to", to);
        return { success: false, error: "Email not configured" };
    }
    try {
        const result = await (0, index_js_1.sendEmail)({ to, subject, body, html: true });
        console.log("[Email] Sent to", to, "- messageId:", result.messageId);
        return { success: true, messageId: result.messageId };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[Email] Send error:", message);
        return { success: false, error: message };
    }
}
/** Lightweight OAuth + profile check at startup. */
async function verifyEmailConnection() {
    if (!isEmailConfigured()) {
        console.warn("[Email] Gmail OAuth not configured — set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN");
        return false;
    }
    try {
        const from = await (0, index_js_1.getGmailSenderAddress)();
        if (!from) {
            console.error("[Email] Gmail connection FAILED: could not resolve sender profile");
            return false;
        }
        console.log("[Email] Gmail connection verified ✓ (from:", from, ")");
        return true;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[Email] Gmail connection FAILED:", message);
        return false;
    }
}
