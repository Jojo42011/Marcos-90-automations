import { runSocialMediaAgent, getTikTokUsername } from "../agents/socialMedia/index.js";
import {
  getLatestSocialDashboardData,
  getSocialSummaryForHarvey,
  type SocialDashboardData,
} from "../core/socialStore.js";

export function getTikTokUsernameFromEnv(): string {
  return getTikTokUsername();
}

/** Fetch from Apify, score, persist, return dashboard payload. */
export async function refreshSocialTikTokData(): Promise<SocialDashboardData> {
  console.log(`[social] Apify pull starting for @${getTikTokUsername()}`);
  await runSocialMediaAgent();
  return getLatestSocialDashboardData();
}

export function getSocialTikTokData(): SocialDashboardData & Record<string, unknown> {
  const data = getLatestSocialDashboardData();
  const summary = getSocialSummaryForHarvey();
  return {
    ...data,
    pulledAt: data.lastUpdated,
    stats: summary.stats,
    wow_avg_views_change_pct: summary.wow_avg_views_change_pct,
    days_since_last_pull: summary.days_since_last_pull,
    contentPatterns: summary.contentPatterns ?? data.snapshot?.contentPatterns,
    humanSummary: summary.humanSummary,
  };
}
