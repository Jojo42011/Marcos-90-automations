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
/** Pull TikTok via Apify, score, extract patterns, persist snapshot + videos.
 *  Real data only — if APIFY_API_TOKEN is missing we fail loudly rather than
 *  fabricate mock data (the dashboard shows an honest empty state instead). */
async function runSocialMediaAgent() {
    const startTime = Date.now();
    try {
        const token = apifyToken();
        if (!token) {
            throw new Error("APIFY_API_TOKEN not set — cannot pull real TikTok data. Set it in the environment; no mock data is used.");
        }
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
        const snapshot = (0, socialStore_js_1.upsertSocialPull)(profileInfo, scored.videos, contentPatterns, scored.avgViews, pulledAt);
        for (const v of scored.videos) {
            (0, socialStore_js_1.upsertVideoScore)(v.id, v.scoreBreakdown, pulledAt);
        }
        console.log(`[social-agent] Pull complete — ${snapshot.totalVideos} videos, avg ${snapshot.avgViews} views, ${snapshot.hotCount} hot / ${snapshot.averageCount} warm / ${snapshot.coldCount} cold`);
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
