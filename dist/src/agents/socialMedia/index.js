"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTikTokUsername = getTikTokUsername;
exports.runSocialMediaAgent = runSocialMediaAgent;
exports.scheduleSocialMediaAgentDaily6pmCST = scheduleSocialMediaAgentDaily6pmCST;
const index_js_1 = require("../../integrations/apify/index.js");
const socialStore_js_1 = require("../../core/socialStore.js");
function getTikTokUsername() {
    return (process.env.TIKTOK_USERNAME?.trim() || "puga.realtor").replace(/^@/, "");
}
function apifyToken() {
    return (process.env.APIFY_API_TOKEN?.trim() ||
        process.env.APIFY_API_KEY?.trim() ||
        "");
}
function seedMockSocialData() {
    const username = getTikTokUsername();
    const pulledAt = new Date().toISOString();
    const profile = {
        username,
        nickname: username,
        followers: 12400,
        following: 892,
        heartCount: 45000,
        videoCount: 124,
        avatar: "",
    };
    const mockBase = [
        {
            id: "mock_1",
            url: `https://www.tiktok.com/@${username}/video/mock_1`,
            caption: "Stone Oak new construction tour — $450k 4/3",
            coverUrl: "",
            postedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            views: 45200,
            likes: 1240,
            comments: 89,
            shares: 234,
            saves: 56,
        },
        {
            id: "mock_2",
            url: `https://www.tiktok.com/@${username}/video/mock_2`,
            caption: "Why San Antonio real estate is booming right now",
            coverUrl: "",
            postedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
            views: 28100,
            likes: 890,
            comments: 67,
            shares: 145,
            saves: 32,
        },
        {
            id: "mock_3",
            url: `https://www.tiktok.com/@${username}/video/mock_3`,
            caption: "Canyon Lake waterfront — how much does it cost?",
            coverUrl: "",
            postedAt: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString(),
            views: 8900,
            likes: 210,
            comments: 34,
            shares: 28,
            saves: 11,
        },
    ];
    const scoredMock = (0, index_js_1.scoreVideos)(mockBase);
    const mockVideos = scoredMock.videos;
    const avgViews = Math.round(mockVideos.reduce((sum, v) => sum + v.views, 0) / mockVideos.length);
    const contentPatterns = {
        topHashtagsByAvgViews: [
            { hashtag: "realestate", avgViews: 38000, count: 12 },
            { hashtag: "sanantonio", avgViews: 32000, count: 18 },
            { hashtag: "newconstruction", avgViews: 45000, count: 8 },
        ],
        hotCaptionKeywords: ["tour", "construction", "Stone Oak"],
        bestPostingDay: "Tuesday",
        bestPostingHour: 18,
        contentTypeBreakdown: [
            { category: "tour", videoCount: 45, avgViews: 42000, avgEngagementRate: 0.034 },
            { category: "location", videoCount: 32, avgViews: 28000, avgEngagementRate: 0.031 },
            { category: "pricing", videoCount: 18, avgViews: 22000, avgEngagementRate: 0.029 },
        ],
    };
    const snapshot = (0, socialStore_js_1.upsertSocialPull)(profile, mockVideos, contentPatterns, avgViews, pulledAt);
    console.log("[SocialAgent] Mock social data seeded for @" + username);
    return snapshot;
}
/** Pull TikTok via Apify, score, extract patterns, persist snapshot + videos. */
async function runSocialMediaAgent() {
    const startTime = Date.now();
    try {
        const token = apifyToken();
        let snapshot;
        if (!token) {
            console.warn("[SocialAgent] APIFY_API_TOKEN not set — skipping real pull, seeding mock data");
            snapshot = seedMockSocialData();
        }
        else {
            const username = getTikTokUsername();
            const { profile, videos } = await (0, index_js_1.fetchTikTokVideos)(username);
            const scored = (0, index_js_1.scoreVideos)(videos);
            const contentPatterns = (0, index_js_1.extractContentPatterns)(scored.videos);
            const pulledAt = new Date().toISOString();
            const profileInfo = profile ?? {
                username,
                nickname: username,
                followers: 0,
                following: 0,
                heartCount: 0,
                videoCount: 0,
                avatar: "",
            };
            snapshot = (0, socialStore_js_1.upsertSocialPull)(profileInfo, scored.videos, contentPatterns, scored.avgViews, pulledAt);
            for (const v of scored.videos) {
                (0, socialStore_js_1.upsertVideoScore)(v.id, v.scoreBreakdown, pulledAt);
            }
            console.log(`[social-agent] Pull complete — ${snapshot.totalVideos} videos, avg ${snapshot.avgViews} views, ${snapshot.hotCount} hot / ${snapshot.averageCount} warm / ${snapshot.coldCount} cold`);
        }
        const data = (0, socialStore_js_1.getLatestSocialDashboardData)();
        (0, socialStore_js_1.logAgentPull)({
            pulledAt: new Date().toISOString(),
            pullType: "social_refresh",
            status: "success",
            summary: `Pulled ${data.videos?.length || 0} videos, ${data.profile?.followers || 0} followers from @${data.profile?.username || "unknown"}`,
            details: {
                videoCount: data.videos?.length || 0,
                followers: data.profile?.followers || 0,
            },
            durationMs: Date.now() - startTime,
        });
        return snapshot;
    }
    catch (err) {
        (0, socialStore_js_1.logAgentPull)({
            pulledAt: new Date().toISOString(),
            pullType: "social_refresh",
            status: "error",
            summary: `Failed: ${err instanceof Error ? err.message : String(err)}`,
            durationMs: Date.now() - startTime,
        });
        throw err;
    }
}
let lastScheduledSocialDate = null;
/** Run runSocialMediaAgent once per day at custom time or 6:00 PM America/Chicago. */
function scheduleSocialMediaAgentDaily6pmCST() {
    const customTime = (0, socialStore_js_1.getSocialRefreshTime)();
    if (customTime) {
        console.log(`[social] daily pull scheduled at ${customTime} America/Chicago`);
    }
    else {
        console.log("[social] daily pull scheduled at 6:00 PM America/Chicago");
    }
    setInterval(() => {
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
        const scheduledTime = (0, socialStore_js_1.getSocialRefreshTime)();
        let shouldRun = false;
        if (scheduledTime) {
            const [customHour, customMinute] = scheduledTime.split(":").map(Number);
            if (hour === customHour &&
                minute >= customMinute &&
                minute < customMinute + 2 &&
                lastScheduledSocialDate !== dateStr) {
                shouldRun = true;
            }
        }
        else if (hour === 18 && minute >= 0 && minute < 2 && lastScheduledSocialDate !== dateStr) {
            shouldRun = true;
        }
        if (!shouldRun)
            return;
        lastScheduledSocialDate = dateStr;
        runSocialMediaAgent()
            .then((s) => {
            console.log(`[social] scheduled pull: ${s.totalVideos} video(s), avg ${s.avgViews} views`);
        })
            .catch((err) => console.error("[social] scheduled pull failed:", err));
    }, 60_000);
}
