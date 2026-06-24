"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateRecordingTask = generateRecordingTask;
exports.getLatestCompetitiveAnalysis = getLatestCompetitiveAnalysis;
exports.getActiveStrategyRecommendations = getActiveStrategyRecommendations;
exports.runFullCompetitiveAnalysis = runFullCompetitiveAnalysis;
const index_js_1 = require("../../integrations/apify/index.js");
const hookClassifier_js_1 = require("./brain/hookClassifier.js");
const decay_js_1 = require("./brain/decay.js");
const stats_js_1 = require("./brain/stats.js");
const contentDb_js_1 = require("../../core/contentDb.js");
const LOCAL_TERMS = [
    "stone oak",
    "canyon lake",
    "new braunfels",
    "san antonio",
    "alamo heights",
];
function firstSentence(text) {
    const trimmed = text.trim();
    const match = trimmed.match(/^[^.!?]+[.!?]?/);
    return (match?.[0] ?? trimmed).trim();
}
function parseJsonFromText(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start)
        return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return null;
    }
}
function filterVideosSince(videos, days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return videos.filter((v) => {
        const t = v.postedAt ? Date.parse(v.postedAt) : 0;
        return t >= cutoff;
    });
}
function extractTheme(caption) {
    const lower = caption.toLowerCase();
    if (/rate|interest/.test(lower))
        return "interest_rate_content";
    if (/first time|first-time/.test(lower))
        return "first_time_buyer_content";
    if (/tour|walkthrough|inside/.test(lower))
        return "property_tour_content";
    if (/mistake|wrong|stop/.test(lower))
        return "controversy_content";
    if (/how much|price|cost|\$/.test(lower))
        return "price_revelation_content";
    if (LOCAL_TERMS.some((t) => lower.includes(t)))
        return "hyperlocal_content";
    if (/tip|secret|know|learn/.test(lower))
        return "education_content";
    return null;
}
function extractTopThemes(videos) {
    const counts = new Map();
    for (const v of videos.filter((x) => x.views > 5000)) {
        const theme = extractTheme(v.caption);
        if (theme)
            counts.set(theme, (counts.get(theme) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([t]) => t);
}
function hookTypeFrequency(videos) {
    const byHandle = {};
    for (const v of videos) {
        const h = v.accountHandle ?? "unknown";
        if (!byHandle[h])
            byHandle[h] = { total: 0, count: 0 };
        byHandle[h].total += v.views;
        byHandle[h].count++;
    }
    const freq = {};
    for (const v of videos) {
        const h = v.accountHandle ?? "unknown";
        const avg = byHandle[h].count > 0 ? byHandle[h].total / byHandle[h].count : 0;
        if (v.views <= avg)
            continue;
        const hook = firstSentence(v.caption);
        const { hookType } = (0, hookClassifier_js_1.classifyHook)(hook);
        freq[hookType] = (freq[hookType] ?? 0) + 1;
    }
    return freq;
}
function parseStrategicPriorities(markdown) {
    const sectionMatch = markdown.match(/THIS WEEK'S STRATEGIC PRIORITIES[\s\S]*?(?=\n[A-Z][A-Z ]+\(|$)/i);
    const section = sectionMatch?.[0] ?? markdown;
    const items = [];
    const numbered = section.matchAll(/^\s*\d+[\.\)]\s*(.+)$/gm);
    for (const m of numbered) {
        const text = m[1].trim();
        if (text.length > 10)
            items.push(text);
    }
    return items.slice(0, 5);
}
function inferPillar(text) {
    const lower = text.toLowerCase();
    if (/brand|personal|win|testimonial/.test(lower))
        return "brand";
    if (/education|tip|learn|rate|buyer/.test(lower))
        return "education";
    if (/listing|tour|property|sold|listed/.test(lower))
        return "listings";
    return "mixed";
}
function inferHookType(text) {
    return (0, hookClassifier_js_1.classifyHook)(text).hookType;
}
function buildMarcoStrengths(marcoAvgViews, competitorAvgViews, model) {
    const strengths = [];
    const hooks = (0, contentDb_js_1.listHookLibrary)({ minUses: 2, limit: 10, order: "desc" });
    if (marcoAvgViews > competitorAvgViews && competitorAvgViews > 0) {
        strengths.push(`Marco averages ${Math.round(marcoAvgViews).toLocaleString()} decay-weighted views vs field ${Math.round(competitorAvgViews).toLocaleString()} — ${((marcoAvgViews / competitorAvgViews - 1) * 100).toFixed(0)}% above competitors.`);
    }
    if (model.topPerformingPillar) {
        strengths.push(`Marco's ${model.topPerformingPillar} pillar is currently the top performer in the performance model.`);
    }
    if (hooks.length > 0) {
        strengths.push(`Top hook pattern "${hooks[0].hookText.slice(0, 60)}" scores ${hooks[0].performanceScore} in the hook library.`);
    }
    if (model.trendingDirection === "up") {
        strengths.push("Performance model trending up — recent videos beating historical average.");
    }
    return strengths.length ? strengths : ["Marco maintains consistent posting volume and local specificity."];
}
function buildMarcoGaps(topThemes, competitorHookFreq, marcoVideos) {
    const gaps = [];
    const marcoCaptions = marcoVideos.map((v) => v.caption.toLowerCase()).join(" ");
    for (const theme of topThemes) {
        const key = theme.replace(/_/g, " ");
        if (!marcoCaptions.includes(key.split("_")[0])) {
            gaps.push(`Competitors winning with ${theme.replace(/_/g, " ")} — underrepresented in Marco's recent 30-day content.`);
        }
    }
    const marcoHooks = (0, contentDb_js_1.listHookLibrary)({ minUses: 1, limit: 50 });
    const marcoHookTypes = new Set(marcoHooks.map((h) => h.hookType));
    const topCompetitorHook = Object.entries(competitorHookFreq).sort((a, b) => b[1] - a[1])[0];
    if (topCompetitorHook && !marcoHookTypes.has(topCompetitorHook[0])) {
        gaps.push(`Competitors over-index on ${topCompetitorHook[0]} hooks (${topCompetitorHook[1]} above-average videos) — Marco is underusing this hook type.`);
    }
    if (gaps.length === 0) {
        gaps.push("Increase volume on themes competitors are winning with this week.");
    }
    return gaps;
}
async function generateRecordingTask(recommendation, brain) {
    const raw = await brain.chat(`Based on this strategy recommendation: '${recommendation.recommendation}' (data backing: '${recommendation.dataBacking}'), generate a specific filming brief for Marco Puga. Return JSON only:
{
  "topic": "specific video topic in one sentence",
  "suggested_hooks": ["hook 1 - exactly what Marco says in first 3 seconds", "hook 2 - alternative opening", "hook 3 - alternative opening"],
  "suggested_duration_min": number in seconds,
  "suggested_duration_max": number in seconds,
  "filming_notes": "specific instructions: where to stand, what to show on camera, what numbers to mention, how to end the video",
  "reason": "one sentence of why this specific video will perform based on the data",
  "due_date": "YYYY-MM-DD of the nearest day this should be filmed by to maintain pipeline"
}`);
    const parsed = parseJsonFromText(raw);
    const dueDate = parsed?.due_date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.due_date)
        ? parsed.due_date
        : new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    const task = (0, contentDb_js_1.insertRecordingTask)({
        dueDate,
        pillar: recommendation.pillar ?? inferPillar(recommendation.recommendation),
        hookType: recommendation.hookType ?? inferHookType(recommendation.recommendation),
        topic: parsed?.topic ?? recommendation.recommendation,
        suggestedHooks: parsed?.suggested_hooks ?? [
            recommendation.recommendation.slice(0, 80),
            "Here's what San Antonio buyers need to know right now",
            "Stop scrolling if you're buying in San Antonio",
        ],
        suggestedDurationMin: parsed?.suggested_duration_min ?? 35,
        suggestedDurationMax: parsed?.suggested_duration_max ?? 55,
        filmingNotes: parsed?.filming_notes ??
            "Film on location or in Marco's office. Open with the hook in first 3 seconds.",
        reason: parsed?.reason ?? recommendation.dataBacking,
        strategyRecommendationId: recommendation.id,
        source: "strategy",
        priority: recommendation.priority <= 2 ? "urgent" : "normal",
    });
    (0, contentDb_js_1.insertCalendarEvent)({
        eventDate: dueDate,
        eventType: "recording_needed",
        title: `Film: ${task.topic.slice(0, 60)}`,
        description: task.filmingNotes,
        pillar: task.pillar,
        platform: null,
        videoId: null,
        recordingTaskId: task.id,
    });
    return task;
}
function getLatestCompetitiveAnalysis() {
    return (0, contentDb_js_1.getLatestCompetitiveAnalysis)();
}
function getActiveStrategyRecommendations() {
    return (0, contentDb_js_1.getActiveStrategyRecommendations)();
}
async function runFullCompetitiveAnalysis(brain, options) {
    const existing = (0, contentDb_js_1.getLatestCompetitiveAnalysis)();
    if (existing && !options?.force) {
        const hoursSince = (Date.now() - new Date(existing.analyzedAt).getTime()) / (1000 * 60 * 60);
        if (hoursSince < 24) {
            console.log("[competitive-analysis] Skipping — analysis ran within last 24 hours");
            return existing;
        }
    }
    const profiles = (0, contentDb_js_1.listActiveCompetitorProfiles)();
    const handles = profiles.map((p) => p.tiktokHandle);
    let marcoVideos = [];
    let competitorVideos = [];
    try {
        marcoVideos = await (0, index_js_1.getMarcoOwnVideos)();
    }
    catch (err) {
        console.error("[competitive-analysis] Marco Apify pull failed:", err);
    }
    try {
        if (handles.length > 0) {
            competitorVideos = await (0, index_js_1.getCompetitorVideos)(handles);
        }
    }
    catch (err) {
        console.error("[competitive-analysis] Competitor Apify pull failed:", err);
    }
    const marcoRecent = filterVideosSince(marcoVideos, 30);
    const competitorRecent = filterVideosSince(competitorVideos, 14);
    const marcoAvgViews = (0, decay_js_1.computeDecayWeightedAvg)(marcoRecent.map((v) => ({ views: v.views, publishedAt: v.postedAt || new Date().toISOString() })));
    const marcoAvgEngagementRate = (0, decay_js_1.computeDecayWeightedEngagement)(marcoRecent.map((v) => ({
        likes: v.likes,
        comments: v.comments,
        shares: v.shares,
        saves: v.saves,
        views: v.views,
        publishedAt: v.postedAt || new Date().toISOString(),
    }))) * 100;
    const competitorAvgViews = competitorRecent.length > 0
        ? competitorRecent.reduce((s, v) => s + v.views, 0) / competitorRecent.length
        : 0;
    const competitorAvgEngagementRate = competitorRecent.length > 0
        ? (competitorRecent.reduce((s, v) => s + (v.likes + v.comments + v.shares + v.saves) / Math.max(1, v.views), 0) /
            competitorRecent.length) *
            100
        : 0;
    const handleAvgs = [];
    const byHandle = new Map();
    for (const v of competitorRecent) {
        const h = v.accountHandle ?? "unknown";
        if (!byHandle.has(h))
            byHandle.set(h, []);
        byHandle.get(h).push(v);
    }
    for (const [handle, vids] of byHandle) {
        const avg = vids.reduce((s, x) => s + x.views, 0) / vids.length;
        handleAvgs.push({ handle, avg });
    }
    handleAvgs.sort((a, b) => b.avg - a.avg);
    const topCompetitor = handleAvgs[0] ?? { handle: "", avg: 0 };
    const marcoVsFieldPct = competitorAvgViews > 0
        ? ((marcoAvgViews - competitorAvgViews) / competitorAvgViews) * 100
        : 0;
    const topCompetitorThemes = extractTopThemes(competitorRecent);
    const competitorHookFreq = hookTypeFrequency(competitorRecent);
    const model = (0, contentDb_js_1.getPerformanceModel)();
    const marcoStrengths = buildMarcoStrengths(marcoAvgViews, competitorAvgViews, model);
    const marcoGaps = buildMarcoGaps(topCompetitorThemes, competitorHookFreq, marcoRecent);
    const aboveBelow = marcoVsFieldPct >= 0 ? "above" : "below";
    const analysisRaw = await brain.chat(`You are conducting a full competitive analysis for Marco Puga (@puga.realtor), a San Antonio real estate agent. Here is the data:
Marco's metrics (last 30 days, decay-weighted): avg views: ${Math.round(marcoAvgViews)}, avg engagement rate: ${marcoAvgEngagementRate.toFixed(2)}%, trending direction: ${model.trendingDirection}.
Competitor field average (last 14 days, ${handles.length} competitors): avg views: ${Math.round(competitorAvgViews)}, avg engagement rate: ${competitorAvgEngagementRate.toFixed(2)}%.
Marco vs field: ${marcoVsFieldPct.toFixed(1)}% (${aboveBelow} competitor average).
Top competitor: @${topCompetitor.handle} averaging ${Math.round(topCompetitor.avg)} views per video.
What competitors are winning with (content themes in their high-performing videos): ${JSON.stringify(topCompetitorThemes)}.
What hook types are in competitor top-performers: ${JSON.stringify(competitorHookFreq)}.
Marco's identified strengths: ${JSON.stringify(marcoStrengths)}.
Marco's identified gaps: ${JSON.stringify(marcoGaps)}.
Write a complete competitive analysis in this exact structure:

SITUATION SUMMARY (2-3 sentences: where Marco stands vs the field right now)
WHAT MARCO IS DOING RIGHT (3-5 specific points with data)
WHAT COMPETITORS ARE WINNING WITH THAT MARCO IS MISSING (3-5 specific gaps with data — be brutally honest)
THE SINGLE BIGGEST OPPORTUNITY (1 paragraph — the one thing that could move Marco's numbers the most based on this analysis)
THIS WEEK'S STRATEGIC PRIORITIES (numbered list of 5 specific, actionable recommendations with the data that supports each one)

Be specific. Name exact content types, hook structures, competitor strategies. Do not give generic social media advice. Every recommendation should be something Marco can execute in the next 7 days.`);
    const now = new Date().toISOString();
    const weekStart = (0, stats_js_1.getWeekStart)();
    const analysis = (0, contentDb_js_1.insertCompetitiveAnalysis)({
        analyzedAt: now,
        weekStart,
        profilesAnalyzed: handles,
        marcoAvgViews,
        marcoAvgEngagementRate,
        competitorAvgViews,
        competitorAvgEngagementRate,
        marcoVsFieldPct,
        topCompetitorHandle: topCompetitor.handle,
        topCompetitorAvgViews: topCompetitor.avg,
        marcoStrengths,
        marcoGaps,
        topCompetitorThemes,
        fullAnalysisMarkdown: analysisRaw,
    });
    const priorities = parseStrategicPriorities(analysisRaw);
    const createdRecommendations = [];
    for (let i = 0; i < priorities.length; i++) {
        const text = priorities[i];
        const rec = (0, contentDb_js_1.insertStrategyRecommendation)({
            analysisId: analysis.id,
            priority: i + 1,
            recommendation: text,
            dataBacking: `Marco avg ${Math.round(marcoAvgViews)} views vs field ${Math.round(competitorAvgViews)}. Gap theme: ${topCompetitorThemes[0] ?? "n/a"}.`,
            pillar: inferPillar(text),
            hookType: inferHookType(text),
            exampleFromCompetitor: topCompetitor.handle ? `@${topCompetitor.handle}` : null,
            expectedImpact: "Improve views toward 6,006 benchmark and sprint pace.",
        });
        createdRecommendations.push(rec);
    }
    for (const rec of createdRecommendations.slice(0, 3)) {
        try {
            await generateRecordingTask(rec, brain);
        }
        catch (err) {
            console.error("[competitive-analysis] Recording task generation failed:", err);
        }
    }
    return analysis;
}
