"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enhanceClip = enhanceClip;
const crypto_1 = require("crypto");
const hookClassifier_js_1 = require("./brain/hookClassifier.js");
const patterns_js_1 = require("./brain/patterns.js");
const competitorIntel_js_1 = require("./competitorIntel.js");
const contentDb_js_1 = require("../../core/contentDb.js");
const HOUR_BUCKET_MAP = {
    morning: 9,
    afternoon: 14,
    evening: 18,
    night: 21,
};
const DAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];
function parseJsonFromText(text, fallback) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match)
        return fallback;
    try {
        return JSON.parse(match[0]);
    }
    catch {
        return fallback;
    }
}
function nextOptimalSlotIso(dayName, hourBucket, addMinutes = 0) {
    const targetHour = HOUR_BUCKET_MAP[hourBucket] ?? 17;
    const targetDayIndex = DAY_NAMES.findIndex((d) => d.toLowerCase() === dayName.toLowerCase());
    const now = new Date();
    const result = new Date(now);
    if (targetDayIndex >= 0) {
        const currentDay = result.getDay();
        let daysAhead = targetDayIndex - currentDay;
        if (daysAhead < 0)
            daysAhead += 7;
        if (daysAhead === 0 && result.getHours() >= targetHour)
            daysAhead = 7;
        result.setDate(result.getDate() + daysAhead);
    }
    result.setHours(targetHour, 0, 0, 0);
    result.setMinutes(result.getMinutes() + addMinutes);
    return result.toISOString();
}
function buildTitle(pillar, hook) {
    const pillarLabel = pillar.toUpperCase();
    const hookWords = hook.split(/\s+/).slice(0, 4).join(" ");
    const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${pillarLabel} — ${hookWords} — ${date}`;
}
function selectHashtags(trendRecord) {
    const proven = (0, contentDb_js_1.listHashtagPerformance)(5).map((h) => h.hashtag.replace(/^#/, ""));
    const trending = trendRecord.trendingHashtags
        .filter((t) => !proven.includes(t))
        .slice(0, 3);
    const merged = [...proven, ...trending];
    const seen = new Set();
    const result = [];
    for (const tag of merged) {
        const clean = tag.replace(/^#/, "").slice(0, 25);
        if (!clean || seen.has(clean))
            continue;
        seen.add(clean);
        result.push(clean);
    }
    if (result.length === 0) {
        return ["sanantonio", "sanantoniohomes", "texasrealestate"];
    }
    return result;
}
function determinePlatformTargets(pillar, duration, trendScore) {
    const platforms = new Set(["tiktok"]);
    if (pillar === "education") {
        platforms.add("youtube");
        platforms.add("instagram");
    }
    else if (pillar === "listings") {
        platforms.add("instagram");
        platforms.add("facebook");
    }
    else if (pillar === "brand") {
        platforms.add("instagram");
        platforms.add("facebook");
    }
    else if (pillar === "mixed") {
        platforms.add("instagram");
    }
    if (duration > 60) {
        platforms.add("youtube");
        platforms.delete("facebook");
    }
    if (trendScore > 70) {
        platforms.add("tiktok");
        platforms.add("instagram");
        platforms.add("facebook");
        platforms.add("youtube");
    }
    return [...platforms];
}
function topWinningHookType() {
    const summary = (0, hookClassifier_js_1.getHookTypePerformanceSummary)();
    let bestType = "question";
    let bestViews = 0;
    for (const [type, stats] of Object.entries(summary)) {
        if (stats.avg_views > bestViews) {
            bestViews = stats.avg_views;
            bestType = type;
        }
    }
    return bestType;
}
async function enhanceClip(input) {
    const { videoId, sourceFileId, clipResult, pillar, trendRecord, brain } = input;
    const effectivePillar = pillar === "mixed" ? "brand" : pillar;
    const classified = clipResult.hookType !== "uncategorized"
        ? {
            hookType: clipResult.hookType,
            hookStructure: clipResult.hookPreview,
            confidence: 0.8,
        }
        : (0, hookClassifier_js_1.classifyHook)(clipResult.suggestedCaption);
    const hookType = classified.hookType;
    const model = (0, contentDb_js_1.getPerformanceModel)();
    const winningHookType = topWinningHookType();
    let hookPrimary = clipResult.hookPreview ||
        clipResult.suggestedCaption.split(/[.!?]/)[0]?.trim() ||
        clipResult.suggestedCaption;
    let hookVariations = [
        hookPrimary,
        `Did you know ${clipResult.suggestedCaption.slice(0, 60)}?`,
        clipResult.suggestedCaption.slice(0, 80),
        `San Antonio buyers — ${clipResult.suggestedCaption.slice(0, 70)}`,
        clipResult.suggestedCaption,
    ];
    try {
        const hookResp = await brain.chat(`Generate 5 hook variations for a ${effectivePillar} real estate TikTok video for Marco Puga (@puga.realtor), a San Antonio agent. OpenShorts suggested opening: '${clipResult.suggestedCaption}'. Why this clip: '${clipResult.whyThisClip}'. Current trending patterns: ${trendRecord.trendBrief}. Working hook patterns from Marco's account: ${JSON.stringify(model.workingHookPatterns)}. Hook type that is currently winning: ${winningHookType}. Marco's voice rules: short sentences, first person, contractions always, San Antonio specific, no corporate speak, real numbers. Return JSON only: { hooks: [5 hook strings], recommended_index: 0, reasoning: 'one sentence' }`);
        const parsed = parseJsonFromText(hookResp, {});
        if (parsed.hooks?.length) {
            hookVariations = parsed.hooks.slice(0, 5);
            const idx = parsed.recommended_index ?? 0;
            hookPrimary = hookVariations[idx] ?? hookPrimary;
        }
    }
    catch (err) {
        console.warn("[clip-enhancer] hook generation failed:", err);
    }
    let captionBody = clipResult.suggestedCaption;
    let fullPost = `${hookPrimary}\n\n${captionBody}`;
    try {
        const captionResp = await brain.chat(`Write a TikTok caption for @puga.realtor (Marco Puga, San Antonio real estate agent) for this ${effectivePillar} video. Hook to use (first line): '${hookPrimary}'. Current trending patterns: ${trendRecord.trendBrief}. Caption must: be under 150 characters after the hook, sound exactly like Marco (direct, first person, contractions, real numbers), include a soft CTA ('DM me' or 'Comment below' or 'Follow for more San Antonio updates'). Return JSON only: { caption: string, full_post: string }`);
        const parsed = parseJsonFromText(captionResp, {});
        if (parsed.caption)
            captionBody = parsed.caption;
        if (parsed.full_post)
            fullPost = parsed.full_post;
    }
    catch (err) {
        console.warn("[clip-enhancer] caption generation failed:", err);
    }
    const hashtags = selectHashtags(trendRecord);
    const trendScore = (0, competitorIntel_js_1.getTrendAlignmentScore)(captionBody, hookPrimary, hashtags, trendRecord, clipResult.duration);
    let trendAlignmentReason = clipResult.whyThisClip || "Aligns with current competitor hook and hashtag patterns.";
    try {
        const reasonResp = await brain.chat(`Why does this clip align or not align with current trends? In one sentence. Hook: '${hookPrimary}'. Trend score: ${trendScore}. Trend brief: ${trendRecord.trendBrief.slice(0, 200)}`);
        if (reasonResp?.trim())
            trendAlignmentReason = reasonResp.trim().split("\n")[0];
    }
    catch {
        /* use default */
    }
    const platformTargets = determinePlatformTargets(pillar, clipResult.duration, trendScore);
    const bestSlot = (0, patterns_js_1.getBestHourForPillar)(effectivePillar);
    const day = bestSlot?.day ?? "Tuesday";
    const hourBucket = bestSlot?.hour_bucket ?? "evening";
    const optimalPostTimeTiktok = nextOptimalSlotIso(day, hourBucket);
    const optimalPostTimeInstagram = nextOptimalSlotIso(day, hourBucket, 30);
    const titleGenerated = clipResult.suggestedTitle || buildTitle(effectivePillar, hookPrimary);
    return (0, contentDb_js_1.insertClipEnhancement)({
        id: (0, crypto_1.randomUUID)(),
        videoId,
        hookPrimary,
        hookVariations,
        hookType,
        captionGenerated: captionBody,
        captionFinal: captionBody,
        hashtagsGenerated: hashtags,
        hashtagsFinal: hashtags,
        titleGenerated,
        titleFinal: titleGenerated,
        platformTargets,
        trendAlignmentScore: trendScore,
        trendAlignmentReason,
        optimalPostTimeTiktok,
        optimalPostTimeInstagram,
        opusClipScore: clipResult.viralScore / 100,
        sourceFileId,
        createdAt: new Date().toISOString(),
        editedBy: "brain",
        thumbnailUrl: clipResult.thumbnailUrl,
    });
}
