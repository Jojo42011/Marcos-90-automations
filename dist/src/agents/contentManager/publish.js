"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishVideo = publishVideo;
const contentDb_js_1 = require("../../core/contentDb.js");
const diskCleanup_js_1 = require("../../core/diskCleanup.js");
const tiktokPublish_js_1 = require("./tiktokPublish.js");
async function publishToTikTok(filePath, caption, _hashtags, _scheduledFor) {
    // Real TikTok Content Posting API (official). Unaudited apps post SELF_ONLY
    // (private) — see tiktokPublish.ts. Throws with the real TikTok error on
    // failure; never returns a fake id.
    if (!(0, tiktokPublish_js_1.tiktokConfigured)()) {
        throw new Error("TikTok publishing is not connected — set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_REFRESH_TOKEN.");
    }
    if (!filePath) {
        throw new Error("TikTok publishing: this clip has no video file on disk to upload.");
    }
    const { publishId } = await (0, tiktokPublish_js_1.postVideoToTikTok)(filePath, caption);
    return publishId;
}
async function publishToInstagram(_filePath, _caption, _hashtags, _scheduledFor) {
    // NOT IMPLEMENTED YET. Planned: instagrapi (Reels publishing only) via
    // child_process with valid credentials. Throws until real — never returns a
    // fake id (see the publishToTikTok note above for why).
    throw new Error("Instagram publishing is not connected yet — no posting integration or credentials are configured.");
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
