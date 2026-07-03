import {
  fetchTikTokVideos,
  scoreVideos,
  extractContentPatterns,
} from "../../integrations/apify/index.js";
import {
  upsertSocialPull,
  upsertVideoScore,
  getSocialRefreshTime,
  getLatestSocialDashboardData,
  logAgentPull,
  type SocialDailySnapshot,
} from "../../core/socialStore.js";

export function getTikTokUsername(): string {
  return (process.env.TIKTOK_USERNAME?.trim() || "puga.realtor").replace(/^@/, "");
}

function apifyToken(): string {
  return (
    process.env.APIFY_API_TOKEN?.trim() ||
    process.env.APIFY_API_KEY?.trim() ||
    ""
  );
}

/** Pull TikTok via Apify, score, extract patterns, persist snapshot + videos.
 *  Real data only — if APIFY_API_TOKEN is missing we fail loudly rather than
 *  fabricate mock data (the dashboard shows an honest empty state instead). */
export async function runSocialMediaAgent(): Promise<SocialDailySnapshot> {
  const startTime = Date.now();
  try {
    const token = apifyToken();
    if (!token) {
      throw new Error(
        "APIFY_API_TOKEN not set — cannot pull real TikTok data. Set it in the environment; no mock data is used.",
      );
    }

    const username = getTikTokUsername();
    const { profile, videos } = await fetchTikTokVideos(username);
    const scored = scoreVideos(videos);
    const contentPatterns = extractContentPatterns(scored.videos);
    const pulledAt = new Date().toISOString();

    const profileInfo = profile ?? {
      username,
      nickname: username,
      followers: 0,
      following: 0,
      heartCount: 0,
      videoCount: 0,
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
      `[social-agent] Pull complete — ${snapshot.totalVideos} videos, avg ${snapshot.avgViews} views, ${snapshot.hotCount} hot / ${snapshot.averageCount} warm / ${snapshot.coldCount} cold`,
    );

    const data = getLatestSocialDashboardData();
    logAgentPull({
      pulledAt: new Date().toISOString(),
      pullType: "social_refresh",
      status: "success",
      summary: `Pulled ${data.videos?.length || 0} videos, ${data.profile?.followers || 0} followers from @${data.profile?.username || "unknown"}`,
      details: {
        videoCount: data.videos?.length || 0,
        followers: data.profile?.followers || 0,
      },
      durationMs: Date.now() - startTime,
    });

    return snapshot;
  } catch (err) {
    logAgentPull({
      pulledAt: new Date().toISOString(),
      pullType: "social_refresh",
      status: "error",
      summary: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - startTime,
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
