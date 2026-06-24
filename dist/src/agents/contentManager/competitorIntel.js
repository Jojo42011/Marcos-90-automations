"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCachedTrends = getCachedTrends;
exports.runCompetitorScrape = runCompetitorScrape;
exports.getTrendBriefForOpusClip = getTrendBriefForOpusClip;
exports.getTrendAlignmentScore = getTrendAlignmentScore;
const index_js_1 = require("../../integrations/apify/index.js");
const gemini_js_1 = require("../contentManager/brain/gemini.js");
const contentDb_js_1 = require("../../core/contentDb.js");
const THEME_KEYWORDS = [
    "interest rate",
    "first time buyer",
    "san antonio",
    "home tour",
    "just sold",
    "just listed",
    "market update",
    "mortgage",
    "down payment",
    "neighborhood",
];
function firstSentence(text) {
    const trimmed = text.trim();
    const match = trimmed.match(/^[^.!?]+[.!?]?/);
    return (match?.[0] ?? trimmed).trim();
}
function extractHashtags(caption) {
    const tags = [];
    const re = /#(\w+)/g;
    let m;
    while ((m = re.exec(caption)) !== null) {
        tags.push(m[1].toLowerCase());
    }
    return tags;
}
function durationBucket(seconds) {
    if (seconds < 30)
        return "under_30";
    if (seconds <= 60)
        return "30_to_60";
    if (seconds <= 90)
        return "60_to_90";
    return "over_90";
}
function hookPatternType(hook) {
    const lower = hook.toLowerCase();
    if (/^(did you|what if|are you|do you|how|why|is it|can you)\b/i.test(lower) || hook.endsWith("?")) {
        return "question";
    }
    if (/\$[\d,]+|\d+(?:\.\d+)?%/.test(hook))
        return "data";
    if (/\b(just sold|won't tell|wont tell|nobody|most agents)\b/i.test(lower))
        return "shock";
    return null;
}
function fallbackTrendBrief(topHooks, trendingHashtags, bestDurationRange, topContentThemes) {
    const hooks = topHooks.slice(0, 3).join("; ");
    const tags = trendingHashtags.slice(0, 5).join(", ");
    const themes = topContentThemes.slice(0, 3).join(", ");
    return (`High-performing competitor clips this week open with hooks like "${hooks || "direct questions with local context"}". ` +
        `Viral posts lean on hashtags such as ${tags || "sanantonio, firsttimehomebuyer"}. ` +
        `The winning duration bucket is ${bestDurationRange.replace(/_/g, " ")} seconds. ` +
        `Top themes: ${themes || "market updates and buyer education"}. ` +
        "Clip moments where Marco delivers a clear hook in the first 3 seconds with a specific number or local reference.");
}
function getCachedTrends() {
    return (0, contentDb_js_1.getCachedCompetitorTrends)();
}
async function runCompetitorScrape() {
    const profiles = (0, contentDb_js_1.listActiveCompetitorProfiles)();
    const handles = profiles.map((p) => p.tiktokHandle);
    let videos = [];
    try {
        if (handles.length > 0) {
            videos = await (0, index_js_1.getCompetitorVideos)(handles);
        }
    }
    catch (err) {
        console.error("[competitor-intel] Apify scrape failed:", err);
    }
    const highView = videos.filter((v) => v.views > 5000);
    const hookCandidates = highView
        .map((v) => ({ hook: firstSentence(v.caption), views: v.views }))
        .filter((h) => h.hook.length > 10);
    const seenHooks = new Set();
    const topHooks = [];
    for (const h of hookCandidates.sort((a, b) => b.views - a.views)) {
        const key = h.hook.toLowerCase();
        if (seenHooks.has(key))
            continue;
        seenHooks.add(key);
        topHooks.push(h.hook);
        if (topHooks.length >= 15)
            break;
    }
    const hashtagCounts = new Map();
    for (const v of highView) {
        for (const tag of extractHashtags(v.caption)) {
            hashtagCounts.set(tag, (hashtagCounts.get(tag) ?? 0) + 1);
        }
    }
    const trendingHashtags = [...hashtagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([tag]) => tag);
    const durationBuckets = {
        under_30: 0,
        "30_to_60": 0,
        "60_to_90": 0,
        over_90: 0,
    };
    for (const v of videos) {
        const dur = v.duration ?? 45;
        const bucket = durationBucket(dur);
        durationBuckets[bucket] = (durationBuckets[bucket] ?? 0) + 1;
    }
    let bestDurationRange = "30_to_60";
    let bestCount = 0;
    for (const [bucket, count] of Object.entries(durationBuckets)) {
        if (count > bestCount) {
            bestCount = count;
            bestDurationRange = bucket;
        }
    }
    const themeCounts = new Map();
    for (const theme of THEME_KEYWORDS) {
        let count = 0;
        for (const v of highView) {
            if (v.caption.toLowerCase().includes(theme))
                count++;
        }
        if (count > 0)
            themeCounts.set(theme, count);
    }
    const topContentThemes = [...themeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([t]) => t);
    let trendBrief = fallbackTrendBrief(topHooks, trendingHashtags, bestDurationRange, topContentThemes);
    const prompt = `You are the Content Manager for Marco Puga, a San Antonio real estate agent. Here is what's performing best on competitor real estate TikTok accounts right now: Top hooks from high-performing videos: ${JSON.stringify(topHooks)}. Most used hashtags on viral posts: ${JSON.stringify(trendingHashtags)}. Best performing video duration: ${bestDurationRange}. Top content themes: ${JSON.stringify(topContentThemes)}. Write a trend brief of 4-5 specific, actionable sentences that could be used to direct a video clipping AI (OpusClip) to find the best moments in Marco's footage AND direct a caption writer to write hooks that match current trends. Be specific. Name the patterns. Example: 'Question hooks opening with a specific dollar amount are generating 3x average engagement this week.' Return plain text only — no JSON, no bullet points, just the trend brief paragraph.`;
    try {
        const aiBrief = await (0, gemini_js_1.geminiSimpleChat)(prompt);
        if (aiBrief?.trim())
            trendBrief = aiBrief.trim();
    }
    catch (err) {
        console.warn("[competitor-intel] Gemini trend brief failed, using fallback:", err);
    }
    const now = new Date();
    const scrapedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString();
    return (0, contentDb_js_1.insertCompetitorTrends)({
        scrapedAt,
        profilesScraped: handles,
        rawVideoCount: videos.length,
        topHooks,
        trendingHashtags,
        topPerformingDurations: durationBuckets,
        bestDurationRange,
        topContentThemes,
        trendBrief,
        expiresAt,
    });
}
function getTrendBriefForOpusClip(trendRecord) {
    const durationLabel = trendRecord.bestDurationRange.replace(/_/g, " to ");
    const tags = trendRecord.trendingHashtags.slice(0, 8).join(", ");
    return ("CURRENT TRENDING PATTERNS IN REAL ESTATE TIKTOK (use these to select which moments to clip): " +
        trendRecord.trendBrief +
        " Best performing duration this week: " +
        durationLabel +
        " seconds. Trending hashtags for context: " +
        tags +
        ".");
}
function getTrendAlignmentScore(caption, hook, hashtags, trendRecord, clipDurationSeconds) {
    let score = 0;
    const hookType = hookPatternType(hook);
    if (hookType) {
        const matchesPattern = trendRecord.topHooks.some((h) => hookPatternType(h) === hookType);
        if (matchesPattern)
            score += 30;
    }
    const trendingSet = new Set(trendRecord.trendingHashtags.map((t) => t.toLowerCase()));
    let hashtagMatches = 0;
    for (const tag of hashtags) {
        const clean = tag.replace(/^#/, "").toLowerCase();
        if (trendingSet.has(clean))
            hashtagMatches++;
    }
    score += Math.min(30, hashtagMatches * 3);
    const captionLower = caption.toLowerCase();
    let themeMatches = 0;
    for (const theme of trendRecord.topContentThemes) {
        if (captionLower.includes(theme.toLowerCase()))
            themeMatches++;
    }
    score += Math.min(25, themeMatches * 10);
    if (clipDurationSeconds != null) {
        const bucket = durationBucket(clipDurationSeconds);
        if (bucket === trendRecord.bestDurationRange)
            score += 15;
    }
    return Math.min(100, score);
}
