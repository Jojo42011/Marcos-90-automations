"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduleContentJobs = scheduleContentJobs;
exports.runDailyJobs = runDailyJobs;
exports.runWeeklyJobs = runWeeklyJobs;
exports.runQuarterlyJobs = runQuarterlyJobs;
/**
 * Cron/scheduled jobs: follow-up (10), retention (11), A/B evaluation (12).
 */
const index_js_1 = require("../modules/09-brivity-sync-fix/index.js");
const index_js_2 = require("../modules/10-follow-up-feedback/index.js");
const index_js_3 = require("../modules/11-past-client-retention/index.js");
const index_js_4 = require("../modules/12-ab-dm-testing/index.js");
const index_js_5 = require("../agents/socialMedia/index.js");
const index_js_6 = require("../agents/morningScan/index.js");
const index_js_7 = require("../agents/eveningPull/index.js");
const index_js_8 = require("../agents/contentSuggestions/index.js");
const index_js_9 = require("../agents/escalations/index.js");
const index_js_10 = require("../agents/harveyContentDigest/index.js");
function scheduleContentJobs() {
    (0, index_js_5.scheduleSocialMediaAgentDaily6pmCST)();
    (0, index_js_6.scheduleMorningScanDaily8am)();
    (0, index_js_7.scheduleEveningPullDaily6pm)();
    (0, index_js_8.scheduleWeeklyContentSuggestionsMonday8am)();
    (0, index_js_9.scheduleEscalationChecks)();
    (0, index_js_10.scheduleContentDigestEvery3Days)();
}
async function runDailyJobs() {
    await (0, index_js_1.run)();
    await (0, index_js_2.runScheduledFollowUp)();
    await (0, index_js_4.evaluateVariants)();
    try {
        await (0, index_js_5.runSocialMediaAgent)();
        console.log("[social] daily TikTok metrics pull complete");
    }
    catch (err) {
        console.error("[social] daily TikTok metrics pull failed:", err);
    }
}
async function runWeeklyJobs() {
    await (0, index_js_3.runWeeklyUpdates)();
}
async function runQuarterlyJobs() {
    await (0, index_js_3.runQuarterlyGiftAndReferral)();
}
// Run daily jobs when executed as script
if (process.argv[1]?.endsWith("jobs.ts")) {
    runDailyJobs()
        .then(() => console.log("Daily jobs done"))
        .catch((e) => console.error(e));
}
