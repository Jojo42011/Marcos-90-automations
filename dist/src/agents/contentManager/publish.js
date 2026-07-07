"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishVideo = publishVideo;
const contentDb_js_1 = require("../../core/contentDb.js");
const diskCleanup_js_1 = require("../../core/diskCleanup.js");
const tiktokPublish_js_1 = require("./tiktokPublish.js");
const metaPublish_js_1 = require("./metaPublish.js");
async function sendToTikTokDrafts(filePath, caption, _hashtags, _scheduledFor) {
    // This app has the `video.upload` scope only, which uploads the clip to the
    // creator's TikTok DRAFTS/inbox — it does NOT post publicly. Marco opens the
    // TikTok app to add the caption and post. Throws with the real TikTok error
    // on failure; never returns a fake id.
    if (!(0, tiktokPublish_js_1.tiktokConfigured)()) {
        throw new Error("TikTok is not connected — set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_REFRESH_TOKEN.");
    }
    if (!filePath) {
        throw new Error("TikTok draft upload: this clip has no video file on disk to upload.");
    }
    const { publishId } = await (0, tiktokPublish_js_1.uploadToDrafts)(filePath, caption);
    return publishId;
}
async function publishToInstagram(videoId, caption) {
    // Real Instagram Graph API (Reels): container -> poll -> media_publish. Meta
    // fetches the video from a short-lived signed public URL. Throws with the
    // real Graph error on failure; never returns a fake id.
    if (!(0, metaPublish_js_1.instagramConfigured)()) {
        throw new Error("Instagram publishing is not connected — set INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_BUSINESS_ACCOUNT_ID and PUBLIC_BASE_URL.");
    }
    const { mediaId } = await (0, metaPublish_js_1.postReelToInstagram)((0, metaPublish_js_1.buildSignedClipUrl)(videoId), caption);
    return mediaId;
}
async function publishToFacebook(videoId, caption) {
    // Real Facebook Graph API Page video post. Meta fetches from a signed public URL.
    if (!(0, metaPublish_js_1.facebookConfigured)()) {
        throw new Error("Facebook publishing is not connected — set FACEBOOK_PAGE_ACCESS_TOKEN, FACEBOOK_PAGE_ID and PUBLIC_BASE_URL.");
    }
    const { videoId: fbVideoId } = await (0, metaPublish_js_1.postVideoToFacebookPage)((0, metaPublish_js_1.buildSignedClipUrl)(videoId), caption);
    return fbVideoId;
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
    // TikTok only uploads to DRAFTS (video.upload scope) — it is not a live post,
    // so it must not be recorded as "published", must not count toward the
    // published target, and the clip file is kept (Marco still has to post it).
    const isTikTokDraft = plat === "tiktok";
    try {
        let platformPostId;
        if (plat === "tiktok") {
            platformPostId = await sendToTikTokDrafts(video.filePath, fullCaption, video.hashtags, scheduledFor);
        }
        else if (plat === "instagram") {
            platformPostId = await publishToInstagram(videoId, fullCaption);
        }
        else if (plat === "facebook") {
            platformPostId = await publishToFacebook(videoId, fullCaption);
        }
        else {
            throw new Error(`Unsupported platform: ${platform}. Supported: tiktok, instagram, facebook`);
        }
        const log = (0, contentDb_js_1.insertPublishLog)({
            videoId,
            platform: plat,
            platformPostId,
            publishedAt: now,
            publishStatus: isTikTokDraft ? "sent_to_drafts" : "success",
            errorMessage: null,
        });
        if (isTikTokDraft) {
            // Sent to TikTok drafts — NOT live. Reflect that honestly; do not set
            // publishedAt, do not count it as published, and keep the clip file so
            // Marco can re-send if the draft never gets posted.
            (0, contentDb_js_1.updateContentVideo)(videoId, { status: "sent_to_drafts" });
            console.log(`[content-manager/publish] video ${videoId} → tiktok DRAFT ${platformPostId} (inbox — not live)`);
        }
        else {
            (0, contentDb_js_1.updateContentVideo)(videoId, {
                status: "published",
                publishedAt: now,
            });
            (0, contentDb_js_1.incrementDailyTarget)((0, contentDb_js_1.todayDateCst)(), "videos_published");
            console.log(`[content-manager/publish] video ${videoId} → ${plat} post ${platformPostId}`);
            // The clip file is no longer needed once it has actually posted publicly.
            (0, diskCleanup_js_1.deleteClipByStoredPath)(video.filePath);
        }
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
