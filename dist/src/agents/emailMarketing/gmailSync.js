"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGmailSyncStatus = getGmailSyncStatus;
exports.syncGmailInbox = syncGmailInbox;
exports.getGmailInboxForHarvey = getGmailInboxForHarvey;
exports.linkSentEmailToGmail = linkSentEmailToGmail;
const inbox_js_1 = require("../../integrations/gmail/inbox.js");
const index_js_1 = require("../../integrations/gmail/index.js");
const emailStore_js_1 = require("../../core/emailStore.js");
const db_js_1 = require("../../core/db.js");
const KV_LAST_SYNC_AT = "gmail_last_sync_at";
const KV_LAST_SYNC_ERROR = "gmail_last_sync_error";
const KV_LAST_SYNC_ERROR_AT = "gmail_last_sync_error_at";
function getGmailSyncStatus() {
    return {
        lastSyncAt: (0, emailStore_js_1.kvGet)(KV_LAST_SYNC_AT),
        lastError: (0, emailStore_js_1.kvGet)(KV_LAST_SYNC_ERROR) || null,
        lastErrorAt: (0, emailStore_js_1.kvGet)(KV_LAST_SYNC_ERROR_AT),
    };
}
async function syncGmailInbox(opts) {
    if (!(0, index_js_1.isGmailConfigured)()) {
        return { synced: 0, repliesMatched: 0, messages: [] };
    }
    let messages;
    try {
        messages = await (0, inbox_js_1.listGmailMessages)({
            maxResults: opts?.maxResults ?? 30,
            query: opts?.query ?? "newer_than:14d",
        });
    }
    catch (err) {
        // Record the failure so the dashboard can surface it — a dead OAuth token
        // once left this silently broken for three weeks.
        const message = err instanceof Error ? err.message : String(err);
        try {
            (0, emailStore_js_1.kvSet)(KV_LAST_SYNC_ERROR, message);
            (0, emailStore_js_1.kvSet)(KV_LAST_SYNC_ERROR_AT, new Date().toISOString());
        }
        catch {
            /* bookkeeping only */
        }
        throw err;
    }
    const leads = await (0, db_js_1.listAllLeads)();
    const emailToLead = new Map();
    for (const l of leads) {
        if (l.email?.trim())
            emailToLead.set(l.email.trim().toLowerCase(), l.id);
    }
    const now = new Date().toISOString();
    let synced = 0;
    let repliesMatched = 0;
    for (const m of messages) {
        const sender = m.direction === "inbound" ? (0, inbox_js_1.extractSenderEmail)(m.from) : "";
        const leadId = sender ? emailToLead.get(sender) : undefined;
        if (m.direction === "inbound" && leadId) {
            (0, emailStore_js_1.markEmailReplied)(leadId);
            repliesMatched++;
        }
        (0, emailStore_js_1.cacheGmailMessage)({
            id: m.id,
            threadId: m.threadId,
            direction: m.direction,
            fromAddr: m.from,
            toAddr: m.to,
            subject: m.subject,
            snippet: m.snippet,
            body: m.snippet,
            receivedAt: m.date,
            leadId,
            syncedAt: now,
        });
        synced++;
    }
    try {
        (0, emailStore_js_1.kvSet)(KV_LAST_SYNC_AT, now);
        (0, emailStore_js_1.kvSet)(KV_LAST_SYNC_ERROR, "");
    }
    catch {
        /* bookkeeping only */
    }
    console.log(`[GmailSync] synced ${synced} messages, matched ${repliesMatched} inbound replies`);
    return { synced, repliesMatched, messages };
}
function getGmailInboxForHarvey(limit = 15) {
    return {
        configured: (0, index_js_1.isGmailConfigured)(),
        cached: (0, emailStore_js_1.getCachedGmailMessages)(limit),
    };
}
/** After outbound send, link local email row to Gmail message id. */
function linkSentEmailToGmail(localEmailId, gmailMessageId) {
    (0, emailStore_js_1.attachGmailMessageId)(localEmailId, gmailMessageId);
}
