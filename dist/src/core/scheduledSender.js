"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canSendOn = canSendOn;
exports.processDueMessages = processDueMessages;
exports.startScheduledSender = startScheduledSender;
exports.stopScheduledSender = stopScheduledSender;
/**
 * The worker behind scheduled sending: wakes on an interval, takes whatever
 * is due, and actually tries to deliver it.
 *
 * Runs in-process on a timer rather than as a cron, matching how every other
 * scheduled agent in this app works. The queue lives on the /data volume, so
 * a deploy mid-flight loses nothing — anything still pending is simply picked
 * up by the next tick after boot.
 *
 * Delivery honesty is the whole point here. Twilio is currently unconfigured
 * and the Gmail refresh token is dead (2026-07-28), so real sends fail. When
 * they do, the message records the provider's actual error and retries a
 * couple of times before sticking as `failed`. Nothing is silently dropped,
 * and nothing is ever marked sent that wasn't.
 */
const scheduledMessages_js_1 = require("./scheduledMessages.js");
const index_js_1 = require("../integrations/twilio/index.js");
const index_js_2 = require("../integrations/email/index.js");
/** Can this channel actually deliver right now? For pre-flight warnings. */
function canSendOn(channel) {
    if (channel === "sms") {
        return (0, index_js_1.isTwilioConfigured)()
            ? { ok: true }
            : { ok: false, reason: "Twilio is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER." };
    }
    return (0, index_js_2.isEmailConfigured)()
        ? { ok: true }
        : { ok: false, reason: "Gmail is not connected — relink at /api/email/gmail-oauth/start." };
}
async function deliver(msg) {
    if (msg.channel === "sms") {
        const res = await (0, index_js_1.sendTwilioMessage)(msg.to, msg.body);
        if (!res.success)
            throw new Error(res.error || "Twilio send failed");
        return;
    }
    const res = await (0, index_js_2.sendEmail)(msg.to, msg.subject || "Message from Marco Puga Realty", msg.body);
    if (!res.success)
        throw new Error(res.error || "Email send failed");
}
/** Process everything due. Returns what happened, for logs and tests. */
async function processDueMessages(at = new Date()) {
    const due = (0, scheduledMessages_js_1.dueMessages)(at);
    let sent = 0;
    let failed = 0;
    for (const msg of due) {
        try {
            await deliver(msg);
            (0, scheduledMessages_js_1.markSent)(msg.id);
            sent++;
            console.log(`[scheduled] sent ${msg.channel} to ${msg.to} (${msg.id})`);
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            (0, scheduledMessages_js_1.markAttemptFailed)(msg.id, reason);
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
    const sms = canSendOn("sms");
    const email = canSendOn("email");
    console.log(`[scheduled] sender started — checking every ${Math.round(intervalMs / 1000)}s ` +
        `(sms: ${sms.ok ? "ready" : "UNAVAILABLE"}, email: ${email.ok ? "ready" : "UNAVAILABLE"})`);
    tick();
}
function stopScheduledSender() {
    if (timer)
        clearInterval(timer);
    timer = null;
}
