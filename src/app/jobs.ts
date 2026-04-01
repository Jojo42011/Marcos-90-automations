/**
 * Cron/scheduled jobs: follow-up (10), retention (11), A/B evaluation (12).
 */
import { run } from "../modules/09-brivity-sync-fix/index.js";
import { runScheduledFollowUp } from "../modules/10-follow-up-feedback/index.js";
import { runQuarterlyGiftAndReferral, runWeeklyUpdates } from "../modules/11-past-client-retention/index.js";
import { evaluateVariants } from "../modules/12-ab-dm-testing/index.js";

export async function runDailyJobs(): Promise<void> {
  await run();
  await runScheduledFollowUp();
  await evaluateVariants();
}

export async function runWeeklyJobs(): Promise<void> {
  await runWeeklyUpdates();
}

export async function runQuarterlyJobs(): Promise<void> {
  await runQuarterlyGiftAndReferral();
}

// Run daily jobs when executed as script
if (process.argv[1]?.endsWith("jobs.ts")) {
  runDailyJobs()
    .then(() => console.log("Daily jobs done"))
    .catch((e) => console.error(e));
}

