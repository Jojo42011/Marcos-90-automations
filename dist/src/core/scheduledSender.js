"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canSendOn = canSendOn;
exports.processDueMessages = processDueMessages;
exports.startScheduledSender = startScheduledSender;
exports.stopScheduledSender = stopScheduledSender;
/** Durable scheduled delivery. Ambiguous outcomes require review instead of an unsafe retry. */
const scheduledMessages_js_1 = require("./scheduledMessages.js");
const index_js_1 = require("../integrations/twilio/index.js");
const index_js_2 = require("../integrations/email/index.js");
const index_js_3 = require("../integrations/gmail/index.js");
/**
 * Can this channel actually deliver right now?
 *
 * For email this **exercises the refresh token**, it does not just check that
 * credentials are present. `isEmailConfigured()` only asks whether the env
 * vars exist, which reported "email is fine" against a token Google had been
 * rejecting for hours — the same false green that hid a total email outage
 * behind `/api/email/connection-status`. A capability check that can't fail
 * is worse than no check, because everything downstream repeats its answer.
 *
 * The access token is cached after a successful handshake, so repeat calls
 * are cheap.
 */
async function canSendOn(channel) {
    if (channel === "sms") {
        // Twilio has no equivalent handshake; presence of credentials is all we
        // can know without sending something real.
        return (0, index_js_1.isTwilioConfigured)()
            ? { ok: true }
            : { ok: false, reason: "Twilio is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER." };
    }
    if (!(0, index_js_2.isEmailConfigured)()) {
        return { ok: false, reason: "Gmail is not connected — relink at /api/email/gmail-oauth/start." };
    }
    const auth = await (0, index_js_3.checkGmailAuth)();
    return auth.ok
        ? { ok: true }
        : { ok: false, reason: `Gmail rejected its token (${auth.error}) — relink at /api/email/gmail-oauth/start.` };
}
class NotConfigured extends Error {
}
async function deliver(msg) {
    if (msg.channel === "sms") {
        if (!(0, index_js_1.isTwilioConfigured)())
            throw new NotConfigured("SMS is not configured");
        const res = await (0, index_js_1.sendTwilioMessage)(msg.to, msg.body);
        if (!res.success)
            throw new Error(res.error || "Twilio send failed");
        return;
    }
    if (!(0, index_js_2.isEmailConfigured)())
        throw new NotConfigured("Email is not configured");
    const res = await (0, index_js_2.sendEmail)(msg.to, msg.subject || "Message from Marco Puga Realty", msg.body);
    if (!res.success)
        throw new Error(res.error || "Email send failed");
}
/** Process everything due. Returns what happened, for logs and tests. */
async function processDueMessages(at = new Date()) {
    const due = (0, scheduledMessages_js_1.dueMessages)(at);
    let sent = 0;
    let failed = 0;
    for (const candidate of due) {
        const msg = (0, scheduledMessages_js_1.claimScheduled)(candidate.id);
        if (!msg)
            continue;
        try {
            await deliver(msg);
            (0, scheduledMessages_js_1.markSent)(msg.id);
            sent++;
            console.log(`[scheduled] sent ${msg.channel} to ${msg.to} (${msg.id})`);
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            if (err instanceof NotConfigured)
                (0, scheduledMessages_js_1.markAttemptFailed)(msg.id, reason);
            else
                (0, scheduledMessages_js_1.markUncertain)(msg.id, "Delivery outcome requires review: " + reason);
            failed++;
            console.error(`[scheduled] ${msg.channel} to ${msg.to} failed: ${reason}`);
        }
    }
    return { attempted: due.length, sent, failed };
}
let timer = null;
/**
 * Start the loop. 60s is deliberate: a minute of slack on "send Tuesday
 * morning" is invisible, and it keeps an idle queue nearly free.
 */
function startScheduledSender(intervalMs = 60_000) {
    if (timer)
        return;
    const tick = () => {
        void processDueMessages().catch((err) => console.error("[scheduled] tick failed:", err));
    };
    timer = setInterval(tick, intervalMs);
    // Don't hold the process open just for this.
    if (typeof timer.unref === "function")
        timer.unref();
    void Promise.all([canSendOn("sms"), canSendOn("email")]).then(([sms, email]) => {
        console.log(`[scheduled] sender started — checking every ${Math.round(intervalMs / 1000)}s ` +
            `(sms: ${sms.ok ? "ready" : "UNAVAILABLE"}, email: ${email.ok ? "ready" : "UNAVAILABLE"})`);
    });
    tick();
}
function stopScheduledSender() {
    if (timer)
        clearInterval(timer);
    timer = null;
}
