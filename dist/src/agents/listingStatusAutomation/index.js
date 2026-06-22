"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleListingStatusUpdate = handleListingStatusUpdate;
const crypto_1 = require("crypto");
const db_js_1 = require("../../core/db.js");
const crmNotificationStore_js_1 = require("../../core/crmNotificationStore.js");
const smsStore_js_1 = require("../../core/smsStore.js");
const textingRules_js_1 = require("../../core/textingRules.js");
const index_js_1 = require("../../integrations/email/index.js");
const index_js_2 = require("../../integrations/twilio/index.js");
function listingStatusForLead(status) {
    if (status === "active")
        return "active";
    if (status === "off_market" || status === "expired")
        return "off_market";
    return null;
}
/**
 * Listing status intake — manual entry today; future MLS feed calls this same handler.
 * Fires only on status TRANSITIONS (not repeated polls of the same status).
 */
async function handleListingStatusUpdate(leadId, address, newStatus, source = "manual") {
    const lead = await (0, db_js_1.getLeadById)(leadId);
    if (!lead)
        return { triggered: false, action: "lead_not_found" };
    const db = (0, crmNotificationStore_js_1.getCrmAutomationDb)();
    const previous = db
        .prepare(`SELECT * FROM listing_status_events WHERE lead_id = ? ORDER BY detected_at DESC LIMIT 1`)
        .get(leadId);
    const previousStatus = previous?.status;
    if (previousStatus === newStatus) {
        return { triggered: false, action: "no_change" };
    }
    const id = (0, crypto_1.randomUUID)();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO listing_status_events (id, lead_id, address, status, source, previous_status, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, leadId, address, newStatus, source, previousStatus ?? null, now);
    const mappedListing = listingStatusForLead(newStatus);
    if (mappedListing) {
        const patch = {
            leadId,
            listingStatus: mappedListing,
        };
        if (!lead.propertyInquired?.trim() && address.trim()) {
            patch.propertyInquired = address.trim();
        }
        await (0, db_js_1.updateLeadCrmFields)(patch);
    }
    if ((newStatus === "off_market" || newStatus === "expired") &&
        previousStatus !== "off_market" &&
        previousStatus !== "expired") {
        await runOffMarketOutreach(lead, address, id);
        return { triggered: true, action: "off_market_outreach" };
    }
    if (newStatus === "active" && previousStatus !== "active") {
        await runActiveNotification(lead, address, id);
        return { triggered: true, action: "active_notification" };
    }
    return { triggered: false, action: "no_action_for_status" };
}
async function runOffMarketOutreach(lead, address, eventId) {
    const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
    const stamp = new Date().toISOString();
    if (lead.phone) {
        const gate = (0, textingRules_js_1.checkTextingAllowed)(lead.id);
        if (gate.allowed) {
            const smsBody = `Hi ${firstName}, noticed your home at ${address} recently came off the market. If you're still thinking about selling, I'd love the opportunity to talk through a fresh strategy — would you be open to interviewing a qualified realtor in your area?`;
            const send = await (0, index_js_2.sendTwilioMessage)(lead.phone, smsBody);
            if (send.success) {
                (0, smsStore_js_1.logSmsMessage)({
                    leadId: lead.id,
                    messageBody: smsBody,
                    direction: "outbound",
                    sentAt: stamp,
                    threadType: "listing_off_market",
                    messageHandle: send.messageSid,
                });
            }
        }
        else {
            console.log("[ListingStatus] Texting gate blocked off-market SMS for", lead.id, "-", gate.reason);
        }
    }
    if (lead.email) {
        const subject = `Still thinking about selling ${address}?`;
        const body = `Hi ${firstName},\n\nI noticed ${address} recently came off the market. If selling is still something you're considering, I'd welcome the chance to share a fresh approach — would you be open to interviewing a qualified realtor in your area?\n\nNo pressure either way, just wanted to reach out.\n\nMarco`;
        await (0, index_js_1.sendEmail)(lead.email, subject, body);
    }
    const message = `${lead.name || lead.username || "A seller lead"}'s home at ${address} went off-market — outreach sent asking if they're open to interviewing a realtor.`;
    (0, crmNotificationStore_js_1.createNotification)({ leadId: lead.id, notificationType: "listing_off_market", message });
    await (0, db_js_1.appendLeadActivity)(lead.id, [{ type: "listing_off_market", description: message, timestamp: stamp }], { lastActivity: stamp });
    (0, crmNotificationStore_js_1.getCrmAutomationDb)()
        .prepare(`UPDATE listing_status_events SET off_market_outreach_sent_at = ? WHERE id = ?`)
        .run(stamp, eventId);
    console.log("[ListingStatus] Off-market outreach sent for", lead.id, "-", address);
}
async function runActiveNotification(lead, address, eventId) {
    const message = `${lead.name || lead.username || "A seller lead"}'s home at ${address} just went active on the market.`;
    const stamp = new Date().toISOString();
    (0, crmNotificationStore_js_1.createNotification)({ leadId: lead.id, notificationType: "listing_active", message });
    await (0, db_js_1.appendLeadActivity)(lead.id, [{ type: "listing_active", description: message, timestamp: stamp }], { lastActivity: stamp });
    const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
    if (marcoNumber) {
        await (0, index_js_2.sendTwilioMessage)((0, index_js_2.normalizeToE164)(marcoNumber), `🏡 ${message}`);
    }
    (0, crmNotificationStore_js_1.getCrmAutomationDb)()
        .prepare(`UPDATE listing_status_events SET active_notification_sent_at = ? WHERE id = ?`)
        .run(stamp, eventId);
    console.log("[ListingStatus] Active notification sent for", lead.id, "-", address);
}
