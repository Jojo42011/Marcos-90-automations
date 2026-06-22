"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPerformanceSync = runPerformanceSync;
exports.getDailyReport = getDailyReport;
exports.getWeeklyReport = getWeeklyReport;
const index_js_1 = require("../../integrations/apify/index.js");
const index_js_2 = require("../socialMedia/index.js");
const contentDb_js_1 = require("../../core/contentDb.js");
const PULL_STALE_MS = 24 * 60 * 60 * 1000;
function apifyToken() {
    return (process.env.APIFY_API_TOKEN?.trim() ||
        process.env.APIFY_API_KEY?.trim() ||
        "");
}
async function fetchPostStats(platform, platformPostId) {
    if (platform !== "tiktok" || !apifyToken())
        return null;
    try {
        const username = (0, index_js_2.getTikTokUsername)();
        const { videos } = await (0, index_js_1.fetchTikTokVideos)(username);
        const match = videos.find((v) => v.id === platformPostId);
        if (!match)
            return null;
        return {
            views: match.views,
            likes: match.likes,
            comments: match.comments,
            shares: match.shares,
            saves: match.saves,
        };
    }
    catch (err) {
        console.warn("[content-manager/analytics] Apify fetch failed:", err);
        return null;
    }
}
function isPullStale(latest) {
    if (!latest)
        return true;
    const age = Date.now() - new Date(latest.pulledAt).getTime();
    return age >= PULL_STALE_MS;
}
async function runPerformanceSync() {
    const logs = (0, contentDb_js_1.listSuccessfulPublishLogs)();
    const summary = {
        videosChecked: 0,
        hotCount: 0,
        averageCount: 0,
        coldCount: 0,
        benchmarkMetCount: 0,
        belowBenchmarkCount: 0,
    };
    for (const log of logs) {
        const latest = (0, contentDb_js_1.getLatestPerformance)(log.videoId);
        if (!isPullStale(latest))
            continue;
        summary.videosChecked++;
        let stats = await fetchPostStats(log.platform, log.platformPostId ?? "");
        if (!stats) {
            stats = {
                views: latest?.views ?? 0,
                likes: latest?.likes ?? 0,
                comments: latest?.comments ?? 0,
                shares: latest?.shares ?? 0,
                saves: latest?.saves ?? 0,
            };
        }
        const scored = (0, contentDb_js_1.computePerformanceScore)(stats);
        (0, contentDb_js_1.insertPerformance)({
            videoId: log.videoId,
            platformPostId: log.platformPostId,
            platform: log.platform,
            views: stats.views,
            likes: stats.likes,
            comments: stats.comments,
            shares: stats.shares,
            saves: stats.saves,
            dmsGenerated: 0,
            phoneNumbersCaptured: 0,
            score: scored.score,
            tier: scored.tier,
            benchmarkMet: scored.benchmarkMet,
            pulledAt: new Date().toISOString(),
        });
        if (scored.tier === "hot")
            summary.hotCount++;
        else if (scored.tier === "average")
            summary.averageCount++;
        else
            summary.coldCount++;
        if (scored.benchmarkMet)
            summary.benchmarkMetCount++;
        else
            summary.belowBenchmarkCount++;
    }
    const today = (0, contentDb_js_1.todayDateCst)();
    (0, contentDb_js_1.setDailyPhoneCaptureCount)(today, (0, contentDb_js_1.countLeadCapturesForDate)(today));
    (0, contentDb_js_1.ensureDailyTargets)(today);
    console.log(`[content-manager/analytics] sync complete — checked ${summary.videosChecked}, hot=${summary.hotCount} avg=${summary.averageCount} cold=${summary.coldCount}`);
    return summary;
}
function getDailyReport(date) {
    const targetDate = date ?? (0, contentDb_js_1.todayDateCst)();
    const targets = (0, contentDb_js_1.getDailyTargets)(targetDate);
    const performances = (0, contentDb_js_1.listPerformanceForDate)(targetDate);
    const sorted = [...performances].sort((a, b) => b.score - a.score);
    const top3 = sorted.slice(0, 3);
    const bottom3 = [...sorted].reverse().slice(0, 3);
    return {
        date: targetDate,
        targets,
        topVideos: top3,
        bottomVideos: bottom3,
        performanceCount: performances.length,
    };
}
function getWeeklyReport() {
    const days = (0, contentDb_js_1.listDailyTargetsLastDays)(7);
    const totalVideosPublished = days.reduce((s, d) => s + d.videosPublished, 0);
    const totalPhoneNumbers = days.reduce((s, d) => s + d.phoneNumbersCaptured, 0);
    const weeklyVideoTarget = 49;
    const weeklyPhoneTarget = 154;
    const allPerformances = [];
    for (const day of days) {
        allPerformances.push(...(0, contentDb_js_1.listPerformanceForDate)(day.date));
    }
    const avgViews = allPerformances.length > 0
        ? Math.round(allPerformances.reduce((s, p) => s + p.views, 0) / allPerformances.length)
        : 0;
    return {
        days,
        totalVideosPublished,
        weeklyVideoTarget,
        videosOnTrack: totalVideosPublished >= weeklyVideoTarget,
        totalPhoneNumbersCaptured: totalPhoneNumbers,
        weeklyPhoneTarget,
        phonesOnTrack: totalPhoneNumbers >= weeklyPhoneTarget,
        avgViews,
        consistentlyBelowBenchmark: (0, contentDb_js_1.listConsistentlyBelowBenchmarkVideos)(),
    };
}
