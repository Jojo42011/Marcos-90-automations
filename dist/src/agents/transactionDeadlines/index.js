"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkTransactionDeadlines = checkTransactionDeadlines;
exports.checkMissedSameDayDeadlines = checkMissedSameDayDeadlines;
exports.runDailyTransactionWorkflowChecks = runDailyTransactionWorkflowChecks;
exports.runDailyDeadlineCheck = runDailyDeadlineCheck;
exports.scheduleTransactionDeadlineChecks = scheduleTransactionDeadlineChecks;
exports.scheduleDailyDeadlineCheck = scheduleDailyDeadlineCheck;
const transactionsStore_js_1 = require("../../core/transactionsStore.js");
const index_js_1 = require("../../integrations/twilio/index.js");
const finalWeekFlow_js_1 = require("../transactionFlows/finalWeekFlow.js");
const postCloseFlow_js_1 = require("../transactionFlows/postCloseFlow.js");
const DEADLINE_LABELS = {
    inspection: "Inspection",
    appraisal: "Appraisal",
    loan_commitment: "Loan Commitment",
    title: "Title Commitment",
    closing: "Closing",
    option_period: "Option Period",
    earnest_money: "Earnest Money Deposit",
    custom: "Deadline",
};
async function checkTransactionDeadlines() {
    let alertsSent = 0;
    let escalations = 0;
    const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
    if (!marcoNumber) {
        console.warn("[TransactionDeadlines] MARCO_PHONE_NUMBER not set — alerts will be skipped");
    }
    const upcoming = (0, transactionsStore_js_1.getUpcomingDeadlines)(3);
    for (const deadline of upcoming) {
        if (deadline.alertSent)
            continue;
        const tx = (0, transactionsStore_js_1.getTransaction)(deadline.dealId);
        if (!tx)
            continue;
        const label = deadline.label || DEADLINE_LABELS[deadline.deadlineType] || deadline.deadlineType;
        const dueDate = new Date(deadline.dueDate).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            timeZone: "America/Chicago",
        });
        const message = `📋 Upcoming: ${label} due ${dueDate} for ${tx.address}. Check Transactions for details.`;
        if (marcoNumber) {
            const result = await (0, index_js_1.sendTwilioMessage)(marcoNumber, message);
            if (result.success) {
                (0, transactionsStore_js_1.markDeadlineAlertSent)(deadline.id);
                alertsSent++;
                console.log("[TransactionDeadlines] Alert sent for", label, "-", tx.address);
            }
        }
    }
    const overdue = (0, transactionsStore_js_1.getOverdueDeadlines)();
    for (const deadline of overdue) {
        if (deadline.escalated)
            continue;
        const tx = (0, transactionsStore_js_1.getTransaction)(deadline.dealId);
        if (!tx)
            continue;
        const label = deadline.label || DEADLINE_LABELS[deadline.deadlineType] || deadline.deadlineType;
        const dueDate = new Date(deadline.dueDate).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            timeZone: "America/Chicago",
        });
        const message = `🚨 OVERDUE: ${label} was due ${dueDate} for ${tx.address} and has NOT been marked complete. This needs immediate attention.`;
        if (marcoNumber) {
            const result = await (0, index_js_1.sendTwilioMessage)(marcoNumber, message);
            if (result.success) {
                (0, transactionsStore_js_1.markDeadlineEscalated)(deadline.id);
                escalations++;
                console.log("[TransactionDeadlines] ESCALATED overdue", label, "-", tx.address);
            }
        }
    }
    console.log("[TransactionDeadlines] Check complete —", alertsSent, "alerts,", escalations, "escalations");
    return { alertsSent, escalations };
}
async function checkMissedSameDayDeadlines() {
    const overdue = (0, transactionsStore_js_1.getOverdueDeadlines)();
    let escalations = 0;
    const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
    if (!marcoNumber) {
        console.warn("[MissedDeadline] MARCO_PHONE_NUMBER not set");
        return { escalations: 0 };
    }
    const now = new Date();
    for (const deadline of overdue) {
        if (deadline.missedSameDayEscalated)
            continue;
        const dueDate = new Date(deadline.dueDate);
        const hoursSinceDue = (now.getTime() - dueDate.getTime()) / (60 * 60 * 1000);
        if (hoursSinceDue > 24)
            continue;
        const tx = (0, transactionsStore_js_1.getTransaction)(deadline.dealId);
        if (!tx)
            continue;
        const label = deadline.label || DEADLINE_LABELS[deadline.deadlineType] || deadline.deadlineType;
        const contextLines = [
            `🚨 MISSED DEADLINE: ${label}`,
            `Property: ${tx.address}`,
            `Status: ${tx.status}`,
            `Deal type: ${tx.dealType}`,
            tx.parties.buyerName ? `Buyer: ${tx.parties.buyerName}` : null,
            tx.parties.sellerName ? `Seller: ${tx.parties.sellerName}` : null,
            tx.parties.buyerAgent ? `Buyer agent: ${tx.parties.buyerAgent}` : null,
            tx.parties.sellerAgent ? `Seller agent: ${tx.parties.sellerAgent}` : null,
            tx.closingDate ? `Closing: ${new Date(tx.closingDate).toLocaleDateString()}` : null,
            `Due: ${dueDate.toLocaleDateString()} — NOT marked complete.`,
        ].filter(Boolean);
        const message = contextLines.join("\n");
        const result = await (0, index_js_1.sendTwilioMessage)(marcoNumber, message);
        if (result.success) {
            (0, transactionsStore_js_1.markDeadlineMissedSameDayEscalated)(deadline.id);
            escalations++;
            console.log("[MissedDeadline] Escalated with full context:", label, "-", tx.address);
        }
    }
    return { escalations };
}
async function runDailyTransactionWorkflowChecks() {
    const deadlineResult = await runDailyDeadlineCheck();
    const finalWeek = await (0, finalWeekFlow_js_1.checkFinalWeekTriggers)();
    const closeDay = await (0, postCloseFlow_js_1.checkCloseDayTriggers)();
    const checkIns = await (0, postCloseFlow_js_1.checkScheduledClientCheckIns)();
    return {
        partyAlertsSent: deadlineResult.partyAlertsSent,
        sameDayEscalations: deadlineResult.sameDayEscalations,
        finalWeekTriggered: finalWeek.triggered,
        closeDayTriggered: closeDay.triggered,
        checkInsSent: checkIns.sent,
    };
}
async function runDailyDeadlineCheck() {
    let partyAlertsSent = 0;
    let sameDayEscalations = 0;
    const allDeadlines = (0, transactionsStore_js_1.getUpcomingDeadlines)(3);
    const now = new Date();
    for (const deadline of allDeadlines) {
        if (deadline.completed)
            continue;
        const tx = (0, transactionsStore_js_1.getTransaction)(deadline.dealId);
        if (!tx)
            continue;
        const dueDate = new Date(deadline.dueDate);
        const centralNowParts = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            year: "numeric",
            month: "numeric",
            day: "numeric",
        }).formatToParts(now);
        const centralDueParts = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            year: "numeric",
            month: "numeric",
            day: "numeric",
        }).formatToParts(dueDate);
        const todayKey = `${centralNowParts.find((p) => p.type === "year")?.value}-${centralNowParts.find((p) => p.type === "month")?.value}-${centralNowParts.find((p) => p.type === "day")?.value}`;
        const dueKey = `${centralDueParts.find((p) => p.type === "year")?.value}-${centralDueParts.find((p) => p.type === "month")?.value}-${centralDueParts.find((p) => p.type === "day")?.value}`;
        const isSameDay = todayKey === dueKey;
        const label = deadline.label || DEADLINE_LABELS[deadline.deadlineType] || deadline.deadlineType;
        const dueDateStr = dueDate.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            timeZone: "America/Chicago",
        });
        const partyContacts = [
            { role: "Buyer", phone: tx.parties.buyerPhone },
            { role: "Buyer Agent", phone: tx.parties.buyerAgentPhone },
            { role: "Seller", phone: tx.parties.sellerPhone },
            { role: "Seller Agent", phone: tx.parties.sellerAgentPhone },
            { role: "Lender", phone: tx.parties.lenderPhone },
            { role: "Title", phone: tx.parties.titleContactPhone },
        ];
        for (const contact of partyContacts) {
            if (!contact.phone?.trim())
                continue;
            const message = isSameDay
                ? `⏰ Reminder: ${label} for ${tx.address} is due TODAY (${dueDateStr}).`
                : `📋 Upcoming: ${label} for ${tx.address} is due ${dueDateStr}.`;
            const result = await (0, index_js_1.sendTwilioMessage)(contact.phone, message);
            if (result.success) {
                partyAlertsSent++;
                console.log("[DailyDeadlineCheck] Notified", contact.role, "for", label, "-", tx.address);
            }
        }
        if (isSameDay) {
            const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
            if (marcoNumber) {
                const marcoMessage = `🚨 TODAY: ${label} is due for ${tx.address}. Make sure all parties have followed through.`;
                const result = await (0, index_js_1.sendTwilioMessage)(marcoNumber, marcoMessage);
                if (result.success) {
                    sameDayEscalations++;
                    console.log("[DailyDeadlineCheck] Same-day escalation to Marco:", label, "-", tx.address);
                }
            }
        }
    }
    console.log("[DailyDeadlineCheck] Complete —", partyAlertsSent, "party alerts,", sameDayEscalations, "same-day escalations to Marco");
    return { partyAlertsSent, sameDayEscalations };
}
let lastDailyDeadlineCheckDate = null;
function scheduleTransactionDeadlineChecks() {
    setInterval(() => {
        checkTransactionDeadlines().catch((err) => console.error("[TransactionDeadlines]", err));
        checkMissedSameDayDeadlines().catch((err) => console.error("[MissedDeadline]", err));
    }, 4 * 60 * 60 * 1000);
    console.log("[TransactionDeadlines] Scheduled — checking every 4 hours (incl. missed same-day)");
}
function scheduleDailyDeadlineCheck() {
    const checkAndRun = () => {
        const now = new Date();
        const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            hour: "numeric",
            minute: "numeric",
            hour12: false,
        }).formatToParts(now);
        const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
        const minute = Number(parts.find((p) => p.type === "minute")?.value ?? -1);
        if (hour === 8 && minute >= 0 && minute < 2 && lastDailyDeadlineCheckDate !== dateStr) {
            lastDailyDeadlineCheckDate = dateStr;
            runDailyTransactionWorkflowChecks().catch((err) => console.error("[DailyTransactionWorkflows]", err));
        }
    };
    setInterval(checkAndRun, 60 * 1000);
    console.log("[DailyDeadlineCheck] Scheduled for 8:00 AM Central daily");
}
