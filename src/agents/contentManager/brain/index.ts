/**
 * Content Manager Brain — autonomous content intelligence agent (Google Gemini).
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
import {
  geminiChatWithTools,
  geminiSimpleChat,
  getCmBrainModel,
  getGeminiApiKey,
  type CmBrainChatMessage,
} from "./gemini.js";

export class ContentManagerBrain {
  private apiKey: string | null;

  constructor() {
    this.apiKey = getGeminiApiKey();
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
      return "Content Manager Brain is offline — set GEMINI_API_KEY in .env.";
    }

    const system = CONTENT_MANAGER_BRAIN_PROMPT + extraContext;
    return geminiChatWithTools({
      system,
      userMessage,
      history,
      tools: CM_BRAIN_TOOL_DEFINITIONS,
      model: getCmBrainModel(),
      maxRounds: 8,
      onToolCall: executeContentBrainTool,
    });
  }

  /** Cycle-internal chat (no session persistence). */
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
        response: "Content Manager Brain is offline — set GEMINI_API_KEY in .env.",
        sessionId: sessionId ?? "",
      };
    }

    const now = new Date().toISOString();
    let session = sessionId ? getChatSession(sessionId) : null;
    if (session && session.expiresAt <= now) session = null;
    if (!session) session = createChatSession();

    const priorMessages = listChatMessages(session.id);
    const history: CmBrainChatMessage[] = priorMessages.slice(-20).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const contextSnapshot = this.buildContextSnapshot();
    const system = CONTENT_MANAGER_BRAIN_PROMPT + this.buildContextBlock();

    insertChatMessage({
      sessionId: session.id,
      role: "user",
      content: message,
      performanceContext: contextSnapshot,
    });

    const response = await geminiChatWithTools({
      system,
      userMessage: message,
      history,
      tools: CM_BRAIN_TOOL_DEFINITIONS,
      model: getCmBrainModel(),
      maxRounds: 8,
      onToolCall: executeContentBrainTool,
    });

    insertChatMessage({
      sessionId: session.id,
      role: "assistant",
      content: response,
      performanceContext: null,
    });

    const updated = getChatSession(session.id);
    if (updated && updated.messageCount >= 6 && !updated.sessionSummary) {
      const recent = listChatMessages(session.id).slice(-6);
      const summaryText = recent.map((m) => `${m.role}: ${m.content}`).join("\n");
      const summary = await geminiSimpleChat(
        `Summarize this conversation in one sentence:\n${summaryText}`,
      );
      if (summary) updateChatSessionSummary(session.id, summary);
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
  const provider = getGeminiApiKey()
    ? `Gemini (${getCmBrainModel()})`
    : "offline — set GEMINI_API_KEY";
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
