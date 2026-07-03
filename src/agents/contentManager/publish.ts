import {
  getContentVideo,
  incrementDailyTarget,
  insertPublishLog,
  todayDateCst,
  updateContentVideo,
  type ContentPublishLog,
} from "../../core/contentDb.js";
import { deleteClipByStoredPath } from "../../core/diskCleanup.js";
import { postVideoToTikTok, tiktokConfigured } from "./tiktokPublish.js";

async function publishToTikTok(
  filePath: string | null,
  caption: string,
  _hashtags: string[],
  _scheduledFor?: string | null,
): Promise<string> {
  // Real TikTok Content Posting API (official). Unaudited apps post SELF_ONLY
  // (private) — see tiktokPublish.ts. Throws with the real TikTok error on
  // failure; never returns a fake id.
  if (!tiktokConfigured()) {
    throw new Error(
      "TikTok publishing is not connected — set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_REFRESH_TOKEN.",
    );
  }
  if (!filePath) {
    throw new Error("TikTok publishing: this clip has no video file on disk to upload.");
  }
  const { publishId } = await postVideoToTikTok(filePath, caption);
  return publishId;
}

async function publishToInstagram(
  _filePath: string | null,
  _caption: string,
  _hashtags: string[],
  _scheduledFor?: string | null,
): Promise<string> {
  // NOT IMPLEMENTED YET. Planned: instagrapi (Reels publishing only) via
  // child_process with valid credentials. Throws until real — never returns a
  // fake id (see the publishToTikTok note above for why).
  throw new Error(
    "Instagram publishing is not connected yet — no posting integration or credentials are configured.",
  );
}

export async function publishVideo(
  videoId: string,
  platform: string,
  options?: { scheduledFor?: string | null },
): Promise<ContentPublishLog> {
  const video = getContentVideo(videoId);
  if (!video) {
    throw new Error(`Video not found: ${videoId}`);
  }
  if (video.status !== "approved" && video.status !== "scheduled") {
    throw new Error(`Video ${videoId} is not approved (status: ${video.status})`);
  }
  if (video.complianceFlagged) {
    throw new Error(`Video ${videoId} is compliance-flagged and cannot be published`);
  }

  const plat = platform.toLowerCase();
  const fullCaption = `${video.caption}\n\n${video.hashtags.join(" ")}`.trim();
  const now = new Date().toISOString();
  const scheduledFor = options?.scheduledFor ?? video.scheduledFor;

  try {
    let platformPostId: string;
    if (plat === "tiktok") {
      platformPostId = await publishToTikTok(
        video.filePath,
        fullCaption,
        video.hashtags,
        scheduledFor,
      );
    } else if (plat === "instagram") {
      platformPostId = await publishToInstagram(
        video.filePath,
        fullCaption,
        video.hashtags,
        scheduledFor,
      );
    } else {
      throw new Error(`Unsupported platform: ${platform}. Supported: tiktok, instagram`);
    }

    const log = insertPublishLog({
      videoId,
      platform: plat,
      platformPostId,
      publishedAt: now,
      publishStatus: "success",
      errorMessage: null,
    });

    updateContentVideo(videoId, {
      status: "published",
      publishedAt: now,
    });

    incrementDailyTarget(todayDateCst(), "videos_published");
    console.log(`[content-manager/publish] video ${videoId} → ${plat} post ${platformPostId}`);
    // Fix 2 — the clip file is no longer needed once it has actually posted.
    deleteClipByStoredPath(video.filePath);
    return log;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const log = insertPublishLog({
      videoId,
      platform: plat,
      platformPostId: null,
      publishedAt: now,
      publishStatus: "failed",
      errorMessage: message,
    });
    console.error(`[content-manager/publish] failed video ${videoId}:`, message);
    return log;
  }
}
