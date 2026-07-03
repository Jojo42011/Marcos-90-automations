"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishVideo = publishVideo;
const contentDb_js_1 = require("../../core/contentDb.js");
const diskCleanup_js_1 = require("../../core/diskCleanup.js");
async function publishToTikTok(_filePath, _caption, _hashtags, _scheduledFor) {
    // NOT IMPLEMENTED YET. This must call a real TikTok posting integration
    // (planned: TikTokAutoUploader via child_process) with valid credentials.
    // Until that exists it throws — it must NEVER return a fake id, because the
    // caller would then mark the video "published" and delete the clip file for
    // a post that never happened. The dashboard's Publish Now button is disabled
    // for TikTok until this is real (see PUBLISH_CONNECTED in social.html).
    throw new Error("TikTok publishing is not connected yet — no posting integration or credentials are configured.");
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
