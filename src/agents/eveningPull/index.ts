import { getLatestSocialDashboardData } from "../../core/socialStore.js";
import type { SocialDashboardVideo } from "../../core/socialStore.js";
import { runSocialMediaAgent } from "../socialMedia/index.js";
import { saveReportingSnapshot } from "../reporting/index.js";

export interface EveningPullResult {
  generatedAt: string;
  videosScoredLast7Days: number;
  topPerformer: { description: string; score: number; views: number } | null;
  underperformers: { description: string; score: number; views: number }[];
  avgScoreLast7Days: number;
  summary: string;
}

function videoCaption(v: SocialDashboardVideo): string {
  return (v.caption || "").trim();
}

function videoScore(v: SocialDashboardVideo): number {
  return v.scoreBreakdown?.score ?? v.score ?? 0;
}

export async function runEveningPull(): Promise<EveningPullResult> {
  console.log("[EveningPull] Starting evening performance pull...");

  try {
    await runSocialMediaAgent();
  } catch (err) {
    console.error("[EveningPull] Refresh failed, using existing data:", err);
  }

  const data = getLatestSocialDashboardData();
  const videos = data.videos || [];

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const recentVideos = videos.filter((v) => {
    const postedAt = new Date(v.postedAt || 0).getTime();
    return postedAt >= sevenDaysAgo;
  });

  const sorted = [...recentVideos].sort((a, b) => videoScore(b) - videoScore(a));

  const topPerformer =
    sorted.length > 0
      ? {
          description: videoCaption(sorted[0]).substring(0, 80),
          score: videoScore(sorted[0]),
          views: sorted[0].views || 0,
        }
      : null;

  const underperformers = sorted
    .filter((v) => videoScore(v) < 40)
    .slice(0, 3)
    .map((v) => ({
      description: videoCaption(v).substring(0, 80),
      score: videoScore(v),
      views: v.views || 0,
    }));

  const avgScore =
    recentVideos.length > 0
      ? Math.round(
          recentVideos.reduce((sum, v) => sum + videoScore(v), 0) / recentVideos.length,
        )
      : 0;

  const result: EveningPullResult = {
    generatedAt: new Date().toISOString(),
    videosScoredLast7Days: recentVideos.length,
    topPerformer,
    underperformers,
    avgScoreLast7Days: avgScore,
    summary:
      `${recentVideos.length} videos posted in last 7 days, avg score ${avgScore}/100. ` +
      (topPerformer
        ? `Best performer: "${topPerformer.description}" scored ${topPerformer.score}/100 with ${topPerformer.views.toLocaleString()} views. `
        : "") +
      (underperformers.length > 0
        ? `${underperformers.length} videos underperformed (under 40/100).`
        : "No underperforming videos this week."),
  };

  saveReportingSnapshot({
    type: "evening",
    generatedAt: result.generatedAt,
    summary: result.summary,
    data: result as unknown as Record<string, unknown>,
  });

  console.log("[EveningPull] Complete —", result.summary);
  return result;
}

let lastScheduledEveningPullDate: string | null = null;

export function scheduleEveningPullDaily6pm(): void {
  const checkAndRun = () => {
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

    if (hour === 18 && minute >= 0 && minute < 2 && lastScheduledEveningPullDate !== dateStr) {
      lastScheduledEveningPullDate = dateStr;
      runEveningPull().catch((err) => console.error("[EveningPull] scheduled run failed:", err));
    }
  };

  setInterval(checkAndRun, 60 * 1000);
  console.log("[EveningPull] Scheduled for 6:00 PM Central daily");
}
