/**
 * Content Manager Brain — autonomous content intelligence agent (Anthropic Claude).
 */
import { CONTENT_MANAGER_BRAIN_PROMPT } from "./prompts.js";
import { CM_BRAIN_TOOL_DEFINITIONS, executeContentBrainTool } from "./tools.js";
import {
  runEveningCycle,
  runMiddayCycle,
  runMorningCycle,
  runNightCycle,
} from "./cycles.js";
import {
  createChatSession,
  ensureDailyTargets,
  getChatSession,
  getDailyStrategy,
  getLatestCompetitiveAnalysis,
  getActiveStrategyRecommendations,
  getPerformanceModel,
  insertChatMessage,
  listChatMessages,
  listLearningLogs,
  listRecordingTasks,
  todayDateCst,
  updateChatSessionSummary,
  getSprintProgressData,
} from "../../../core/contentDb.js";
import { getLatestYouTubeAnalysis } from "../youtubeIntel.js";
import {
  claudeChatWithTools,
  claudeSimpleChat,
  getContentBrainModel,
  type CmBrainChatMessage,
} from "./claudeTools.js";
import {
  claudeContent,
  CONTENT_MODELS,
  logContentAiFailure,
  validateAnthropicKey,
} from "../../../integrations/claude-content.js";

export class ContentManagerBrain {
  private apiKey: string | null;

  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
  }

  private buildContextSnapshot(): Record<string, unknown> {
    const model = getPerformanceModel();
    const strategy = getDailyStrategy(todayDateCst());
    const targets = ensureDailyTargets(todayDateCst());
    const logs = listLearningLogs({ limit: 2 });
    const analysis = getLatestCompetitiveAnalysis();
    const activeRecs = getActiveStrategyRecommendations().slice(0, 3);
    const today = todayDateCst();
    const weekEnd = new Date(`${today}T12:00:00`);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekEndStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
      weekEnd,
    );
    const pendingTasks = listRecordingTasks({
      status: "pending",
      dueAfter: today,
      dueBefore: weekEndStr,
      limit: 20,
    });
    const sprint = getSprintProgressData();

    let youtubeContext: Record<string, unknown> | null = null;
    try {
      const latestYT = getLatestYouTubeAnalysis();
      if (latestYT) {
        const daysSince = Math.floor(
          (Date.now() - new Date(latestYT.analyzedAt).getTime()) / (1000 * 60 * 60 * 24),
        );
        youtubeContext = {
          analyzed_days_ago: daysSince,
          videos_analyzed: latestYT.videosAnalyzed,
          channels_analyzed: latestYT.channelsAnalyzed,
          content_gaps: latestYT.contentGaps.slice(0, 5),
          top_hook_structures: latestYT.topHookStructures.slice(0, 5),
          top_opening_phrases: latestYT.topOpeningPhrases.slice(0, 5),
          top_topics: latestYT.topTopics.slice(0, 8),
          top_cta_patterns: latestYT.topCtaPatterns.slice(0, 5),
          key_insights: latestYT.keyInsights,
          top_recommended_video: latestYT.topRecommendedVideoIdea,
        };
      }
    } catch {
      /* ignore */
    }

    return {
      avg_views: model.decayWeightedAvgViews || model.overallAvgViews,
      videos_today: targets.videosPublished,
      phone_numbers_today: targets.phoneNumbersCaptured,
      top_pillar: model.topPerformingPillar,
      trending_direction: model.trendingDirection,
      current_streak_type: model.currentStreakType,
      hot_streak_count: model.hotStreakCount,
      cold_streak_count: model.coldStreakCount,
      season_multiplier: model.seasonMultiplier,
      today_strategy: strategy,
      recent_learning: logs,
      competitive: analysis
        ? {
            marco_vs_field_pct: analysis.marcoVsFieldPct,
            top_competitor: analysis.topCompetitorHandle,
            strengths: analysis.marcoStrengths.slice(0, 3),
            gaps: analysis.marcoGaps.slice(0, 3),
            top_recommendation: activeRecs[0]?.recommendation ?? null,
          }
        : null,
      strategy_recommendations: activeRecs.map((r) => ({
        priority: r.priority,
        recommendation: r.recommendation,
        pillar: r.pillar,
      })),
      recording_tasks_pending_7d: pendingTasks.length,
      top_recording_task: pendingTasks[0] ?? null,
      sprint_progress: sprint,
      youtube_intelligence: youtubeContext,
    };
  }

  private buildContextBlock(): string {
    return "\n\nCurrent context: " + JSON.stringify(this.buildContextSnapshot());
  }

  async runToolRound(
    userMessage: string,
    extraContext = "",
    history?: CmBrainChatMessage[],
  ): Promise<string> {
    if (!this.apiKey) {
      return "Content Manager Brain is offline — set ANTHROPIC_API_KEY in .env.";
    }

    const system = CONTENT_MANAGER_BRAIN_PROMPT + extraContext;
    return claudeChatWithTools({
      system,
      userMessage,
      history,
      tools: CM_BRAIN_TOOL_DEFINITIONS,
      model: getContentBrainModel(),
      maxRounds: 8,
      onToolCall: executeContentBrainTool,
    });
  }

  /**
   * Public entry point for Harvey's `ask_content_manager` tool
   * (src/harvey/tools.ts) — the one remaining caller. Every internal content
   * manager module (cycles.ts, competitiveAnalysis.ts, youtubeIntel.ts,
   * calendar.ts, clipEnhancer.ts, experiments.ts) now makes its own direct,
   * independently-routed Claude call instead of going through this method.
   */
  async chat(message: string, context?: object): Promise<string> {
    const model = getPerformanceModel();
    const strategy = getDailyStrategy(todayDateCst());
    const logs = listLearningLogs({ limit: 3 });
    let extra = `\n\nCURRENT PERFORMANCE MODEL:\n${JSON.stringify(model, null, 2)}`;
    extra += `\n\nTODAY'S STRATEGY:\n${JSON.stringify(strategy, null, 2)}`;
    extra += `\n\nRECENT LEARNING (last 3):\n${JSON.stringify(logs, null, 2)}`;
    extra += this.buildContextBlock();
    if (context) extra += `\n\nADDITIONAL CONTEXT:\n${JSON.stringify(context, null, 2)}`;
    return this.runToolRound(message, extra);
  }

  /** Persistent session chat for the dashboard Ask the Brain UI. */
  async chatWithSession(
    message: string,
    sessionId?: string,
  ): Promise<{ response: string; sessionId: string }> {
    if (!this.apiKey) {
      return {
        response: "Content Manager Brain is offline — set ANTHROPIC_API_KEY in .env.",
        sessionId: sessionId ?? "",
      };
    }

    const now = new Date().toISOString();
    let session = sessionId ? getChatSession(sessionId) : null;
    if (session && session.expiresAt <= now) session = null;
    if (!session) session = createChatSession();

    const priorMessages = listChatMessages(session.id);
    const history: Array<{ role: "user" | "assistant"; content: string }> = priorMessages
      .slice(-20)
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

    const contextSnapshot = this.buildContextSnapshot();
    const system =
      CONTENT_MANAGER_BRAIN_PROMPT +
      this.buildContextBlock() +
      "\n\nYou are answering a question in the dashboard chat. Answer directly and " +
      "concisely using the real numbers in the context above — never generic advice. " +
      "If the context does not contain what is needed, say so plainly.";

    insertChatMessage({
      sessionId: session.id,
      role: "user",
      content: message,
      performanceContext: contextSnapshot,
    });

    // One direct Claude call with the live context injected — no agentic tool
    // loop. The former tool loop could invoke slow tools (competitive analysis
    // hits Apify) or nested Claude calls across up to 8 rounds and hang or 500;
    // this answers in a single QUALITY-tier call, fast and reliably.
    let response: string;
    try {
      const completion = await claudeContent.messages.create({
        model: CONTENT_MODELS.QUALITY,
        max_tokens: 1024,
        system,
        messages: [...history, { role: "user", content: message }],
      });
      response =
        completion.content
          .filter((b) => b.type === "text")
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
          .trim() || "No response generated.";
      console.log(`[content-chat] answered (${response.length} chars, session ${session.id})`);
    } catch (err) {
      logContentAiFailure("content-chat", err);
      throw new Error(
        "The content manager couldn't answer that just now — the AI request failed. Please try again in a moment.",
      );
    }

    insertChatMessage({
      sessionId: session.id,
      role: "assistant",
      content: response,
      performanceContext: null,
    });

    const updated = getChatSession(session.id);
    if (updated && updated.messageCount >= 6 && !updated.sessionSummary) {
      try {
        const recent = listChatMessages(session.id).slice(-6);
        const summaryText = recent.map((m) => `${m.role}: ${m.content}`).join("\n");
        const summary = await claudeSimpleChat(
          `Summarize this conversation in one sentence:\n${summaryText}`,
        );
        if (summary) updateChatSessionSummary(session.id, summary);
      } catch (err) {
        // A summary failure must never break the chat response.
        console.warn(`[content-chat] session summary skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { response, sessionId: session.id };
  }

  async runMorningCycle(): Promise<void> {
    await runMorningCycle(this);
  }

  async runMiddayCycle(): Promise<void> {
    await runMiddayCycle(this);
  }

  async runEveningCycle(): Promise<void> {
    await runEveningCycle(this);
  }

  async runNightCycle(): Promise<void> {
    await runNightCycle(this);
  }
}

export const contentManagerBrain = new ContentManagerBrain();

export function getOrCreateSession(): string {
  return createChatSession().id;
}

const lastBrainRuns: Record<string, string> = {};

/** Schedule 6am, 12pm, 6pm, 10pm CST intelligence cycles. */
export function scheduleContentBrainCycles(): void {
  const keyValid = validateAnthropicKey();
  const provider = keyValid
    ? `Claude (${getContentBrainModel()})`
    : "offline — set ANTHROPIC_API_KEY";
  console.log(
    `[cm-brain] intelligence cycles scheduled: 6am, 12pm, 6pm, 10pm America/Chicago — ${provider}`,
  );

  const cycles: Array<{ hour: number; key: string; run: () => Promise<void> }> = [
    { hour: 6, key: "morning", run: () => contentManagerBrain.runMorningCycle() },
    { hour: 12, key: "midday", run: () => contentManagerBrain.runMiddayCycle() },
    { hour: 18, key: "evening", run: () => contentManagerBrain.runEveningCycle() },
    { hour: 22, key: "night", run: () => contentManagerBrain.runNightCycle() },
  ];

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

    for (const cycle of cycles) {
      const runKey = `${cycle.key}-${dateStr}`;
      if (hour === cycle.hour && minute >= 0 && minute < 2 && lastBrainRuns[runKey] !== dateStr) {
        lastBrainRuns[runKey] = dateStr;
        cycle.run().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[cm-brain] ${cycle.key} cycle failed: ${msg}`);
        });
      }
    }
  }, 60_000);
}
