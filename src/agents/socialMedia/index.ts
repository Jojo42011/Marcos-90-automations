/**
 * Social media refresh — TikTok via Zernio (replaces Apify).
 */
import { fetchZernioTikTokVideos } from "../../integrations/zernio/index.js";
import { scoreVideos, extractContentPatterns } from "../../core/socialScoring.js";
import {
  upsertSocialPull,
  upsertVideoScore,
  getLatestSocialDashboardData,
  getSocialRefreshTime,
  logAgentPull,
  type SocialDailySnapshot,
} from "../../core/socialStore.js";
import { currentZernioSecrets } from "../../core/zernioOwnerConfig.js";

export function getTikTokUsername(): string {
  return (process.env.TIKTOK_USERNAME?.trim() || "puga.realtor").replace(/^@/, "");
}

/** Pull TikTok via Zernio, score, persist snapshot + videos. */
export async function runSocialMediaAgent(): Promise<SocialDailySnapshot> {
  try {
    const secrets = currentZernioSecrets();
    if (!secrets.apiKey) {
      throw new Error(
        "ZERNIO_DM_API_KEY is not set for this account — cannot pull TikTok analytics.",
      );
    }

    const fetched = await fetchZernioTikTokVideos();
    if (!fetched.ok) {
      throw new Error(fetched.error || "Zernio TikTok pull failed");
    }

    const username = (fetched.username || getTikTokUsername()).replace(/^@/, "");
    const videos = fetched.videos.map((v) => ({
      id: v.id,
      url: v.url,
      caption: v.caption,
      coverUrl: v.coverUrl,
      postedAt: v.postedAt,
      views: v.views,
      likes: v.likes,
      comments: v.comments,
      shares: v.shares,
      saves: v.saves,
      accountHandle: username,
    }));
    const scored = scoreVideos(videos);
    const contentPatterns = extractContentPatterns(scored.videos);
    const pulledAt = new Date().toISOString();

    const profileInfo = {
      username,
      nickname: username,
      followers: fetched.followers || 0,
      following: 0,
      heartCount: scored.videos.reduce((s, v) => s + v.likes, 0),
      videoCount: scored.videos.length,
      avatar: "",
    };

    const snapshot = upsertSocialPull(
      profileInfo,
      scored.videos,
      contentPatterns,
      scored.avgViews,
      pulledAt,
    );

    for (const v of scored.videos) {
      upsertVideoScore(v.id, v.scoreBreakdown, pulledAt);
    }

    console.log(
      `[social-agent] Zernio pull complete — ${snapshot.totalVideos} videos, avg ${snapshot.avgViews} views`,
    );

    const data = getLatestSocialDashboardData();
    logAgentPull({
      pulledAt: new Date().toISOString(),
      pullType: "social_refresh",
      status: "success",
      summary: `Pulled ${data.videos?.length || 0} videos, ${data.profile?.followers || 0} followers from @${data.profile?.username || "unknown"} via Zernio`,
      details: {
        videoCount: data.videos?.length || 0,
        followers: data.profile?.followers || 0,
        source: "zernio",
        owner: secrets.ownerSlug,
      },
    });

    return snapshot;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[social-agent] Zernio pull failed:", message);
    logAgentPull({
      pulledAt: new Date().toISOString(),
      pullType: "social_refresh",
      status: "error",
      summary: `Failed: ${message}`,
      details: { source: "zernio" },
    });
    throw err;
  }
}

let lastScheduledSocialDate: string | null = null;

/** Run runSocialMediaAgent once per day at custom time or 6:00 PM America/Chicago. */
export function scheduleSocialMediaAgentDaily6pmCST(): void {
  const customTime = getSocialRefreshTime();
  if (customTime) {
    console.log(`[social] daily pull scheduled at ${customTime} America/Chicago`);
  } else {
    console.log("[social] daily pull scheduled at 6:00 PM America/Chicago");
  }

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

    const scheduledTime = getSocialRefreshTime();
    let shouldRun = false;

    if (scheduledTime) {
      const [customHour, customMinute] = scheduledTime.split(":").map(Number);
      if (
        hour === customHour &&
        minute >= customMinute &&
        minute < customMinute + 2 &&
        lastScheduledSocialDate !== dateStr
      ) {
        shouldRun = true;
      }
    } else if (hour === 18 && minute >= 0 && minute < 2 && lastScheduledSocialDate !== dateStr) {
      shouldRun = true;
    }

    if (!shouldRun) return;

    lastScheduledSocialDate = dateStr;
    runSocialMediaAgent()
      .then((s) => {
        console.log(
          `[social] scheduled pull: ${s.totalVideos} video(s), avg ${s.avgViews} views`,
        );
      })
      .catch((err) => console.error("[social] scheduled pull failed:", err));
  }, 60_000);
}
