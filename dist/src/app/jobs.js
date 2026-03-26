"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
async function runDailyJobs() {
    await (0, index_js_1.run)();
    await (0, index_js_2.runScheduledFollowUp)();
    await (0, index_js_4.evaluateVariants)();
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
