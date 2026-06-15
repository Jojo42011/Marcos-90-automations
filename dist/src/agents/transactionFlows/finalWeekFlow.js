"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkFinalWeekTriggers = checkFinalWeekTriggers;
exports.buildWhatToExpectGuide = buildWhatToExpectGuide;
const transactionsStore_js_1 = require("../../core/transactionsStore.js");
const index_js_1 = require("../../integrations/twilio/index.js");
async function checkFinalWeekTriggers() {
    const transactions = (0, transactionsStore_js_1.getAllTransactions)("under_contract");
    let triggered = 0;
    const now = Date.now();
    for (const tx of transactions) {
        if (!tx.closingDate)
            continue;
        const closingTime = new Date(tx.closingDate).getTime();
        const daysUntilClosing = (closingTime - now) / (24 * 60 * 60 * 1000);
        if (daysUntilClosing <= 7 &&
            daysUntilClosing > 0 &&
            !tx.finalWeekFlow?.closingDisclosureReminderSentAt) {
            await runFinalWeekActions(tx);
            triggered++;
        }
    }
    return { triggered };
}
async function runFinalWeekActions(tx) {
    const now = new Date().toISOString();
    const flow = { ...tx.finalWeekFlow };
    if (tx.parties.buyerPhone) {
        await (0, index_js_1.sendTwilioMessage)(tx.parties.buyerPhone, `Your Closing Disclosure for ${tx.address} should be in your inbox/email — please review it as soon as possible. Let us know if you have questions!`);
    }
    flow.closingDisclosureReminderSentAt = now;
    if (tx.parties.titleContactPhone) {
        await (0, index_js_1.sendTwilioMessage)(tx.parties.titleContactPhone, `Confirming wire instructions for closing on ${tx.address} (closing ${new Date(tx.closingDate).toLocaleDateString()}). Please confirm instructions are finalized and verified.`);
    }
    const guideMessage = buildWhatToExpectGuide(tx);
    if (tx.parties.buyerPhone) {
        await (0, index_js_1.sendTwilioMessage)(tx.parties.buyerPhone, guideMessage);
        flow.whatToExpectGuideSentAt = now;
    }
    (0, transactionsStore_js_1.updateTransaction)(tx.id, { finalWeekFlow: flow });
    console.log("[FinalWeekFlow] Triggered for", tx.address);
}
function buildWhatToExpectGuide(tx) {
    const closingDateStr = new Date(tx.closingDate).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
    });
    return (`Closing week is here! 🎉 Quick rundown for ${tx.address}:\n` +
        `• Final walkthrough happens before closing — we'll confirm timing soon\n` +
        `• Bring a valid photo ID to closing on ${closingDateStr}\n` +
        `• Funds for closing must be wired or in certified form — NEVER send money based on emailed instructions without verbally confirming with your title company\n` +
        `• Questions? Just reply here anytime.`);
}
