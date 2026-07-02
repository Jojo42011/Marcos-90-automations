/**
 * Cron/scheduled jobs: follow-up (10), retention (11), A/B evaluation (12).
 */
import fs from "fs";
import path from "path";
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

function scheduleDiskCleanup(): void {
  const runCleanup = () => {
    console.log("[disk-cleanup] Running scheduled disk cleanup...");

    const clipsDir = fs.existsSync("/data/clips")
      ? "/data/clips"
      : path.join(process.cwd(), "data", "clips");
    const uploadsDir = fs.existsSync("/data/uploads")
      ? "/data/uploads"
      : path.join(process.cwd(), "data", "uploads");

    let deletedCount = 0;
    let freedBytes = 0;
    const cutoffMs = 14 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const cleanDir = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          cleanDir(fullPath);
          try {
            if (fs.readdirSync(fullPath).length === 0) {
              fs.rmdirSync(fullPath);
            }
          } catch {
            /* ignore */
          }
        } else {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > cutoffMs) {
            freedBytes += stat.size;
            fs.unlinkSync(fullPath);
            deletedCount++;
          }
        }
      }
    };

    try {
      cleanDir(clipsDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[disk-cleanup] Error cleaning clips dir:", msg);
    }

    const uploadsVideoDir = path.join(uploadsDir, "videos");
    if (fs.existsSync(uploadsVideoDir)) {
      try {
        const uploadCutoff = 2 * 24 * 60 * 60 * 1000;
        const files = fs.readdirSync(uploadsVideoDir);
        for (const file of files) {
          const fullPath = path.join(uploadsVideoDir, file);
          const stat = fs.statSync(fullPath);
          if (Date.now() - stat.mtimeMs > uploadCutoff) {
            freedBytes += stat.size;
            fs.unlinkSync(fullPath);
            deletedCount++;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[disk-cleanup] Error cleaning uploads dir:", msg);
      }
    }

    const freedMB = Math.round(freedBytes / (1024 * 1024));
    console.log(`[disk-cleanup] Complete: ${deletedCount} files deleted, ${freedMB}MB freed`);
  };

  setTimeout(runCleanup, 30000);
  setInterval(runCleanup, 24 * 60 * 60 * 1000);
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

