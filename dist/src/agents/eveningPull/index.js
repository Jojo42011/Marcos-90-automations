"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runEveningPull = runEveningPull;
exports.scheduleEveningPullDaily6pm = scheduleEveningPullDaily6pm;
const socialStore_js_1 = require("../../core/socialStore.js");
const index_js_1 = require("../socialMedia/index.js");
const index_js_2 = require("../reporting/index.js");
function videoCaption(v) {
    return (v.caption || "").trim();
}
function videoScore(v) {
    return v.scoreBreakdown?.score ?? v.score ?? 0;
}
async function runEveningPull() {
    const startTime = Date.now();
    console.log("[EveningPull] Starting evening performance pull...");
    try {
        try {
            await (0, index_js_1.runSocialMediaAgent)();
        }
        catch (err) {
            console.error("[EveningPull] Refresh failed, using existing data:", err);
        }
        const data = (0, socialStore_js_1.getLatestSocialDashboardData)();
        const videos = data.videos || [];
        const now = Date.now();
        const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
        const recentVideos = videos.filter((v) => {
            const postedAt = new Date(v.postedAt || 0).getTime();
            return postedAt >= sevenDaysAgo;
        });
        const sorted = [...recentVideos].sort((a, b) => videoScore(b) - videoScore(a));
        const topPerformer = sorted.length > 0
            ? {
                description: videoCaption(sorted[0]).substring(0, 80),
                score: videoScore(sorted[0]),
                views: sorted[0].views || 0,
            }
            : null;
        const underperformers = sorted
            .filter((v) => videoScore(v) < 40)
            .slice(0, 3)
            .map((v) => ({
            description: videoCaption(v).substring(0, 80),
            score: videoScore(v),
            views: v.views || 0,
        }));
        const avgScore = recentVideos.length > 0
            ? Math.round(recentVideos.reduce((sum, v) => sum + videoScore(v), 0) / recentVideos.length)
            : 0;
        const result = {
            generatedAt: new Date().toISOString(),
            videosScoredLast7Days: recentVideos.length,
            topPerformer,
            underperformers,
            avgScoreLast7Days: avgScore,
            summary: `${recentVideos.length} videos posted in last 7 days, avg score ${avgScore}/100. ` +
                (topPerformer
                    ? `Best performer: "${topPerformer.description}" scored ${topPerformer.score}/100 with ${topPerformer.views.toLocaleString()} views. `
                    : "") +
                (underperformers.length > 0
                    ? `${underperformers.length} videos underperformed (under 40/100).`
                    : "No underperforming videos this week."),
        };
        (0, index_js_2.saveReportingSnapshot)({
            type: "evening",
            generatedAt: result.generatedAt,
            summary: result.summary,
            data: result,
        });
        console.log("[EveningPull] Complete —", result.summary);
        (0, socialStore_js_1.logAgentPull)({
            pulledAt: result.generatedAt,
            pullType: "evening_pull",
            status: "success",
            summary: result.summary,
            details: {
                videosScored: result.videosScoredLast7Days,
                avgScore: result.avgScoreLast7Days,
                topPerformer: result.topPerformer?.description,
            },
            durationMs: Date.now() - startTime,
        });
        return result;
    }
    catch (err) {
        (0, socialStore_js_1.logAgentPull)({
            pulledAt: new Date().toISOString(),
            pullType: "evening_pull",
            status: "error",
            summary: `Failed: ${err instanceof Error ? err.message : String(err)}`,
            durationMs: Date.now() - startTime,
        });
        throw err;
    }
}
let lastScheduledEveningPullDate = null;
function scheduleEveningPullDaily6pm() {
    const checkAndRun = () => {
        const now = new Date();
        const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            hour: "numeric",
            minute: "numeric",
            hour12: false,
        }).formatToParts(now);
        const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
        const minute = Number(parts.find((p) => p.type === "minute")?.value ?? -1);
        if (hour === 18 && minute >= 0 && minute < 2 && lastScheduledEveningPullDate !== dateStr) {
            lastScheduledEveningPullDate = dateStr;
            runEveningPull().catch((err) => console.error("[EveningPull] scheduled run failed:", err));
        }
    };
    setInterval(checkAndRun, 60 * 1000);
    console.log("[EveningPull] Scheduled for 6:00 PM Central daily");
}
