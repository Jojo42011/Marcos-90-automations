"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTikTokUsernameFromEnv = getTikTokUsernameFromEnv;
exports.refreshSocialTikTokData = refreshSocialTikTokData;
exports.getSocialTikTokData = getSocialTikTokData;
const index_js_1 = require("../agents/socialMedia/index.js");
const socialStore_js_1 = require("../core/socialStore.js");
function getTikTokUsernameFromEnv() {
    return (0, index_js_1.getTikTokUsername)();
}
/** Fetch from Apify, score, persist, return dashboard payload. */
async function refreshSocialTikTokData() {
    console.log(`[social] Apify pull starting for @${(0, index_js_1.getTikTokUsername)()}`);
    await (0, index_js_1.runSocialMediaAgent)();
    return (0, socialStore_js_1.getLatestSocialDashboardData)();
}
function getSocialTikTokData() {
    const data = (0, socialStore_js_1.getLatestSocialDashboardData)();
    const summary = (0, socialStore_js_1.getSocialSummaryForHarvey)();
    return {
        ...data,
        pulledAt: data.lastUpdated,
        stats: summary.stats,
        wow_avg_views_change_pct: summary.wow_avg_views_change_pct,
        days_since_last_pull: summary.days_since_last_pull,
        contentPatterns: summary.contentPatterns ?? data.snapshot?.contentPatterns,
        humanSummary: summary.humanSummary,
    };
}
