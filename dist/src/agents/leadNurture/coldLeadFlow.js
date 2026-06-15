"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runColdLeadMonthlyTouch = runColdLeadMonthlyTouch;
exports.scheduleColdLeadMonthlyTouch = scheduleColdLeadMonthlyTouch;
const db_js_1 = require("../../core/db.js");
const index_js_1 = require("../../integrations/twilio/index.js");
const smsStore_js_1 = require("../../core/smsStore.js");
const textingRules_js_1 = require("../../core/textingRules.js");
const leadScoreStore_js_1 = require("../../core/leadScoreStore.js");
const COLD_VALUE_CONTENT = [
    (firstName) => `Hi ${firstName} — quick San Antonio market note: inventory's been shifting in a few areas worth knowing about if you're still keeping an eye on things. No action needed, just thought you'd find it interesting!`,
    (firstName) => `Hey ${firstName}, hope all's well! Just a friendly market update — rates have moved a bit this month. Always here if questions ever come up, no pressure at all.`,
    (firstName) => `Hi ${firstName} — thought you might find this interesting: home values in some San Antonio suburbs have been trending in ways worth knowing, even if you're not actively looking right now.`,
];
async function runColdLeadMonthlyTouch() {
    const coldScores = (0, leadScoreStore_js_1.getLeadsByTier)("cold");
    let sent = 0;
    let skipped = 0;
    for (const scoreEntry of coldScores) {
        const lead = await (0, db_js_1.getLeadById)(scoreEntry.leadId);
        if (!lead || !lead.phone?.trim()) {
            skipped++;
            continue;
        }
        if (lead.automationPaused) {
            skipped++;
            continue;
        }
        const gate = (0, textingRules_js_1.checkTextingAllowed)(lead.id);
        if (!gate.allowed) {
            skipped++;
            continue;
        }
        const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
        const index = (lead.id.charCodeAt(0) + new Date().getMonth()) % COLD_VALUE_CONTENT.length;
        const message = COLD_VALUE_CONTENT[index](firstName);
        const result = await (0, index_js_1.sendTwilioMessage)(lead.phone, message);
        if (result.success) {
            (0, smsStore_js_1.logSmsMessage)({
                leadId: lead.id,
                messageBody: message,
                direction: "outbound",
                sentAt: new Date().toISOString(),
                threadType: "cold_nurture",
            });
            sent++;
        }
    }
    console.log("[ColdLeadFlow] Monthly touch —", sent, "sent,", skipped, "skipped");
    return { sent, skipped };
}
let lastColdTouchMonthKey = null;
function scheduleColdLeadMonthlyTouch() {
    const checkAndRun = () => {
        const now = new Date();
        const centralDay = now.toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "long" });
        const centralDate = Number(now.toLocaleString("en-US", { timeZone: "America/Chicago", day: "numeric" }));
        const monthKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            hour: "numeric",
            minute: "numeric",
            hour12: false,
        }).formatToParts(now);
        const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
        const minute = Number(parts.find((p) => p.type === "minute")?.value ?? -1);
        if (centralDay === "Monday" &&
            centralDate <= 7 &&
            hour === 10 &&
            minute >= 0 &&
            minute < 2 &&
            lastColdTouchMonthKey !== monthKey) {
            lastColdTouchMonthKey = monthKey;
            runColdLeadMonthlyTouch().catch((err) => console.error("[ColdLeadFlow]", err));
        }
    };
    setInterval(checkAndRun, 60 * 1000);
    console.log("[ColdLeadFlow] Scheduled — first Monday of each month, 10am Central");
}
