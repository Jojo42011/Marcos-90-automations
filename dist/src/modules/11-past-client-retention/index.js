"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWeeklyUpdates = runWeeklyUpdates;
exports.runQuarterlyGiftAndReferral = runQuarterlyGiftAndReferral;
const pastClientQuarterly_js_1 = require("../../agents/emailMarketing/pastClientQuarterly.js");
const db_js_1 = require("../../core/db.js");
const tenantData_js_1 = require("../../core/tenantData.js");
/** Review tasks are deduplicated by period. No unconfigured gift purchase or duplicate email campaign. */
function reviewTask(key, title, description) {
    key = `${(0, tenantData_js_1.tenantOwner)() || "root"}:${key}`;
    if ((0, db_js_1.getCommandTasks)().some(task => task.tags?.includes(key)))
        return false;
    (0, db_js_1.createCommandTask)({ title, description, column: "this_week", color: "blue", status: "pending", createdBy: (0, tenantData_js_1.tenantOwner)() || "automation", assignedTo: process.env.TENANT_MEMBER || "marco", tags: [key] });
    return true;
}
async function runWeeklyUpdates() {
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    now.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    const period = now.toISOString().slice(0, 10);
    let created = 0;
    for (const lead of await (0, db_js_1.listAllLeads)())
        if (lead.isPastClient && !["trashed", "archived", "dead"].includes(lead.crmStatus)) {
            if (reviewTask(`retention-week:${lead.id}:${period}`, `Review weekly update for ${lead.name || "past client"}`, `Review contact ${lead.id} and current market information before sending a personal update.`))
                created++;
        }
    return { created };
}
async function runQuarterlyGiftAndReferral() {
    const result = await (0, pastClientQuarterly_js_1.runPastClientQuarterlyTouch)();
    const now = new Date();
    const period = `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
    let giftReviews = 0;
    for (const lead of await (0, db_js_1.listAllLeads)())
        if (lead.isPastClient && !["trashed", "archived", "dead"].includes(lead.crmStatus)) {
            if (reviewTask(`retention-gift:${lead.id}:${period}`, `Review gift and referral follow-up for ${lead.name || "past client"}`, `Confirm contact ${lead.id}, delivery address, gift choice and budget before placing an order. No purchase has been made.`))
                giftReviews++;
        }
    return { ...result, giftReviews };
}
