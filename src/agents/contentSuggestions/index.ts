import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { getLatestSocialDashboardData, getSocialDb } from "../../core/socialStore.js";
import type { SocialDashboardVideo } from "../../core/socialStore.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ContentSuggestion {
  title: string;
  angle: string;
  reasoning: string;
  trendBased: boolean;
}

export interface WeeklyContentSuggestions {
  generatedAt: string;
  weekOf: string;
  suggestions: ContentSuggestion[];
  currentTrendsSummary: string;
  basedOn: string;
}

function videoCaption(v: SocialDashboardVideo): string {
  return (v.caption || "").trim();
}

function videoScore(v: SocialDashboardVideo): number {
  return v.scoreBreakdown?.score ?? v.score ?? 0;
}

function migrateContentSuggestionsTable(db: ReturnType<typeof getSocialDb>): void {
  try {
    db.exec(`ALTER TABLE content_suggestions ADD COLUMN current_trends_summary TEXT`);
  } catch {
    // column exists
  }
}

async function fetchCurrentContentTrends(): Promise<string> {
  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
      max_tokens: 800,
      tools: [
        {
          type: "web_search_20250305" as "custom",
          name: "web_search",
        } as Tool,
      ],
      messages: [
        {
          role: "user",
          content:
            "Search for current TikTok content trends for real estate agents — trending formats, sounds, hooks, or challenges that are working right now for real estate content creators. Focus on the last 1-2 weeks.\n\nReturn a brief 3-4 sentence summary of what's trending and how a real estate agent could apply it.",
        },
      ],
    });

    const fullText = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return fullText.trim();
  } catch (err) {
    console.error("[ContentSuggestions] Trend search failed:", err);
    return "Current trend data unavailable — suggestions based on your own performance data only.";
  }
}

function normalizeSuggestion(raw: Record<string, unknown>): ContentSuggestion {
  return {
    title: String(raw.title ?? "Untitled idea"),
    angle: String(raw.angle ?? ""),
    reasoning: String(raw.reasoning ?? ""),
    trendBased: Boolean(raw.trendBased),
  };
}

export async function generateWeeklyContentSuggestions(): Promise<WeeklyContentSuggestions> {
  console.log("[ContentSuggestions] Generating weekly content ideas...");

  const data = getLatestSocialDashboardData();
  const videos = data.videos || [];

  const topVideos = [...videos]
    .sort((a, b) => videoScore(b) - videoScore(a))
    .slice(0, 5)
    .map((v) => ({
      description: videoCaption(v),
      score: videoScore(v),
      views: v.views || 0,
    }));

  const contentPatterns = data.snapshot?.contentPatterns ?? {};
  const currentTrends = await fetchCurrentContentTrends();

  const prompt = `You are a TikTok content strategist for Marco Puga, a San Antonio real estate agent targeting buyers with 600k+ budgets, new construction homes west of Stone Oak.

TOP PERFORMING VIDEOS THIS WEEK (Marco's own data):
${topVideos
  .map(
    (v, i) =>
      `${i + 1}. "${v.description.substring(0, 100)}" — Score ${v.score}/100, ${v.views.toLocaleString()} views`,
  )
  .join("\n")}

CONTENT PATTERNS DETECTED:
${JSON.stringify(contentPatterns, null, 2)}

CURRENT TIKTOK TRENDS (general, last 1-2 weeks):
${currentTrends}

Based on what's working for Marco AND current trends, generate exactly 3 content ideas for next week. Each should:
- Build on what's performing well for Marco specifically (similar hooks, formats, topics)
- Where relevant, incorporate a current trend adapted for real estate
- Be specific enough to film — not generic advice
- Include reasoning tied to both Marco's data and/or current trends

Return ONLY this JSON, no markdown:
{
  "suggestions": [
    {
      "title": "Short catchy title for the video",
      "angle": "Specific description of what to film and how to present it",
      "reasoning": "Why this should work — cite Marco's data or current trend",
      "trendBased": true or false
    }
  ]
}

Exactly 3 suggestions.`;

  let suggestions: ContentSuggestion[] = [];

  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const text = textBlock && "text" in textBlock ? textBlock.text.trim() : "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { suggestions: [] };
    const rawList = (parsed.suggestions as Record<string, unknown>[]) || [];
    suggestions = rawList.map((s) => normalizeSuggestion(s));
  } catch (err) {
    console.error("[ContentSuggestions] Generation error:", err);
    suggestions = [
      {
        title: "Content suggestion unavailable",
        angle: "Try regenerating from the dashboard",
        reasoning: "Generation failed — " + (err instanceof Error ? err.message : String(err)),
        trendBased: false,
      },
    ];
  }

  const now = new Date();
  const result: WeeklyContentSuggestions = {
    generatedAt: now.toISOString(),
    weekOf: now.toISOString().split("T")[0],
    suggestions: suggestions.slice(0, 3),
    currentTrendsSummary: currentTrends,
    basedOn: `Top ${topVideos.length} videos from latest pull, content patterns, and current TikTok trends`,
  };

  saveContentSuggestions(result);
  console.log("[ContentSuggestions] Generated", result.suggestions.length, "suggestions");

  return result;
}

function saveContentSuggestions(result: WeeklyContentSuggestions): void {
  const db = getSocialDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generated_at TEXT NOT NULL,
      week_of TEXT NOT NULL,
      suggestions TEXT NOT NULL,
      based_on TEXT NOT NULL,
      current_trends_summary TEXT
    )
  `);
  migrateContentSuggestionsTable(db);

  db.prepare(
    `INSERT INTO content_suggestions (generated_at, week_of, suggestions, based_on, current_trends_summary)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    result.generatedAt,
    result.weekOf,
    JSON.stringify(result.suggestions),
    result.basedOn,
    result.currentTrendsSummary,
  );
}

export function getLatestContentSuggestions(): WeeklyContentSuggestions | null {
  const db = getSocialDb();
  try {
    migrateContentSuggestionsTable(db);
    const row = db
      .prepare(`SELECT * FROM content_suggestions ORDER BY generated_at DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;

    if (!row) return null;
    const rawSuggestions = JSON.parse(String(row.suggestions)) as Record<string, unknown>[];
    return {
      generatedAt: String(row.generated_at),
      weekOf: String(row.week_of),
      suggestions: rawSuggestions.map((s) => normalizeSuggestion(s)),
      currentTrendsSummary: row.current_trends_summary
        ? String(row.current_trends_summary)
        : "No trend data available for this generation.",
      basedOn: String(row.based_on),
    };
  } catch {
    return null;
  }
}

let lastScheduledContentSuggestionsDate: string | null = null;

export function scheduleWeeklyContentSuggestionsMonday8am(): void {
  const checkAndRun = () => {
    const now = new Date();
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
    const centralDay = now.toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "long" });
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? -1);

    if (
      centralDay === "Monday" &&
      hour === 8 &&
      minute >= 0 &&
      minute < 2 &&
      lastScheduledContentSuggestionsDate !== dateStr
    ) {
      lastScheduledContentSuggestionsDate = dateStr;
      generateWeeklyContentSuggestions().catch((err) =>
        console.error("[ContentSuggestions] scheduled run failed:", err),
      );
    }
  };

  setInterval(checkAndRun, 60 * 1000);
  console.log("[ContentSuggestions] Scheduled for Monday 8:00 AM Central");
}
