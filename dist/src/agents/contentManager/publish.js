"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishVideo = publishVideo;
const crypto_1 = require("crypto");
const contentDb_js_1 = require("../../core/contentDb.js");
const diskCleanup_js_1 = require("../../core/diskCleanup.js");
async function publishToTikTok(_filePath, _caption, _hashtags, _scheduledFor) {
    // TIKTOK_UPLOADER — uses TikTokAutoUploader Python library (github.com/makiisthenes/TiktokAutoUploader).
    // Will call a Python script via child_process that accepts video file path, caption, hashtags,
    // and optional scheduled_for timestamp. Returns platform_post_id.
    return `tiktok_stub_${(0, crypto_1.randomUUID)().slice(0, 12)}`;
}
async function publishToInstagram(_filePath, _caption, _hashtags, _scheduledFor) {
    // INSTAGRAPI — uses instagrapi Python library (github.com/subzeroid/instagrapi) for Reels publishing only.
    // ManyChat stays as the DM layer — instagrapi handles publishing only, never DMs.
    // Will call a Python script via child_process.
    return `instagram_stub_${(0, crypto_1.randomUUID)().slice(0, 12)}`;
}
async function publishVideo(videoId, platform, options) {
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
    const plat = platform.toLowerCase();
    const fullCaption = `${video.caption}\n\n${video.hashtags.join(" ")}`.trim();
    const now = new Date().toISOString();
    const scheduledFor = options?.scheduledFor ?? video.scheduledFor;
    try {
        let platformPostId;
        if (plat === "tiktok") {
            platformPostId = await publishToTikTok(video.filePath, fullCaption, video.hashtags, scheduledFor);
        }
        else if (plat === "instagram") {
            platformPostId = await publishToInstagram(video.filePath, fullCaption, video.hashtags, scheduledFor);
        }
        else {
            throw new Error(`Unsupported platform: ${platform}. Supported: tiktok, instagram`);
        }
        const log = (0, contentDb_js_1.insertPublishLog)({
            videoId,
            platform: plat,
            platformPostId,
            publishedAt: now,
            publishStatus: "success",
            errorMessage: null,
        });
        (0, contentDb_js_1.updateContentVideo)(videoId, {
            status: "published",
            publishedAt: now,
        });
        (0, contentDb_js_1.incrementDailyTarget)((0, contentDb_js_1.todayDateCst)(), "videos_published");
        console.log(`[content-manager/publish] video ${videoId} → ${plat} post ${platformPostId}`);
        // Fix 2 — the clip file is no longer needed once it has actually posted.
        (0, diskCleanup_js_1.deleteClipByStoredPath)(video.filePath);
        return log;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const log = (0, contentDb_js_1.insertPublishLog)({
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
