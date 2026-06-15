"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWarmLeadWeeklyTouch = runWarmLeadWeeklyTouch;
exports.scheduleWarmLeadWeeklyTouch = scheduleWarmLeadWeeklyTouch;
const db_js_1 = require("../../core/db.js");
const index_js_1 = require("../../integrations/twilio/index.js");
const smsStore_js_1 = require("../../core/smsStore.js");
const textingRules_js_1 = require("../../core/textingRules.js");
const leadScoreStore_js_1 = require("../../core/leadScoreStore.js");
const WARM_TOUCH_TEMPLATES = [
    (firstName) => `Hey ${firstName}! Just checking in — market's still moving in the areas you were interested in. Want me to send over a few fresh options this week?`,
    (firstName) => `Hi ${firstName}, quick market update — rates have been holding steady. Let me know if you'd like to revisit your search or have any questions!`,
    (firstName) => `Hey ${firstName}! Thinking of you — anything change on your end with timeline or what you're looking for? Happy to send updated listings if so.`,
];
function pickTemplate(lead) {
    const index = (lead.id.charCodeAt(0) + new Date().getDate()) % WARM_TOUCH_TEMPLATES.length;
    return WARM_TOUCH_TEMPLATES[index];
}
async function runWarmLeadWeeklyTouch() {
    console.log("[WarmLeadFlow] Email touch NOT implemented — email agent does not exist yet. SMS-only for now.");
    const warmScores = (0, leadScoreStore_js_1.getLeadsByTier)("warm");
    let sent = 0;
    let skipped = 0;
    for (const scoreEntry of warmScores) {
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
            console.log("[WarmLeadFlow] Skipped", lead.id, "-", gate.reason);
            skipped++;
            continue;
        }
        const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
        const message = pickTemplate(lead)(firstName);
        const result = await (0, index_js_1.sendTwilioMessage)(lead.phone, message);
        if (result.success) {
            (0, smsStore_js_1.logSmsMessage)({
                leadId: lead.id,
                messageBody: message,
                direction: "outbound",
                sentAt: new Date().toISOString(),
                threadType: "warm_nurture",
            });
            sent++;
        }
    }
    console.log("[WarmLeadFlow] Weekly touch —", sent, "sent,", skipped, "skipped");
    return { sent, skipped };
}
let lastWarmTouchWeekKey = null;
function centralWeekKey(now) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).formatToParts(now);
    const year = parts.find((p) => p.type === "year")?.value ?? "0000";
    const month = parts.find((p) => p.type === "month")?.value ?? "01";
    const day = Number(parts.find((p) => p.type === "day")?.value ?? 1);
    const weekOfMonth = Math.ceil(day / 7);
    return `${year}-${month}-W${weekOfMonth}`;
}
function scheduleWarmLeadWeeklyTouch() {
    const checkAndRun = () => {
        const now = new Date();
        const centralDay = now.toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "long" });
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            hour: "numeric",
            minute: "numeric",
            hour12: false,
        }).formatToParts(now);
        const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
        const minute = Number(parts.find((p) => p.type === "minute")?.value ?? -1);
        const weekKey = centralWeekKey(now);
        if (centralDay === "Monday" &&
            hour === 10 &&
            minute >= 0 &&
            minute < 2 &&
            lastWarmTouchWeekKey !== weekKey) {
            lastWarmTouchWeekKey = weekKey;
            runWarmLeadWeeklyTouch().catch((err) => console.error("[WarmLeadFlow]", err));
        }
    };
    setInterval(checkAndRun, 60 * 1000);
    console.log("[WarmLeadFlow] Scheduled — Mondays 10am Central");
}
