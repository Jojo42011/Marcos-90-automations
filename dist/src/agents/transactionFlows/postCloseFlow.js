"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkCloseDayTriggers = checkCloseDayTriggers;
exports.triggerReviewRequest = triggerReviewRequest;
exports.markLeadAsPastClient = markLeadAsPastClient;
exports.checkScheduledClientCheckIns = checkScheduledClientCheckIns;
const db_js_1 = require("../../core/db.js");
const transactionsStore_js_1 = require("../../core/transactionsStore.js");
const index_js_1 = require("../../integrations/twilio/index.js");
async function checkCloseDayTriggers() {
    const transactions = (0, transactionsStore_js_1.getAllTransactions)("closed");
    let triggered = 0;
    for (const tx of transactions) {
        if (tx.postCloseFlow?.congratulationsSentAt)
            continue;
        await runCloseDayActions(tx);
        triggered++;
    }
    return { triggered };
}
async function runCloseDayActions(tx) {
    const now = new Date().toISOString();
    const flow = { ...tx.postCloseFlow };
    const buyerOrSellerName = tx.parties.buyerName || tx.parties.sellerName || "there";
    const firstName = buyerOrSellerName.split(/\s+/)[0];
    const congratsMessage = `Congratulations, ${firstName}! 🎉🏡 ${tx.address} is officially yours${tx.dealType === "seller" ? " — sold!" : ""}. ` +
        `It's been a pleasure working with you. Welcome home!`;
    const clientPhone = tx.dealType === "seller" ? tx.parties.sellerPhone : tx.parties.buyerPhone;
    if (clientPhone) {
        await (0, index_js_1.sendTwilioMessage)(clientPhone, congratsMessage);
        flow.congratulationsSentAt = now;
    }
    await triggerReviewRequest(tx);
    flow.reviewRequestTriggeredAt = now;
    if (tx.leadId) {
        await markLeadAsPastClient(tx.leadId, tx.closingDate || now);
    }
    flow.pastClientNurtureAddedAt = now;
    const closeDate = new Date(tx.closingDate || now);
    flow.checkIn30DayScheduledFor = new Date(closeDate.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    flow.checkIn1YearScheduledFor = new Date(closeDate.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
    (0, transactionsStore_js_1.updateTransaction)(tx.id, { postCloseFlow: flow });
    console.log("[PostCloseFlow] Close day actions complete for", tx.address);
}
/**
 * Trigger point for the Reputation Agent. Logs + reviewRequestTriggeredAt on the transaction
 * until a full review-request agent exists (Google/Zillow links need Marco's input).
 */
async function triggerReviewRequest(tx) {
    console.log("[PostCloseFlow] REVIEW REQUEST TRIGGERED for", tx.address, "— lead:", tx.leadId ?? "none");
}
async function markLeadAsPastClient(leadId, closedAt) {
    const { getLeadById } = await Promise.resolve().then(() => __importStar(require("../../core/db.js")));
    const existing = await getLeadById(leadId);
    if (!existing)
        return;
    const existingTags = existing.tags ?? [];
    const tags = existingTags.includes("Past Client") ? existingTags : [...existingTags, "Past Client"];
    await (0, db_js_1.updateLeadCrmFields)({
        leadId,
        isPastClient: true,
        pastClientSince: closedAt,
        tags,
    });
    console.log("[PostCloseFlow] Marked lead", leadId, "as past client");
}
async function checkScheduledClientCheckIns() {
    const transactions = (0, transactionsStore_js_1.getAllTransactions)("closed").filter((tx) => tx.postCloseFlow);
    let sent = 0;
    const now = Date.now();
    for (const tx of transactions) {
        const flow = tx.postCloseFlow;
        const clientPhone = tx.dealType === "seller" ? tx.parties.sellerPhone : tx.parties.buyerPhone;
        if (!clientPhone)
            continue;
        const firstName = (tx.parties.buyerName || tx.parties.sellerName || "there").split(/\s+/)[0];
        if (flow.checkIn30DayScheduledFor &&
            !flow.checkIn30DayCompletedAt &&
            now >= new Date(flow.checkIn30DayScheduledFor).getTime()) {
            await (0, index_js_1.sendTwilioMessage)(clientPhone, `Hey ${firstName}! Just checking in — how's everything going at ${tx.address}? Let us know if you need anything at all, even if it's just a recommendation for a local contractor or service!`);
            (0, transactionsStore_js_1.updateTransaction)(tx.id, {
                postCloseFlow: { ...flow, checkIn30DayCompletedAt: new Date().toISOString() },
            });
            sent++;
        }
        if (flow.checkIn1YearScheduledFor &&
            !flow.checkIn1YearCompletedAt &&
            now >= new Date(flow.checkIn1YearScheduledFor).getTime()) {
            await (0, index_js_1.sendTwilioMessage)(clientPhone, `Happy almost-anniversary in your home, ${firstName}! 🏡 Hope the past year has been great. If you know anyone thinking about buying or selling, I'd love an introduction — and as always, here if you ever need anything!`);
            (0, transactionsStore_js_1.updateTransaction)(tx.id, {
                postCloseFlow: { ...tx.postCloseFlow, checkIn1YearCompletedAt: new Date().toISOString() },
            });
            sent++;
        }
    }
    return { sent };
}
