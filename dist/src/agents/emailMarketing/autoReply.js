"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendAutoReply = sendAutoReply;
exports.scheduleAutoReply = scheduleAutoReply;
const index_js_1 = require("../../integrations/email/index.js");
const emailStore_js_1 = require("../../core/emailStore.js");
const db_js_1 = require("../../core/db.js");
async function extractFirstInquiry(lead) {
    const conv = await (0, db_js_1.getConversation)(lead.id);
    const firstUser = conv.messages.find((m) => m.role === "user");
    if (firstUser?.text?.trim())
        return firstUser.text.trim().slice(0, 200);
    if (lead.propertyInquired?.trim())
        return lead.propertyInquired.trim();
    return "your interest in finding a new home";
}
async function sendAutoReply(lead) {
    if (!lead.email?.trim()) {
        console.log("[AutoReply] No email for lead", lead.id, "— skipping");
        return;
    }
    const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
    const inquiry = await extractFirstInquiry(lead);
    const subject = `Great to hear from you, ${firstName}!`;
    const body = `Hi ${firstName},\n\nThanks so much for reaching out about ${inquiry}! This is Marco — I'll be in touch shortly with more details, but wanted to get this to you right away.\n\nIn the meantime, feel free to reply here or text me anytime with questions.\n\nTalk soon,\nMarco`;
    const emailRecord = (0, emailStore_js_1.logEmail)({
        leadId: lead.id,
        subject,
        body,
        emailType: "auto_reply",
        sendStatus: "pending",
    });
    const result = await (0, index_js_1.sendEmail)(lead.email, subject, body);
    if (result.success) {
        (0, emailStore_js_1.markEmailSent)(emailRecord.id, result.messageId);
        await (0, db_js_1.updateLeadCrmFields)({ leadId: lead.id, autoReplyEmailSentAt: new Date().toISOString() });
        console.log("[AutoReply] Sent to", lead.email);
    }
    else {
        (0, emailStore_js_1.markEmailFailed)(emailRecord.id, result.error || "unknown error");
        console.log("[AutoReply] Failed for", lead.email, "-", result.error);
    }
}
const scheduledAutoReply = new Set();
function scheduleAutoReply(lead) {
    if (!lead.email?.trim() || lead.autoReplyEmailSentAt || scheduledAutoReply.has(lead.id)) {
        return;
    }
    scheduledAutoReply.add(lead.id);
    setTimeout(() => {
        sendAutoReply(lead).catch((err) => console.error("[AutoReply]", err));
    }, 3 * 60 * 1000);
}
