"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isLeadGhosted = isLeadGhosted;
exports.handleWebsiteVisit = handleWebsiteVisit;
const db_js_1 = require("../../core/db.js");
const crmNotificationStore_js_1 = require("../../core/crmNotificationStore.js");
const smsStore_js_1 = require("../../core/smsStore.js");
const smsStore_js_2 = require("../../core/smsStore.js");
const textingRules_js_1 = require("../../core/textingRules.js");
const index_js_1 = require("../../integrations/email/index.js");
const index_js_2 = require("../../integrations/twilio/index.js");
const GHOSTED_THRESHOLD_DAYS = 30;
const RE_ENGAGEMENT_COOLDOWN_DAYS = 14;
function marcoNotifyEmail() {
    return process.env.MARCO_EMAIL_ADDRESS?.trim() || process.env.MARCO_EMAIL?.trim() || undefined;
}
async function isLeadGhosted(lead) {
    if (lead.crmStatus === "dead")
        return false;
    if (lead.automationPaused)
        return false;
    const lastInbound = (0, smsStore_js_2.getLastInboundMessage)(lead.id);
    const lastEngagementTime = lastInbound
        ? new Date(lastInbound.sentAt).getTime()
        : new Date(lead.createdAt || 0).getTime();
    const daysSinceEngagement = (Date.now() - lastEngagementTime) / (24 * 60 * 60 * 1000);
    return daysSinceEngagement >= GHOSTED_THRESHOLD_DAYS;
}
/**
 * Website-visit intake — call when a tracking pixel (future) or manual test fires.
 * Ghosted leads get lead-facing SMS+email plus Marco in-app/SMS/email notification.
 */
async function handleWebsiteVisit(leadId) {
    const lead = await (0, db_js_1.getLeadById)(leadId);
    if (!lead)
        return { triggered: false, reason: "lead_not_found" };
    const now = new Date().toISOString();
    await (0, db_js_1.updateLeadCrmFields)({ leadId, lastWebsiteVisitAt: now });
    const refreshed = await (0, db_js_1.getLeadById)(leadId);
    if (!refreshed)
        return { triggered: false, reason: "lead_not_found" };
    const ghosted = await isLeadGhosted(refreshed);
    if (!ghosted) {
        await (0, db_js_1.appendLeadActivity)(leadId, [{ type: "web_visit", description: "Website visit recorded", timestamp: now }], { lastActivity: now });
        return { triggered: false, reason: "not_ghosted" };
    }
    if (refreshed.lastReEngagementTriggeredAt) {
        const daysSinceLastTrigger = (Date.now() - new Date(refreshed.lastReEngagementTriggeredAt).getTime()) / (24 * 60 * 60 * 1000);
        if (daysSinceLastTrigger < RE_ENGAGEMENT_COOLDOWN_DAYS) {
            return { triggered: false, reason: "cooldown_active" };
        }
    }
    await runReEngagementFlow(refreshed);
    await (0, db_js_1.updateLeadCrmFields)({ leadId, lastReEngagementTriggeredAt: now });
    return { triggered: true };
}
async function runReEngagementFlow(lead) {
    const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
    const leadDisplayName = lead.name || lead.username || "A lead";
    const stamp = new Date().toISOString();
    if (lead.phone) {
        const gate = (0, textingRules_js_1.checkTextingAllowed)(lead.id);
        if (gate.allowed) {
            const smsBody = `Hey ${firstName}! Noticed you were checking things out again — still thinking about buying or selling? Happy to help whenever you're ready, no pressure at all.`;
            const send = await (0, index_js_2.sendTwilioMessage)(lead.phone, smsBody);
            if (send.success) {
                (0, smsStore_js_1.logSmsMessage)({
                    leadId: lead.id,
                    messageBody: smsBody,
                    direction: "outbound",
                    sentAt: stamp,
                    threadType: "re_engagement",
                    messageHandle: send.messageSid,
                });
            }
        }
        else {
            console.log("[ReEngagement] Texting gate blocked lead SMS for", lead.id, "-", gate.reason);
        }
    }
    if (lead.email) {
        const subject = `Good to see you again, ${firstName}!`;
        const body = `Hi ${firstName},\n\nNoticed you stopped by again — wanted to reach out and see where things stand. Whether you're still exploring or ready to make a move, I'm happy to help however's useful.\n\nMarco`;
        await (0, index_js_1.sendEmail)(lead.email, subject, body);
    }
    const notificationMessage = `${leadDisplayName} returned to your page after ${GHOSTED_THRESHOLD_DAYS}+ days — reach out to see if they are open to buying or selling.`;
    (0, crmNotificationStore_js_1.createNotification)({ leadId: lead.id, notificationType: "re_engagement", message: notificationMessage });
    await (0, db_js_1.appendLeadActivity)(lead.id, [
        { type: "re_engagement", description: notificationMessage, timestamp: stamp },
        { type: "web_visit", description: "Website revisit (ghosted lead)", timestamp: stamp },
    ], { lastActivity: stamp });
    const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
    if (marcoNumber) {
        await (0, index_js_2.sendTwilioMessage)((0, index_js_2.normalizeToE164)(marcoNumber), `🔔 ${notificationMessage}`);
    }
    const marcoEmail = marcoNotifyEmail();
    if (marcoEmail) {
        await (0, index_js_1.sendEmail)(marcoEmail, `Returning lead: ${leadDisplayName}`, notificationMessage);
    }
    else {
        console.log("[ReEngagement] MARCO_EMAIL_ADDRESS / MARCO_EMAIL not set — skipping email notification to Marco");
    }
    console.log("[ReEngagement] Triggered for", lead.id, "-", leadDisplayName);
}
