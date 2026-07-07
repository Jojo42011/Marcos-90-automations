import {
  getContentVideo,
  incrementDailyTarget,
  insertPublishLog,
  todayDateCst,
  updateContentVideo,
  type ContentPublishLog,
} from "../../core/contentDb.js";
import { deleteClipByStoredPath } from "../../core/diskCleanup.js";
import { publishToSocials, uploadPostConfigured, type SocialPublishResult } from "./uploadPostPublish.js";

export interface PublishOutcome {
  results: SocialPublishResult[];
  logs: ContentPublishLog[];
}

/**
 * Publish (or schedule) one clip to the selected platforms via Upload-Post — a
 * single call fans out to whichever of tiktok/instagram/facebook are chosen.
 * Records a per-platform publish log and reflects honest per-platform outcomes:
 * a partial failure is never treated as a full success.
 */
export async function publishVideo(
  videoId: string,
  platforms: string[],
  options?: { scheduledFor?: string | null },
): Promise<PublishOutcome> {
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
  if (!uploadPostConfigured()) {
    throw new Error("Publishing is not connected — set UPLOAD_POST_API_KEY (Upload-Post).");
  }
  if (!video.filePath) {
    throw new Error("This clip has no video file on disk to upload.");
  }
  const plats = platforms.map((p) => p.toLowerCase().trim()).filter(Boolean);
  if (!plats.length) {
    throw new Error("No platforms selected.");
  }

  const scheduledFor = options?.scheduledFor || null;
  const now = new Date().toISOString();

  const { results } = await publishToSocials({
    videoPath: video.filePath,
    title: video.hook || "",
    caption: video.caption || "",
    hashtags: video.hashtags || [],
    platforms: plats,
    scheduledDate: scheduledFor,
  });

  // One publish-log row per platform — the honest per-platform record.
  const logs: ContentPublishLog[] = results.map((r) =>
    insertPublishLog({
      videoId,
      platform: r.platform,
      platformPostId: r.postId || r.url || null,
      publishedAt: now,
      publishStatus: r.success ? (scheduledFor ? "scheduled" : "success") : "failed",
      errorMessage: r.error,
    }),
  );

  const anySuccess = results.some((r) => r.success);
  const allSuccess = results.length > 0 && results.every((r) => r.success);

  if (scheduledFor) {
    if (anySuccess) updateContentVideo(videoId, { status: "scheduled", scheduledFor });
  } else if (anySuccess) {
    // At least one platform genuinely posted — mark the clip published.
    updateContentVideo(videoId, { status: "published", publishedAt: now });
    incrementDailyTarget(todayDateCst(), "videos_published");
    // Only discard the local clip once EVERY targeted platform posted, so a
    // partial failure can still be retried.
    if (allSuccess) deleteClipByStoredPath(video.filePath);
  }

  const okList = results.filter((r) => r.success).map((r) => r.platform).join(", ") || "none";
  console.log(
    `[content-manager/publish] video ${videoId} → upload-post [${plats.join(",")}]` +
      `${scheduledFor ? " (scheduled)" : ""} ok=[${okList}]`,
  );

  return { results, logs };
}
