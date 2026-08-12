"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEmailConfigured = isEmailConfigured;
exports.sendEmail = sendEmail;
exports.verifyEmailConnection = verifyEmailConnection;
/**
 * Email marketing sender — wraps integrations/gmail, which picks the
 * transport: SMTP app password (GMAIL_SMTP_USER + GMAIL_SMTP_APP_PASSWORD)
 * when set, otherwise OAuth (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN).
 */
const index_js_1 = require("../gmail/index.js");
const index_js_2 = require("../smtp/index.js");
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
/** Lightweight transport check at startup. */
async function verifyEmailConnection() {
    if (!isEmailConfigured()) {
        console.warn("[Email] No send transport configured — set GMAIL_SMTP_USER + GMAIL_SMTP_APP_PASSWORD (preferred), " +
            "or GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET/GMAIL_REFRESH_TOKEN");
        return false;
    }
    if ((0, index_js_1.getEmailTransport)() === "smtp") {
        const res = await (0, index_js_2.verifySmtpConnection)();
        if (!res.ok) {
            console.error("[Email] SMTP connection FAILED:", res.error);
            return false;
        }
        const st = (0, index_js_2.getSmtpStatus)();
        console.log(`[Email] SMTP connection verified ✓ (as ${res.user}, ${st.sentToday}/${st.dailyCap} sent today)`);
        return true;
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
