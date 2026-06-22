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
const index_js_11 = require("../agents/showingReminders/index.js");
const index_js_12 = require("../agents/mojoOutreach/index.js");
const index_js_13 = require("../agents/transactionDeadlines/index.js");
const taskDeadlineAutomation_js_1 = require("../core/taskDeadlineAutomation.js");
const warmLeadFlow_js_1 = require("../agents/leadNurture/warmLeadFlow.js");
const coldLeadFlow_js_1 = require("../agents/leadNurture/coldLeadFlow.js");
const index_js_14 = require("../agents/leadScoring/index.js");
const dailyDigest_js_1 = require("../agents/reporting/dailyDigest.js");
const weeklyKPI_js_1 = require("../agents/reporting/weeklyKPI.js");
const index_js_15 = require("../agents/finance/index.js");
const buyerDrip_js_1 = require("../agents/emailMarketing/buyerDrip.js");
const sellerDrip_js_1 = require("../agents/emailMarketing/sellerDrip.js");
const pastClientQuarterly_js_1 = require("../agents/emailMarketing/pastClientQuarterly.js");
const noReplyFollowup_js_1 = require("../agents/emailMarketing/noReplyFollowup.js");
const index_js_16 = require("../agents/contentManager/index.js");
const index_js_17 = require("../agents/contentManager/brain/index.js");
function scheduleContentJobs() {
    (0, index_js_5.scheduleSocialMediaAgentDaily6pmCST)();
    (0, index_js_6.scheduleMorningScanDaily8am)();
    (0, index_js_7.scheduleEveningPullDaily6pm)();
    (0, index_js_8.scheduleWeeklyContentSuggestionsMonday8am)();
    (0, index_js_9.scheduleEscalationChecks)();
    (0, index_js_10.scheduleContentDigestEvery3Days)();
    (0, index_js_11.scheduleShowingReminders)();
    (0, taskDeadlineAutomation_js_1.scheduleTaskDeadlineAutomation)();
    (0, index_js_12.scheduleMojoOutreach)();
    (0, index_js_13.scheduleTransactionDeadlineChecks)();
    (0, index_js_13.scheduleDailyDeadlineCheck)();
    (0, warmLeadFlow_js_1.scheduleWarmLeadWeeklyTouch)();
    (0, coldLeadFlow_js_1.scheduleColdLeadMonthlyTouch)();
    (0, index_js_14.scheduleAutoRescore)();
    (0, dailyDigest_js_1.scheduleDailyDigest)();
    (0, weeklyKPI_js_1.scheduleWeeklyKPI)();
    (0, index_js_15.scheduleWeeklyFinanceSummary)();
    (0, index_js_15.scheduleMonthlyCloseReport)();
    (0, index_js_15.schedulePaceCheckDaily)();
    (0, index_js_15.scheduleExpenseSpikeCheckWeekly)();
    (0, buyerDrip_js_1.scheduleBuyerDripProcessor)();
    (0, sellerDrip_js_1.scheduleSellerDripProcessor)();
    (0, pastClientQuarterly_js_1.schedulePastClientQuarterly)();
    (0, noReplyFollowup_js_1.scheduleNoReplyFollowupCheck)();
    (0, index_js_16.scheduleContentManagerDaily7pmCST)();
    (0, index_js_17.scheduleContentBrainCycles)();
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
