"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.__testFollowupSteps = void 0;
exports.checkNoReplyFollowups = checkNoReplyFollowups;
exports.scheduleNoReplyFollowupCheck = scheduleNoReplyFollowupCheck;
const emailStore_js_1 = require("../../core/emailStore.js");
const index_js_1 = require("../../integrations/email/index.js");
const db_js_1 = require("../../core/db.js");
const index_js_2 = require("../../integrations/simplyrets/index.js");
const listingMatch_js_1 = require("../../core/listingMatch.js");
/**
 * Real homes for this lead, as email lines, or null.
 *
 * Null rather than an empty string so the step falls back to its original
 * copy. "Something that might help" containing homes picked at random because
 * we had no criteria is not help, it is noise from a machine.
 */
function listingLines(lead, limit = 3) {
    if (!(0, index_js_2.isMlsFeedConfigured)())
        return null;
    try {
        const rows = (0, listingMatch_js_1.listingsForCriteria)(lead, limit);
        if (!rows.length)
            return null;
        return rows
            .map((l) => {
            const spec = (0, listingMatch_js_1.specLine)(l);
            const where = [l.street, l.city].filter(Boolean).join(", ");
            return `• ${where} — ${(0, listingMatch_js_1.money)(l.listPrice)}${spec ? ` (${spec})` : ""}`;
        })
            .join("\n");
    }
    catch (err) {
        /* A follow-up must never fail to send because a lookup broke. */
        console.error("[NoReplyFollowup] listing lookup failed:", err);
        return null;
    }
}
const STEP_3_DAYS = {
    subject: () => `Just checking in`,
    body: (n) => `Hi ${n},\n\nWanted to make sure my last email made it through okay — no rush, just checking in!\n\nMarco`,
};
const STEP_7_DAYS = {
    /* Was "thought this might be useful" followed by nothing at all. If the feed
       can supply homes matching what this lead told us, they are the useful
       thing; otherwise it falls back rather than promising twice. */
    subject: () => `Something that might help`,
    body: (n, lead) => {
        const lines = listingLines(lead, 3);
        if (!lines) {
            return `Hi ${n},\n\nThought this might be useful even if timing isn't right for a full conversation right now — happy to send more anytime.\n\nMarco`;
        }
        return `Hi ${n},\n\nNo need to reply — just thought these were worth a look. They are active right now and line up with what you told me:\n\n${lines}\n\nHappy to send more anytime.\n\nMarco`;
    },
};
/**
 * INBOUND REPLY GAP: repliedAt is only set via markEmailReplied() — there is no
 * IMAP/Gmail Pub/Sub inbound parser wired. Leads who reply by email may still
 * receive follow-ups until reply detection is built.
 */
async function checkNoReplyFollowups() {
    const leads = await (0, db_js_1.listAllLeads)();
    let sent = 0;
    let movedToCold = 0;
    for (const lead of leads) {
        if (!lead.email)
            continue;
        const emails = (0, emailStore_js_1.getEmailsForLead)(lead.id, 20);
        const sentEmails = emails.filter((e) => e.sendStatus === "sent" && !e.repliedAt);
        if (sentEmails.length === 0)
            continue;
        const mostRecent = sentEmails[0];
        if (!mostRecent.sentAt)
            continue;
        const daysSinceSent = (Date.now() - new Date(mostRecent.sentAt).getTime()) / (24 * 60 * 60 * 1000);
        const alreadyFollowedUp = emails.some((e) => e.emailType === "no_reply_followup" &&
            e.createdAt &&
            new Date(e.createdAt).getTime() > new Date(mostRecent.sentAt).getTime());
        if (alreadyFollowedUp)
            continue;
        if (daysSinceSent >= 14) {
            if (!lead.movedToColdNurtureAt) {
                await (0, db_js_1.updateLeadCrmFields)({
                    leadId: lead.id,
                    movedToColdNurtureAt: new Date().toISOString(),
                });
            }
            movedToCold++;
            console.log("[NoReplyFollowup] Moved", lead.id, "to cold nurture after 14 days no reply");
        }
        else if (daysSinceSent >= 7) {
            await sendFollowupStep(lead, STEP_7_DAYS);
            sent++;
        }
        else if (daysSinceSent >= 3) {
            await sendFollowupStep(lead, STEP_3_DAYS);
            sent++;
        }
    }
    console.log("[NoReplyFollowup] Sent", sent, "— moved", movedToCold, "to cold");
    return { sent, movedToCold };
}
async function sendFollowupStep(lead, step) {
    const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
    const subject = step.subject();
    const body = step.body(firstName, lead);
    const emailRecord = (0, emailStore_js_1.logEmail)({
        leadId: lead.id,
        subject,
        body,
        emailType: "no_reply_followup",
        sendStatus: "pending",
    });
    const result = await (0, index_js_1.sendEmail)(lead.email, subject, body);
    if (result.success)
        (0, emailStore_js_1.markEmailSent)(emailRecord.id, result.messageId);
    else
        (0, emailStore_js_1.markEmailFailed)(emailRecord.id, result.error || "unknown");
}
/** Exported so the copy can be exercised against the listings mirror directly. */
exports.__testFollowupSteps = { day3: STEP_3_DAYS, day7: STEP_7_DAYS };
function scheduleNoReplyFollowupCheck() {
    setInterval(() => {
        checkNoReplyFollowups().catch((err) => console.error("[NoReplyFollowup]", err));
    }, 60 * 60 * 1000);
    console.log("[NoReplyFollowup] Scheduled — checking hourly");
}
