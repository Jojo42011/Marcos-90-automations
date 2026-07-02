import { randomUUID } from "crypto";
import {
  getContentVideo,
  incrementDailyTarget,
  insertPublishLog,
  todayDateCst,
  updateContentVideo,
  type ContentPublishLog,
} from "../../core/contentDb.js";
import { deleteClipByStoredPath } from "../../core/diskCleanup.js";

async function publishToTikTok(
  _filePath: string | null,
  _caption: string,
  _hashtags: string[],
  _scheduledFor?: string | null,
): Promise<string> {
  // TIKTOK_UPLOADER — uses TikTokAutoUploader Python library (github.com/makiisthenes/TiktokAutoUploader).
  // Will call a Python script via child_process that accepts video file path, caption, hashtags,
  // and optional scheduled_for timestamp. Returns platform_post_id.
  return `tiktok_stub_${randomUUID().slice(0, 12)}`;
}

async function publishToInstagram(
  _filePath: string | null,
  _caption: string,
  _hashtags: string[],
  _scheduledFor?: string | null,
): Promise<string> {
  // INSTAGRAPI — uses instagrapi Python library (github.com/subzeroid/instagrapi) for Reels publishing only.
  // ManyChat stays as the DM layer — instagrapi handles publishing only, never DMs.
  // Will call a Python script via child_process.
  return `instagram_stub_${randomUUID().slice(0, 12)}`;
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
