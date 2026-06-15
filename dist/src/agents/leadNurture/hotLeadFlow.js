"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.triggerHotLeadAlert = triggerHotLeadAlert;
const smsStore_js_1 = require("../../core/smsStore.js");
const index_js_1 = require("../../integrations/twilio/index.js");
function suggestNextStep(lead, factors) {
    if (!lead.showingAppointment)
        return "Schedule a showing — high intent, no showing booked yet.";
    if (lead.showingAppointment.confirmationStatus === "pending") {
        return "Follow up on showing confirmation.";
    }
    if (factors.preApproval < WEIGHTS.preApproval) {
        return "Confirm pre-approval status — could be the missing piece to close.";
    }
    return "Personal call recommended — this lead is ready to move.";
}
const WEIGHTS = { preApproval: 25 };
async function triggerHotLeadAlert(lead, score, factors) {
    const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
    if (!marcoNumber) {
        console.warn("[HotLeadFlow] MARCO_PHONE_NUMBER not set — cannot alert");
        return;
    }
    const recentMessages = (0, smsStore_js_1.getThreadForLead)(lead.id, 3);
    const lastMessage = recentMessages.length > 0 ? recentMessages[recentMessages.length - 1].messageBody : "No messages yet";
    const nextStep = suggestNextStep(lead, factors);
    const message = [
        `🔥 HOT LEAD (score: ${score}/100): ${lead.name || lead.username || "Unknown"}`,
        lead.phone ? `Phone: ${lead.phone}` : null,
        `Source: ${lead.source || "unknown"}`,
        `Last message: "${lastMessage.substring(0, 100)}"`,
        `Suggested next step: ${nextStep}`,
    ]
        .filter(Boolean)
        .join("\n");
    const result = await (0, index_js_1.sendTwilioMessage)(marcoNumber, message);
    if (result.success) {
        console.log("[HotLeadFlow] Alerted Marco about", lead.id, "- score", score);
    }
}
