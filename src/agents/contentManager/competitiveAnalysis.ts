import { getCompetitorVideos, getMarcoOwnVideos } from "../../integrations/apify/index.js";
import type { TikTokVideoNormalized } from "../../integrations/apify/types.js";
import type { ContentManagerBrain } from "./brain/index.js";
import { claudeContent, CONTENT_MODELS, logContentAiFailure } from "../../integrations/claude-content.js";
import { classifyHook } from "./brain/hookClassifier.js";
import {
  computeDecayWeightedAvg,
  computeDecayWeightedEngagement,
} from "./brain/decay.js";
import { getWeekStart } from "./brain/stats.js";
import { getRedditQuestionSignals } from "./redditIntel.js";
import {
  getActiveStrategyRecommendations as dbGetActiveStrategyRecommendations,
  getLatestCompetitiveAnalysis as dbGetLatestCompetitiveAnalysis,
  getPerformanceModel,
  insertCalendarEvent,
  insertCompetitiveAnalysis,
  insertRecordingTask,
  insertStrategyRecommendation,
  listActiveCompetitorProfiles,
  listHookLibrary,
  type CmCompetitiveAnalysis,
  type CmRecordingTask,
  type CmStrategyRecommendation,
} from "../../core/contentDb.js";

const LOCAL_TERMS = [
  "stone oak",
  "canyon lake",
  "new braunfels",
  "san antonio",
  "alamo heights",
];

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^[^.!?]+[.!?]?/);
  return (match?.[0] ?? trimmed).trim();
}

function parseJsonFromText<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function filterVideosSince(videos: TikTokVideoNormalized[], days: number): TikTokVideoNormalized[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return videos.filter((v) => {
    const t = v.postedAt ? Date.parse(v.postedAt) : 0;
    return t >= cutoff;
  });
}

function extractTheme(caption: string): string | null {
  const lower = caption.toLowerCase();
  if (/rate|interest/.test(lower)) return "interest_rate_content";
  if (/first time|first-time/.test(lower)) return "first_time_buyer_content";
  if (/tour|walkthrough|inside/.test(lower)) return "property_tour_content";
  if (/mistake|wrong|stop/.test(lower)) return "controversy_content";
  if (/how much|price|cost|\$/.test(lower)) return "price_revelation_content";
  if (LOCAL_TERMS.some((t) => lower.includes(t))) return "hyperlocal_content";
  if (/tip|secret|know|learn/.test(lower)) return "education_content";
  return null;
}

