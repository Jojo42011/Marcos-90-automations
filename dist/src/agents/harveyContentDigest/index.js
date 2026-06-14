"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateContentDigest = generateContentDigest;
exports.getLatestContentDigest = getLatestContentDigest;
exports.scheduleContentDigestEvery3Days = scheduleContentDigestEvery3Days;
const socialStore_js_1 = require("../../core/socialStore.js");
const index_js_1 = require("../contentSuggestions/index.js");
const index_js_2 = require("../escalations/index.js");
function videoCaption(v) {
    return (v.caption || "").trim();
}
function videoScore(v) {
    return v.scoreBreakdown?.score ?? v.score ?? 0;
}
function generateContentDigest() {
    console.log("[HarveyDigest] Generating content digest for Harvey...");
    const data = (0, socialStore_js_1.getLatestSocialDashboardData)();
    const videos = data.videos || [];
    const avgViews = data.summary?.avgViews || 0;
    const totalViews = videos.reduce((sum, v) => sum + (v.views || 0), 0);
    const followers = data.profile?.followers || 0;
    const sorted = [...videos].sort((a, b) => videoScore(b) - videoScore(a));
    const topVideo = sorted.length > 0
        ? {
            description: videoCaption(sorted[0]).substring(0, 80),
            score: videoScore(sorted[0]),
            views: sorted[0].views || 0,
        }
        : null;
    const underperformersCount = videos.filter((v) => videoScore(v) < 40).length;
    const escalations = (0, index_js_2.getRecentEscalations)(50);
    const last3Days = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const pendingEscalations = escalations.filter((e) => new Date(e.detectedAt).getTime() >= last3Days).length;
    const suggestions = (0, index_js_1.getLatestContentSuggestions)();
    const latestSuggestions = (suggestions?.suggestions || []).map((s) => s.title);
    const summary = `Content update: ${followers.toLocaleString()} followers, ` +
        `avg ${avgViews.toLocaleString()} views/video across ${videos.length} videos tracked. ` +
        (topVideo
            ? `Top performer: "${topVideo.description}" scored ${topVideo.score}/100 with ${topVideo.views.toLocaleString()} views. `
            : "") +
        `${underperformersCount} videos underperforming. ` +
        `${pendingEscalations} escalations in the last 3 days. ` +
        (latestSuggestions.length > 0
            ? `Latest content ideas: ${latestSuggestions.join("; ")}.`
            : "");
    const digest = {
        generatedAt: new Date().toISOString(),
        summary,
        data: {
            avgViewsPerVideo: avgViews,
            totalViews,
            followers,
            topVideo,
            underperformersCount,
            pendingEscalations,
            latestSuggestions,
        },
    };
    saveContentDigest(digest);
    console.log("[HarveyDigest] Generated:", summary);
    (0, socialStore_js_1.logAgentPull)({
        pulledAt: digest.generatedAt,
        pullType: "content_digest",
        status: "success",
        summary: digest.summary,
        details: digest.data,
    });
    return digest;
}
function saveContentDigest(digest) {
    const db = (0, socialStore_js_1.getSocialDb)();
    db.exec(`
    CREATE TABLE IF NOT EXISTS harvey_content_digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generated_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      data TEXT NOT NULL
    )
  `);
    db.prepare(`INSERT INTO harvey_content_digests (generated_at, summary, data)
     VALUES (?, ?, ?)`).run(digest.generatedAt, digest.summary, JSON.stringify(digest.data));
}
function getLatestContentDigest() {
    const db = (0, socialStore_js_1.getSocialDb)();
    try {
        const row = db
            .prepare(`SELECT * FROM harvey_content_digests ORDER BY generated_at DESC LIMIT 1`)
            .get();
        if (!row)
            return null;
        return {
            id: row.id != null ? Number(row.id) : undefined,
            generatedAt: String(row.generated_at),
            summary: String(row.summary),
            data: JSON.parse(String(row.data)),
        };
    }
    catch {
        return null;
    }
}
function scheduleContentDigestEvery3Days() {
    const checkAndRun = () => {
        const last = getLatestContentDigest();
        const now = Date.now();
        if (!last) {
            generateContentDigest();
            return;
        }
        const lastTime = new Date(last.generatedAt).getTime();
        const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
        if (now - lastTime >= threeDaysMs) {
            generateContentDigest();
        }
    };
    setInterval(checkAndRun, 60 * 60 * 1000);
    checkAndRun();
    console.log("[HarveyDigest] Scheduled — checks hourly, fires every 3 days");
}
