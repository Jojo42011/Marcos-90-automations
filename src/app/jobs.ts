/**
 * Cron/scheduled jobs: follow-up (10), retention (11), A/B evaluation (12).
 */
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

