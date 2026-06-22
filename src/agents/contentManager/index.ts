import { ensureDailyTargets, todayDateCst } from "../../core/contentDb.js";
import { getDailyReport, getWeeklyReport, runPerformanceSync } from "./analytics.js";

export { ingestContent } from "./ingest.js";
export { repurposeSession } from "./repurpose.js";
export { runComplianceCheck, applyComplianceDecision } from "./compliance.js";
export { publishVideo } from "./publish.js";
export { triageDm, trackCommentManaged, trackDmTriaged } from "./communityManager.js";
export { runPerformanceSync, getDailyReport, getWeeklyReport } from "./analytics.js";

let lastScheduledContentManagerDate: string | null = null;

/** Main scheduled entry point — daily 7pm CST. */
export async function runContentManagerJob() {
  const syncSummary = await runPerformanceSync();
  const today = todayDateCst();
  ensureDailyTargets(today);
  const dailyReport = getDailyReport(today);

  const t = dailyReport.targets;
  console.log(
    `[content-manager] Daily sync complete — ${t.videosPublished}/${t.videosTarget} videos, ` +
      `${t.phoneNumbersCaptured}/${t.phoneNumbersTarget} numbers, ` +
      `${syncSummary.hotCount}/${syncSummary.averageCount}/${syncSummary.coldCount} performance split`,
  );

  return {
    syncSummary,
    dailyReport,
    weeklyReport: getWeeklyReport(),
  };
}

/** Run runContentManagerJob once per day at 7:00 PM America/Chicago. */
export function scheduleContentManagerDaily7pmCST(): void {
  console.log("[content-manager] daily job scheduled at 7:00 PM America/Chicago");

  setInterval(() => {
    const now = new Date();
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? -1);

    if (hour === 19 && minute >= 0 && minute < 2 && lastScheduledContentManagerDate !== dateStr) {
      lastScheduledContentManagerDate = dateStr;
      runContentManagerJob().catch((err) =>
        console.error("[content-manager] scheduled run failed:", err),
      );
    }
  }, 60_000);
}