function extractTopThemes(videos: TikTokVideoNormalized[]): string[] {
  const counts = new Map<string, number>();
  for (const v of videos.filter((x) => x.views > 5000)) {
    const theme = extractTheme(v.caption);
    if (theme) counts.set(theme, (counts.get(theme) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t);
}

function hookTypeFrequency(videos: TikTokVideoNormalized[]): Record<string, number> {
  const byHandle: Record<string, { total: number; count: number }> = {};
  for (const v of videos) {
    const h = v.accountHandle ?? "unknown";
    if (!byHandle[h]) byHandle[h] = { total: 0, count: 0 };
    byHandle[h].total += v.views;
    byHandle[h].count++;
  }

  const freq: Record<string, number> = {};
  for (const v of videos) {
    const h = v.accountHandle ?? "unknown";
    const avg = byHandle[h].count > 0 ? byHandle[h].total / byHandle[h].count : 0;
    if (v.views <= avg) continue;
    const hook = firstSentence(v.caption);
    const { hookType } = classifyHook(hook);
    freq[hookType] = (freq[hookType] ?? 0) + 1;
  }
  return freq;
}

function parseStrategicPriorities(markdown: string): string[] {
  // "DO THIS NEXT" is the current header; keep the old header for records
  // generated before the prompt was made scannable. It is the last section,
  // so capture to end of string.
  const sectionMatch = markdown.match(
    /(?:DO THIS NEXT|THIS WEEK'S STRATEGIC PRIORITIES)[:\s]*([\s\S]*)$/i,
  );
  const section = sectionMatch?.[1] ?? markdown;
  const items: string[] = [];
  const numbered = section.matchAll(/^\s*\d+[\.\)]\s*(.+)$/gm);
  for (const m of numbered) {
    const text = m[1].replace(/\*\*/g, "").trim();
    if (text.length > 10) items.push(text);
  }
  return items.slice(0, 5);
}

function inferPillar(text: string): string {
  const lower = text.toLowerCase();
  if (/brand|personal|win|testimonial/.test(lower)) return "brand";
  if (/education|tip|learn|rate|buyer/.test(lower)) return "education";
  if (/listing|tour|property|sold|listed/.test(lower)) return "listings";
  return "mixed";
}

function inferHookType(text: string): string {
  return classifyHook(text).hookType;
}

function buildMarcoStrengths(
  marcoAvgViews: number,
  competitorAvgViews: number,
  model: ReturnType<typeof getPerformanceModel>,
): string[] {
  const strengths: string[] = [];
  const hooks = listHookLibrary({ minUses: 2, limit: 10, order: "desc" });
  if (marcoAvgViews > competitorAvgViews && competitorAvgViews > 0) {
    strengths.push(
      `Marco averages ${Math.round(marcoAvgViews).toLocaleString()} decay-weighted views vs field ${Math.round(competitorAvgViews).toLocaleString()} — ${((marcoAvgViews / competitorAvgViews - 1) * 100).toFixed(0)}% above competitors.`,
    );
  }
  if (model.topPerformingPillar) {
    strengths.push(
      `Marco's ${model.topPerformingPillar} pillar is currently the top performer in the performance model.`,
    );
  }
  if (hooks.length > 0) {
    strengths.push(
      `Top hook pattern "${hooks[0].hookText.slice(0, 60)}" scores ${hooks[0].performanceScore} in the hook library.`,
    );
  }
  if (model.trendingDirection === "up") {
    strengths.push("Performance model trending up — recent videos beating historical average.");
  }
  return strengths.length ? strengths : ["Marco maintains consistent posting volume and local specificity."];
}

function buildMarcoGaps(
  topThemes: string[],
  competitorHookFreq: Record<string, number>,
  marcoVideos: TikTokVideoNormalized[],
): string[] {
  const gaps: string[] = [];
  const marcoCaptions = marcoVideos.map((v) => v.caption.toLowerCase()).join(" ");
  for (const theme of topThemes) {
    const key = theme.replace(/_/g, " ");
    if (!marcoCaptions.includes(key.split("_")[0])) {
      gaps.push(`Competitors winning with ${theme.replace(/_/g, " ")} — underrepresented in Marco's recent 30-day content.`);
    }
  }
  const marcoHooks = listHookLibrary({ minUses: 1, limit: 50 });
  const marcoHookTypes = new Set(marcoHooks.map((h) => h.hookType));
  const topCompetitorHook = Object.entries(competitorHookFreq).sort((a, b) => b[1] - a[1])[0];
  if (topCompetitorHook && !marcoHookTypes.has(topCompetitorHook[0])) {
    gaps.push(
      `Competitors over-index on ${topCompetitorHook[0]} hooks (${topCompetitorHook[1]} above-average videos) — Marco is underusing this hook type.`,
    );
  }
  if (gaps.length === 0) {
    gaps.push("Increase volume on themes competitors are winning with this week.");
  }
  return gaps;
}

export async function generateRecordingTask(
  recommendation: CmStrategyRecommendation,
  brain: ContentManagerBrain,
): Promise<CmRecordingTask> {
  const recordingTaskPrompt = `Based on this strategy recommendation: '${recommendation.recommendation}' (data backing: '${recommendation.dataBacking}'), generate a specific filming brief for Marco Puga. Return JSON only:
{
  "topic": "specific video topic in one sentence",
  "suggested_hooks": ["hook 1 - exactly what Marco says in first 3 seconds", "hook 2 - alternative opening", "hook 3 - alternative opening"],
  "suggested_duration_min": number in seconds,
  "suggested_duration_max": number in seconds,
  "filming_notes": "specific instructions: where to stand, what to show on camera, what numbers to mention, how to end the video",
  "reason": "one sentence of why this specific video will perform based on the data",
  "due_date": "YYYY-MM-DD of the nearest day this should be filmed by to maintain pipeline"
}`;

  let raw = "";
  try {
    const response = await claudeContent.messages.create({
      model: CONTENT_MODELS.FAST,
      max_tokens: 600,
      system: "Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON object.",
      messages: [{ role: "user", content: recordingTaskPrompt }],
    });
    raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
  } catch (err) {
    logContentAiFailure("recording task generation", err);
  }

  const parsed = parseJsonFromText<{
    topic: string;
    suggested_hooks: string[];
    suggested_duration_min: number;
    suggested_duration_max: number;
    filming_notes: string;
    reason: string;
    due_date: string;
  }>(raw);

  const dueDate =
    parsed?.due_date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.due_date)
      ? parsed.due_date
      : new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

  const task = insertRecordingTask({
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
    filmingNotes:
      parsed?.filming_notes ??
      "Film on location or in Marco's office. Open with the hook in first 3 seconds.",
    reason: parsed?.reason ?? recommendation.dataBacking,
    strategyRecommendationId: recommendation.id,
    source: "strategy",
    priority: recommendation.priority <= 2 ? "urgent" : "normal",
  });

  insertCalendarEvent({
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

export function getLatestCompetitiveAnalysis(): CmCompetitiveAnalysis | null {
  return dbGetLatestCompetitiveAnalysis();
}

export function getActiveStrategyRecommendations(): CmStrategyRecommendation[] {
  return dbGetActiveStrategyRecommendations();
}

export async function runFullCompetitiveAnalysis(
  brain: ContentManagerBrain,
  options?: { force?: boolean },
): Promise<CmCompetitiveAnalysis> {
  const existing = dbGetLatestCompetitiveAnalysis();
  if (existing && !options?.force) {
    const hoursSince =
      (Date.now() - new Date(existing.analyzedAt).getTime()) / (1000 * 60 * 60);
    if (hoursSince < 24) {
      console.log("[competitive-analysis] Skipping — analysis ran within last 24 hours");
      return existing;
    }
  }

  const profiles = listActiveCompetitorProfiles();
  const handles = profiles.map((p) => p.tiktokHandle);

  let marcoVideos: TikTokVideoNormalized[] = [];
  let competitorVideos: TikTokVideoNormalized[] = [];

  try {
    marcoVideos = await getMarcoOwnVideos();
  } catch (err) {
    console.error("[competitive-analysis] Marco Apify pull failed:", err);
  }

  try {
    if (handles.length > 0) {
      competitorVideos = await getCompetitorVideos(handles);
    }
  } catch (err) {
    console.error("[competitive-analysis] Competitor Apify pull failed:", err);
  }

  const marcoRecent = filterVideosSince(marcoVideos, 30);
  const competitorRecent = filterVideosSince(competitorVideos, 14);

  const marcoAvgViews = computeDecayWeightedAvg(
    marcoRecent.map((v) => ({ views: v.views, publishedAt: v.postedAt || new Date().toISOString() })),
  );
  const marcoAvgEngagementRate =
    computeDecayWeightedEngagement(
      marcoRecent.map((v) => ({
        likes: v.likes,
        comments: v.comments,
        shares: v.shares,
        saves: v.saves,
        views: v.views,
        publishedAt: v.postedAt || new Date().toISOString(),
      })),
    ) * 100;

  const competitorAvgViews =
    competitorRecent.length > 0
      ? competitorRecent.reduce((s, v) => s + v.views, 0) / competitorRecent.length
      : 0;
  const competitorAvgEngagementRate =
    competitorRecent.length > 0
      ? (competitorRecent.reduce(
          (s, v) => s + (v.likes + v.comments + v.shares + v.saves) / Math.max(1, v.views),
          0,
        ) /
          competitorRecent.length) *
        100
      : 0;

  const handleAvgs: Array<{ handle: string; avg: number }> = [];
  const byHandle = new Map<string, TikTokVideoNormalized[]>();
  for (const v of competitorRecent) {
    const h = v.accountHandle ?? "unknown";
    if (!byHandle.has(h)) byHandle.set(h, []);
    byHandle.get(h)!.push(v);
  }
  for (const [handle, vids] of byHandle) {
    const avg = vids.reduce((s, x) => s + x.views, 0) / vids.length;
    handleAvgs.push({ handle, avg });
  }
  handleAvgs.sort((a, b) => b.avg - a.avg);
  const topCompetitor = handleAvgs[0] ?? { handle: "", avg: 0 };

  const marcoVsFieldPct =
    competitorAvgViews > 0
      ? ((marcoAvgViews - competitorAvgViews) / competitorAvgViews) * 100
      : 0;

  const topCompetitorThemes = extractTopThemes(competitorRecent);
  const competitorHookFreq = hookTypeFrequency(competitorRecent);
  const model = getPerformanceModel();

  const marcoStrengths = buildMarcoStrengths(marcoAvgViews, competitorAvgViews, model);
  const marcoGaps = buildMarcoGaps(topCompetitorThemes, competitorHookFreq, marcoRecent);
  const redditSignals = getRedditQuestionSignals(12);

  const aboveBelow = marcoVsFieldPct >= 0 ? "above" : "below";
  const competitiveAnalysisPrompt = `Competitive analysis for Marco Puga (@puga.realtor), a San Antonio real estate agent. Data:
Marco (last 30 days, decay-weighted): ${Math.round(marcoAvgViews)} avg views, ${marcoAvgEngagementRate.toFixed(2)}% engagement, trending ${model.trendingDirection}.
Competitor field (last 14 days, ${handles.length} competitors): ${Math.round(competitorAvgViews)} avg views, ${competitorAvgEngagementRate.toFixed(2)}% engagement.
Marco vs field: ${marcoVsFieldPct.toFixed(1)}% (${aboveBelow} field average).
Top competitor: @${topCompetitor.handle} at ${Math.round(topCompetitor.avg)} avg views.
Competitor winning themes: ${JSON.stringify(topCompetitorThemes)}.
Competitor top-performer hook types: ${JSON.stringify(competitorHookFreq)}.
Marco's data-backed strengths: ${JSON.stringify(marcoStrengths)}.
Marco's data-backed gaps: ${JSON.stringify(marcoGaps)}.
${redditSignals.length ? `Real questions real buyers are asking on Reddit this week (treat these as content-gap signals and reference specific ones in DO THIS NEXT):\n${redditSignals.map((q) => `- ${q}`).join("\n")}\n` : ""}
Be concise. This is for a busy person reading on a screen. Bullets over paragraphs. Every line earns its place or gets cut. No hedging, no meta-commentary — if a point isn't supported by the data above, leave it out entirely (do NOT write sentences explaining what you're leaving out). Name exact content types, hooks, and topics — no generic social-media advice. Match Marco's voice: direct, no corporate speak. Never reference data structures, code syntax, brackets, or braces in the output — if a data field above is empty, describe it in plain English (e.g. "no competitor hook data has been collected yet"), never write out empty arrays or objects like [] or {}.

Output EXACTLY this structure and nothing else. Start with "HEADLINE:".

HEADLINE: <one sharp sentence — the single most important finding, include the key number>

WHAT'S WORKING:
- **<key phrase>** — <one short clause, max 2 lines total>
(max 3 bullets; one idea each; bold the key phrase)

THE GAP:
- **<key phrase>** — <one short clause>
(max 3 bullets; brutally honest but data-backed only)

DO THIS NEXT:
1. <one concrete action Marco can film/post in the next 7 days — name the exact topic or hook>
2. <action>
3. <action>
(exactly 3 numbered actions)`;

  let analysisRaw = "";
  try {
    const response = await claudeContent.messages.create({
      model: CONTENT_MODELS.QUALITY,
      max_tokens: 1200,
      system:
        "You are a sharp content strategist texting a busy client. Concise, punchy, bullets over paragraphs. Every line earns its place or gets cut. No preamble, no closing, no hedging.",
      messages: [{ role: "user", content: competitiveAnalysisPrompt }],
    });
    analysisRaw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
  } catch (err) {
    logContentAiFailure("full competitive analysis", err);
  }
  if (!analysisRaw) {
    analysisRaw =
      `HEADLINE: Marco is ${Math.abs(marcoVsFieldPct).toFixed(0)}% ${aboveBelow} the competitor field average this period.\n\n` +
      `DO THIS NEXT:\n1. Increase volume on themes competitors are winning with this week.`;
  }

  const now = new Date().toISOString();
  const weekStart = getWeekStart();

  const analysis = insertCompetitiveAnalysis({
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
  const createdRecommendations: CmStrategyRecommendation[] = [];

  for (let i = 0; i < priorities.length; i++) {
    const text = priorities[i];
    const rec = insertStrategyRecommendation({
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
    } catch (err) {
      console.error("[competitive-analysis] Recording task generation failed:", err);
    }
  }

  return analysis;
}
