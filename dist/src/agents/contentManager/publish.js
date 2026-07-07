"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishVideo = publishVideo;
const contentDb_js_1 = require("../../core/contentDb.js");
const diskCleanup_js_1 = require("../../core/diskCleanup.js");
const uploadPostPublish_js_1 = require("./uploadPostPublish.js");
/**
 * Publish (or schedule) one clip to the selected platforms via Upload-Post — a
 * single call fans out to whichever of tiktok/instagram/facebook are chosen.
 * Records a per-platform publish log and reflects honest per-platform outcomes:
 * a partial failure is never treated as a full success.
 */
async function publishVideo(videoId, platforms, options) {
    const video = (0, contentDb_js_1.getContentVideo)(videoId);
    if (!video) {
        throw new Error(`Video not found: ${videoId}`);
    }
    if (video.status !== "approved" && video.status !== "scheduled") {
        throw new Error(`Video ${videoId} is not approved (status: ${video.status})`);
    }
    if (video.complianceFlagged) {
        throw new Error(`Video ${videoId} is compliance-flagged and cannot be published`);
    }
    if (!(0, uploadPostPublish_js_1.uploadPostConfigured)()) {
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
    const { results } = await (0, uploadPostPublish_js_1.publishToSocials)({
        videoPath: video.filePath,
        title: video.hook || "",
        caption: video.caption || "",
        hashtags: video.hashtags || [],
        platforms: plats,
        scheduledDate: scheduledFor,
    });
    // One publish-log row per platform — the honest per-platform record.
    const logs = results.map((r) => (0, contentDb_js_1.insertPublishLog)({
        videoId,
        platform: r.platform,
        platformPostId: r.postId || r.url || null,
        publishedAt: now,
        publishStatus: r.success ? (scheduledFor ? "scheduled" : "success") : "failed",
        errorMessage: r.error,
    }));
    const anySuccess = results.some((r) => r.success);
    const allSuccess = results.length > 0 && results.every((r) => r.success);
    if (scheduledFor) {
        if (anySuccess)
            (0, contentDb_js_1.updateContentVideo)(videoId, { status: "scheduled", scheduledFor });
    }
    else if (anySuccess) {
        // At least one platform genuinely posted — mark the clip published.
        (0, contentDb_js_1.updateContentVideo)(videoId, { status: "published", publishedAt: now });
        (0, contentDb_js_1.incrementDailyTarget)((0, contentDb_js_1.todayDateCst)(), "videos_published");
        // Only discard the local clip once EVERY targeted platform posted, so a
        // partial failure can still be retried.
        if (allSuccess)
            (0, diskCleanup_js_1.deleteClipByStoredPath)(video.filePath);
    }
    const okList = results.filter((r) => r.success).map((r) => r.platform).join(", ") || "none";
    console.log(`[content-manager/publish] video ${videoId} → upload-post [${plats.join(",")}]` +
        `${scheduledFor ? " (scheduled)" : ""} ok=[${okList}]`);
    return { results, logs };
}
