"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enhanceClip = enhanceClip;
const crypto_1 = require("crypto");
const claude_content_js_1 = require("../../integrations/claude-content.js");
const hookClassifier_js_1 = require("./brain/hookClassifier.js");
const patterns_js_1 = require("./brain/patterns.js");
const competitorIntel_js_1 = require("./competitorIntel.js");
const contentDb_js_1 = require("../../core/contentDb.js");
/** System prompt for hook/caption generation — Marco's voice, hook science, and funnel CTA logic. */
const MARCO_VOICE_SYSTEM = `You are the hook and caption writer for Marco Puga Realty (@puga.realtor), a San Antonio real estate agent building a TikTok-first content system.

MARCO'S VOICE (never break these rules):
- Short sentences. Direct. First person ("I", never "we" or "our team").
- Contractions always — "you're" not "you are", "here's" not "here is".
- Zero corporate language. No "leverage", "synergy", "circle back", "unlock", "elevate".
- One exclamation point max per piece of content.
- San Antonio specific — real neighborhoods (Stone Oak, Canyon Lake, New Braunfels, Alamo Heights), never generic "your area".
- Real numbers only — actual prices, actual square footage, actual rates. Never round vaguely.
- Friendly but not soft. Confident but not arrogant.

HOOK SCIENCE (the first 1-3 seconds decide watch time, the #1 ranking signal):
Question hooks drive comments. Data hooks (a specific number/price/rate) drive saves. Local hooks ("Stone Oak buyers...") drive DMs. Personal-story hooks build trust. Controversy/shock hooks drive shares. Every hook must be grounded in what Marco actually said in the footage — never invent details that aren't in the transcript excerpt.

THE FUNNEL (every caption moves a viewer down this path):
entertained -> educated -> trusting -> DM -> phone number -> Carlos closes.
CTAs should nudge toward a DM or comment Marco's team can convert into a phone number — never "link in bio" or generic engagement bait.

PLATFORM PACING:
TikTok (primary) wants the fastest pacing and native slang is fine. Instagram Reels reuses the same clip with a slightly warmer, more polished tone. Facebook Reels reuses it again with slightly more explanation since that audience skews older. Write for TikTok-native pacing first — it reads fine on Reels and Facebook too.

Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON.`;
const CTA_BY_PILLAR = {
    brand: `"DM me" — trust is already built by this point in a brand video, so ask directly`,
    education: `"Comment your question and I'll answer it" — drives the comment signal and qualifies the lead`,
    listings: `"DM me for the address" — gates a hyperlocal lead behind a DM`,
};
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
    const { videoId, sourceFileId, clipResult, pillar, trendRecord } = input;
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
        const response = await claude_content_js_1.claudeContent.messages.create({
            model: claude_content_js_1.CONTENT_MODELS.QUALITY,
            max_tokens: 800,
            system: MARCO_VOICE_SYSTEM,
            messages: [{
                    role: "user",
                    content: `Marco just recorded real footage for a ${effectivePillar} pillar TikTok video (${clipResult.duration}s). Here is what OpenShorts detected from the actual transcript:
- Suggested opening line from the footage: "${clipResult.suggestedCaption}"
- Why this moment was clipped: "${clipResult.whyThisClip}"

Context to write from:
- Current TikTok trend brief: ${trendRecord.trendBrief}
- Marco's hook patterns currently beating the 6,006-view benchmark: ${JSON.stringify(model.workingHookPatterns)}
- The hook type currently winning across Marco's account: ${winningHookType}

Write 5 hook variations for the first line of this specific video, grounded in what he actually said in the footage above. Vary the hook type across the 5 (mix question/data/local/personal-story) so we can test which converts best. Return JSON only: { "hooks": [5 hook strings], "recommended_index": 0-4 (which one best fits the currently winning hook type and trend brief), "reasoning": "one sentence on why the recommended hook was chosen" }`,
                }],
        });
        const hookResp = response.content
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");
        const parsed = parseJsonFromText(hookResp, {});
        if (parsed.hooks?.length) {
            hookVariations = parsed.hooks.slice(0, 5);
            const idx = parsed.recommended_index ?? 0;
            hookPrimary = hookVariations[idx] ?? hookPrimary;
        }
    }
    catch (err) {
        (0, claude_content_js_1.logContentAiFailure)("clip hook variations", err);
    }
    let captionBody = clipResult.suggestedCaption;
    let fullPost = `${hookPrimary}\n\n${captionBody}`;
    try {
        const cta = CTA_BY_PILLAR[effectivePillar] ?? CTA_BY_PILLAR.brand;
        const response = await claude_content_js_1.claudeContent.messages.create({
            model: claude_content_js_1.CONTENT_MODELS.QUALITY,
            max_tokens: 600,
            system: MARCO_VOICE_SYSTEM,
            messages: [{
                    role: "user",
                    content: `Write the caption for this ${effectivePillar} pillar TikTok video, distributed to TikTok first and reused on Instagram Reels and Facebook Reels. The video opens with this exact hook: "${hookPrimary}". Why this clip was chosen: "${clipResult.whyThisClip}". Current trend brief: ${trendRecord.trendBrief}. Caption body (the part after the hook) must be under 150 characters and end with a CTA styled like: ${cta}. Return JSON only: { "caption": string, "full_post": string (hook + caption body, ready to post) }`,
                }],
        });
        const captionResp = response.content
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");
        const parsed = parseJsonFromText(captionResp, {});
        if (parsed.caption)
            captionBody = parsed.caption;
        if (parsed.full_post)
            fullPost = parsed.full_post;
    }
    catch (err) {
        (0, claude_content_js_1.logContentAiFailure)("clip caption generation", err);
    }
    const hashtags = selectHashtags(trendRecord);
    const trendScore = (0, competitorIntel_js_1.getTrendAlignmentScore)(captionBody, hookPrimary, hashtags, trendRecord, clipResult.duration);
    let trendAlignmentReason = clipResult.whyThisClip || "Aligns with current competitor hook and hashtag patterns.";
    try {
        const response = await claude_content_js_1.claudeContent.messages.create({
            model: claude_content_js_1.CONTENT_MODELS.FAST,
            max_tokens: 150,
            messages: [{
                    role: "user",
                    content: `Why does this clip align or not align with current trends? In one sentence. Hook: '${hookPrimary}'. Trend score: ${trendScore}. Trend brief: ${trendRecord.trendBrief.slice(0, 200)}`,
                }],
        });
        const reasonResp = response.content
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("")
            .trim();
        if (reasonResp)
            trendAlignmentReason = reasonResp.split("\n")[0];
    }
    catch (err) {
        (0, claude_content_js_1.logContentAiFailure)("clip trend alignment reasoning", err);
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
