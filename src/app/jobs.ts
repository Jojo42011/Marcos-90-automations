/**
 * Cron/scheduled jobs: follow-up (10), retention (11), A/B evaluation (12).
 */
import { runSafetyDiskCleanup } from "../core/diskCleanup.js";
import { run } from "../modules/09-brivity-sync-fix/index.js";
import { runScheduledFollowUp } from "../modules/10-follow-up-feedback/index.js";
import { runQuarterlyGiftAndReferral, runWeeklyUpdates } from "../modules/11-past-client-retention/index.js";
import { evaluateVariants } from "../modules/12-ab-dm-testing/index.js";
import { runSocialMediaAgent, scheduleSocialMediaAgentDaily6pmCST } from "../agents/socialMedia/index.js";
import { scheduleMorningScanDaily8am } from "../agents/morningScan/index.js";
import { scheduleEveningPullDaily6pm } from "../agents/eveningPull/index.js";
import { scheduleWeeklyContentSuggestionsMonday8am } from "../agents/contentSuggestions/index.js";
import { scheduleEscalationChecks } from "../agents/escalations/index.js";
import { scheduleContentDigestEvery3Days } from "../agents/harveyContentDigest/index.js";
import { scheduleShowingReminders } from "../agents/showingReminders/index.js";
import { scheduleMojoOutreach } from "../agents/mojoOutreach/index.js";
import { scheduleTransactionDeadlineChecks, scheduleDailyDeadlineCheck } from "../agents/transactionDeadlines/index.js";
import { scheduleTaskDeadlineAutomation } from "../core/taskDeadlineAutomation.js";
import { scheduleWarmLeadWeeklyTouch } from "../agents/leadNurture/warmLeadFlow.js";
import { scheduleColdLeadMonthlyTouch } from "../agents/leadNurture/coldLeadFlow.js";
import { scheduleAutoRescore } from "../agents/leadScoring/index.js";
import { scheduleMlsSync } from "../agents/mlsSync/index.js";
import { scheduleLuxurySweep } from "../agents/luxuryContent/index.js";
import { scheduleDailyDigest } from "../agents/reporting/dailyDigest.js";
import { scheduleWeeklyKPI } from "../agents/reporting/weeklyKPI.js";
import {
  scheduleWeeklyFinanceSummary,
  scheduleMonthlyCloseReport,
  schedulePaceCheckDaily,
  scheduleExpenseSpikeCheckWeekly,
} from "../agents/finance/index.js";
import { scheduleBuyerDripProcessor } from "../agents/emailMarketing/buyerDrip.js";
import { scheduleSellerDripProcessor } from "../agents/emailMarketing/sellerDrip.js";
import { schedulePastClientQuarterly } from "../agents/emailMarketing/pastClientQuarterly.js";
import { scheduleNoReplyFollowupCheck } from "../agents/emailMarketing/noReplyFollowup.js";
import { scheduleContentManagerDaily7pmCST } from "../agents/contentManager/index.js";
import { scheduleContentBrainCycles } from "../agents/contentManager/brain/index.js";
import { scheduleVoiceoverProcessor } from "../agents/voiceClone/generator.js";
import { scheduleGoogleDrivePoller } from "../agents/contentManager/googleDrivePull.js";

function msUntilNextUtcHour(hour: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleDiskCleanup(): void {
  const run = () => {
    void runSafetyDiskCleanup().catch((err) =>
      console.error(
        "[disk-cleanup] Safety cleanup failed:",
        err instanceof Error ? err.message : String(err),
      ),
    );
  };
  // Reclaim shortly after boot (catches files orphaned by a crash/restart)...
  setTimeout(run, 60_000);
  // ...then run daily at 03:00 server time.
  setTimeout(() => {
    run();
    setInterval(run, 24 * 60 * 60 * 1000);
  }, msUntilNextUtcHour(3));
}

export function scheduleContentJobs(): void {
  scheduleSocialMediaAgentDaily6pmCST();
  scheduleMorningScanDaily8am();
  scheduleEveningPullDaily6pm();
  scheduleWeeklyContentSuggestionsMonday8am();
  scheduleEscalationChecks();
  scheduleContentDigestEvery3Days();
  scheduleShowingReminders();
  scheduleTaskDeadlineAutomation();
  scheduleMojoOutreach();
  scheduleTransactionDeadlineChecks();
  scheduleDailyDeadlineCheck();
  scheduleWarmLeadWeeklyTouch();
  scheduleColdLeadMonthlyTouch();
  scheduleAutoRescore();
  scheduleMlsSync();
  scheduleLuxurySweep();
  scheduleDailyDigest();
  scheduleWeeklyKPI();
  scheduleWeeklyFinanceSummary();
  scheduleMonthlyCloseReport();
  schedulePaceCheckDaily();
  scheduleExpenseSpikeCheckWeekly();
  scheduleBuyerDripProcessor();
  scheduleSellerDripProcessor();
  schedulePastClientQuarterly();
  scheduleNoReplyFollowupCheck();
  scheduleContentManagerDaily7pmCST();
  scheduleContentBrainCycles();
  scheduleVoiceoverProcessor();
  scheduleGoogleDrivePoller();
  scheduleDiskCleanup();
}

export async function runDailyJobs(): Promise<void> {
  await run();
  await runScheduledFollowUp();
  await evaluateVariants();
  try {
    await runSocialMediaAgent();
    console.log("[social] daily TikTok metrics pull complete");
  } catch (err) {
    console.error("[social] daily TikTok metrics pull failed:", err);
  }
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

