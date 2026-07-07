import {
  getContentVideo,
  incrementDailyTarget,
  insertPublishLog,
  todayDateCst,
  updateContentVideo,
  type ContentPublishLog,
} from "../../core/contentDb.js";
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

  // One publish-log row per platform — the honest per-platform record. The log
  // status mirrors the REAL confirmed state (success/failed) or "scheduled" for a
  // queued post; a still-unconfirmed platform is recorded as "scheduled" (a
  // pending, non-terminal marker) rather than a false "success".
  const logStatusFor = (r: (typeof results)[number]): "success" | "failed" | "scheduled" => {
    if (r.state === "success") return "success";
    if (r.state === "failed") return "failed";
    return "scheduled"; // pending / queued — not confirmed
  };
  const logs: ContentPublishLog[] = results.map((r) =>
    insertPublishLog({
      videoId,
      platform: r.platform,
      platformPostId: r.postId || r.url || null, // real post_url once confirmed
      publishedAt: now,
      publishStatus: logStatusFor(r),
      errorMessage: r.error,
    }),
  );

  const anyConfirmed = results.some((r) => r.state === "success");
  const anyPending = results.some((r) => r.state === "pending");

  if (scheduledFor) {
    // Accepted for later — honest "scheduled", file kept.
    updateContentVideo(videoId, { status: "scheduled", scheduledFor });
  } else if (anyConfirmed) {
    // At least one platform is GENUINELY confirmed live. Mark published; count it
    // once. Do NOT delete the clip file here — the scheduled safety cleanup
    // reclaims genuinely-published clips after a grace period, which keeps the
    // Calendar preview working in the meantime.
    updateContentVideo(videoId, { status: "published", publishedAt: now });
    incrementDailyTarget(todayDateCst(), "videos_published");
  } else if (anyPending) {
    // Accepted but not yet confirmed by any platform — honest interim status, NOT
    // "published". A later status check / re-publish resolves it. File kept.
    updateContentVideo(videoId, { status: "submitted" });
  }
  // else: every platform confirmed FAILED — leave the clip approved so it can be
  // retried; the failed publish-log rows carry the real reasons.

  const summary = results.map((r) => `${r.platform}:${r.state}`).join(" ");
  console.log(
    `[content-manager/publish] video ${videoId} → upload-post [${plats.join(",")}]` +
      `${scheduledFor ? " (scheduled)" : ""} ${summary}`,
  );

  return { results, logs };
}
