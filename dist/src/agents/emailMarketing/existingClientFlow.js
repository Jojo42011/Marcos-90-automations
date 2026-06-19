"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildClientContext = buildClientContext;
exports.sendContextAwareEmail = sendContextAwareEmail;
const index_js_1 = require("../../integrations/email/index.js");
const emailStore_js_1 = require("../../core/emailStore.js");
const smsStore_js_1 = require("../../core/smsStore.js");
const transactionsStore_js_1 = require("../../core/transactionsStore.js");
const db_js_1 = require("../../core/db.js");
async function buildClientContext(leadId) {
    const lead = await (0, db_js_1.findLeadById)(leadId);
    const transactions = (0, transactionsStore_js_1.getAllTransactions)().filter((t) => t.leadId === leadId && !["closed", "cancelled", "fell_through"].includes(t.status));
    const activeDeal = transactions.length > 0
        ? { address: transactions[0].address, status: transactions[0].status }
        : null;
    const smsThread = (0, smsStore_js_1.getThreadForLead)(leadId, 5);
    const lastMessage = smsThread.length > 0 ? smsThread[smsThread.length - 1] : null;
    const emails = (0, emailStore_js_1.getEmailsForLead)(leadId, 1);
    const lastEmailSubject = emails.length > 0 ? emails[0].subject : null;
    return {
        leadName: lead?.name || lead?.username || "there",
        activeDeal,
        lastConversationSnippet: lastMessage ? lastMessage.messageBody.substring(0, 100) : null,
        lastEmailSubject,
    };
}
async function sendContextAwareEmail(leadId, subject, bodyTemplate) {
    const lead = await (0, db_js_1.findLeadById)(leadId);
    if (!lead || !lead.email) {
        return { success: false, error: "No email on file for this lead" };
    }
    const context = await buildClientContext(leadId);
    const body = bodyTemplate(context);
    const emailRecord = (0, emailStore_js_1.logEmail)({
        leadId,
        subject,
        body,
        emailType: "existing_client",
        sendStatus: "pending",
    });
    const result = await (0, index_js_1.sendEmail)(lead.email, subject, body);
    if (result.success)
        (0, emailStore_js_1.markEmailSent)(emailRecord.id, result.messageId);
    else
        (0, emailStore_js_1.markEmailFailed)(emailRecord.id, result.error || "unknown");
    return { success: result.success, error: result.error };
}
