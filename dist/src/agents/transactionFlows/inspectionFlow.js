"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkInspectionConfirmation = checkInspectionConfirmation;
exports.matchPhoneToRole = matchPhoneToRole;
const transactionsStore_js_1 = require("../../core/transactionsStore.js");
const index_js_1 = require("../../integrations/twilio/index.js");
const YES_PATTERNS = /^\s*(yes|yep|yeah|y|confirmed|✅|👍)\s*[!.]*\s*$/i;
/**
 * Checks if an inbound message is a confirmation for a pending inspection schedule,
 * matched by the sender's phone number against the transaction's party phones.
 */
function checkInspectionConfirmation(fromPhone, message) {
    const transactions = (0, transactionsStore_js_1.getAllTransactions)().filter((tx) => tx.inspectionFlow?.scheduledAt && !tx.inspectionFlow?.reportReceivedAt);
    for (const tx of transactions) {
        const role = matchPhoneToRole(tx, fromPhone);
        if (!role)
            continue;
        if (YES_PATTERNS.test(message.trim())) {
            const confirmed = new Set(tx.inspectionFlow?.scheduleConfirmedParties || []);
            confirmed.add(role);
            (0, transactionsStore_js_1.updateTransaction)(tx.id, {
                inspectionFlow: { ...tx.inspectionFlow, scheduleConfirmedParties: Array.from(confirmed) },
            });
            console.log("[InspectionFlow]", role, "confirmed for", tx.address);
            return {
                handled: true,
                replyMessage: "Got it — confirmed! 👍",
                transactionId: tx.id,
                role,
            };
        }
    }
    return { handled: false };
}
function matchPhoneToRole(tx, phone) {
    const normalized = (0, index_js_1.normalizeToE164)(phone);
    const map = {
        buyer: tx.parties.buyerPhone,
        seller: tx.parties.sellerPhone,
        buyer_agent: tx.parties.buyerAgentPhone,
        seller_agent: tx.parties.sellerAgentPhone,
        inspector: tx.inspectionFlow?.inspectorPhone,
    };
    for (const [role, p] of Object.entries(map)) {
        if (p && (0, index_js_1.normalizeToE164)(p) === normalized)
            return role;
    }
    return null;
}
