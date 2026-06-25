/**
 * Content Manager Brain — 16 tools for autonomous intelligence cycles.
 */
import type { CmBrainToolDefinition } from "./gemini.js";
import { geminiSimpleChat, getCmBrainMiniModel, getGeminiApiKey } from "./gemini.js";
import { runComplianceCheck } from "../compliance.js";
import {
  CONTENT_BENCHMARK_VIEWS,
  computeBenchmarkTrajectory,
  countLeadCapturesForDate,
  countVideosByStatus,
  countVideosComplianceFlaggedPending,
  ensureDailyTargets,
  getContentVideo,
  getLatestPerformance,
  getOldestPendingReview,
  getPerformanceModel,
  insertBriefing,
  insertCutListItem,
  insertLearningLog,
  listCutList,
  listLeadCaptures,
  listLearningLogs,
  listPendingComplianceQueue,
  listPerformanceDataForDays,
  listPerformanceWithVideosSince,
  getStatusCounts,
  todayDateCst,
  upsertDailyStrategy,
  upsertPerformanceModel,
  updateContentVideo,
  getLatestCompetitiveAnalysis,
  getActiveStrategyRecommendations,
  getLatestYoutubeAnalysis,
  listYoutubeTranscripts,
  listStrategyRecommendations,
  listRecordingTasks,
  insertRecordingTask,
  insertCalendarEvent,
  type CmPerformanceModel,
} from "../../../core/contentDb.js";
import {
  getCalendarDayData,
  getCalendarMonthData,
} from "../calendar.js";
import {
  runFullCompetitiveAnalysis,
} from "../competitiveAnalysis.js";
import { getWeekStart } from "./stats.js";
import { getSprintProgressData } from "../../../core/contentDb.js";

export const CM_BRAIN_TOOL_DEFINITIONS: CmBrainToolDefinition[] = [
  {
    name: "get_performance_data",
    description: "Performance data joined with videos for the last N days.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number", description: "Days to look back, default 7" } },
      required: [],
    },
  },
  {
    name: "get_pipeline_status",
    description: "Content pipeline counts by status and today's publish progress.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_compliance_queue",
    description: "Pending compliance review items with video details.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_lead_captures",
    description: "Lead captures from DMs/comments for the last N days.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number", description: "Days to look back, default 1" } },
      required: [],
    },
  },
  {
    name: "get_learning_history",
    description: "Recent learning log entries from intelligence cycles.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max entries, default 5" } },
      required: [],
    },
  },
  {
    name: "get_performance_model",
    description: "Current running performance model of what content works.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "update_performance_model",
    description: "Update fields on the current performance model.",
    input_schema: {
      type: "object",
      properties: {
        overall_avg_views: { type: "number" },
        benchmark_gap_pct: { type: "number" },
        trending_direction: { type: "string", enum: ["up", "down", "flat"] },
        top_performing_pillar: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "write_learning_log",
    description: "Insert a learning log entry from a cycle.",
    input_schema: {
      type: "object",
      properties: {
        cycle_type: { type: "string" },
        insights: { type: "array", items: { type: "string" } },
        strategy_adjustments: { type: "array", items: { type: "string" } },
        performance_snapshot: { type: "object" },
      },
      required: ["cycle_type", "insights", "strategy_adjustments"],
    },
  },
  {
    name: "set_daily_strategy",
    description: "Upsert today's content strategy.",
    input_schema: {
      type: "object",
      properties: {
        pillar_priority: { type: "array", items: { type: "string" } },
        recommended_hooks: { type: "array", items: { type: "string" } },
        hashtag_set: { type: "array", items: { type: "string" } },
        avoid_angles: { type: "array", items: { type: "string" } },
        platform_distribution: { type: "object" },
        reasoning: { type: "string" },
        confidence_score: { type: "number" },
        date: { type: "string" },
      },
      required: ["pillar_priority", "recommended_hooks", "reasoning"],
    },
  },
  {
    name: "generate_hook_variations",
    description: "Generate 5 alternative hooks in Marco's voice using working patterns.",
    input_schema: {
      type: "object",
      properties: {
        clip_id: { type: "string" },
        original_hook: { type: "string" },
        pillar: { type: "string" },
        context: { type: "string" },
        auto_approve: { type: "boolean" },
      },
      required: ["original_hook", "pillar"],
    },
  },
  {
    name: "generate_caption",
    description: "Generate a social caption in Marco's voice for a platform.",
    input_schema: {
      type: "object",
      properties: {
        pillar: { type: "string" },
        hook: { type: "string" },
        hashtags: { type: "array", items: { type: "string" } },
        platform: { type: "string" },
        context: { type: "string" },
      },
      required: ["pillar", "hook", "platform"],
    },
  },
  {
    name: "flag_underperformer",
    description: "Add a content angle to the cut list.",
    input_schema: {
      type: "object",
      properties: {
        angle_description: { type: "string" },
        reason: { type: "string" },
        avg_views: { type: "number" },
        times_tested: { type: "number" },
      },
      required: ["angle_description", "reason"],
    },
  },
  {
    name: "auto_approve_content",
    description:
      "Auto-approve only if compliance passed, not flagged, and score >= 60. Never approves flagged content.",
    input_schema: {
      type: "object",
      properties: { video_id: { type: "string" } },
      required: ["video_id"],
    },
  },
  {
    name: "trigger_compliance_check",
    description: "Run compliance check on a video.",
    input_schema: {
      type: "object",
      properties: { video_id: { type: "string" } },
      required: ["video_id"],
    },
  },
  {
    name: "send_harvey_briefing",
    description: "Write a briefing for Harvey to read from the database.",
    input_schema: {
      type: "object",
      properties: {
        briefing_type: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        key_metrics: { type: "object" },
        action_items: { type: "array", items: { type: "string" } },
      },
      required: ["briefing_type", "title", "body"],
    },
  },
  {
    name: "get_benchmark_trajectory",
    description: "30-day benchmark trajectory and weekly view trends.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_competitive_analysis",
    description: "Latest competitive analysis with strategy recommendations.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_strategy_recommendations",
    description: "Strategy recommendations filtered by status.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string" },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "get_recording_tasks",
    description: "Recording tasks for upcoming days.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string" },
        days: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "get_calendar_week",
    description: "7-day calendar view with publishing and recording tasks.",
    input_schema: {
      type: "object",
      properties: { week_start: { type: "string" } },
      required: [],
    },
  },
  {
    name: "create_recording_task",
    description: "Add a recording task to Marco's production queue.",
    input_schema: {
      type: "object",
      properties: {
        due_date: { type: "string" },
        pillar: { type: "string" },
        topic: { type: "string" },
        suggested_hooks: { type: "array", items: { type: "string" } },
        filming_notes: { type: "string" },
        reason: { type: "string" },
        priority: { type: "string" },
      },
      required: ["due_date", "pillar", "topic"],
    },
  },
  {
    name: "get_sprint_progress",
    description: "861-video sprint progress and pace.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "run_competitive_analysis",
    description: "Trigger full competitive analysis (Apify + Gemini, 30-60 seconds).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_youtube_insights",
    description:
      "Latest YouTube competitor transcript analysis — hook structures, opening phrases, topics, data points, CTA patterns, content gaps, key insights, and the recommended video idea. Use when Marco asks what competitors are doing on YouTube, what content he's missing, or for a video idea based on competitor research.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_youtube_transcripts_sample",
    description:
      "Recent cached competitor YouTube transcripts (hook + CTA excerpts), optionally filtered by channel. Use to reference specific competitor video content.",
    input_schema: {
      type: "object",
      properties: {
        channel_name: { type: "string" },
        limit: { type: "number" },
      },
      required: [],
    },
  },
];

function parseHookJson(text: string): string[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]) as unknown[];
    return arr.map(String).filter(Boolean);
  } catch {
    return [];
  }
}

export async function executeContentBrainTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  console.log(`[cm-brain/tool] ${toolName}`);
  switch (toolName) {
    case "get_performance_data": {
      const days = Number(input.days) || 7;
      const videos = listPerformanceDataForDays(days);
      const dailyTotals: Record<string, { views: number; count: number }> = {};
      for (const v of videos) {
        const d = v.date || todayDateCst();
        if (!dailyTotals[d]) dailyTotals[d] = { views: 0, count: 0 };
        dailyTotals[d].views += v.views;
        dailyTotals[d].count++;
      }
      return { days, videos, dailyTotals };
    }
    case "get_pipeline_status": {
      const today = todayDateCst();
      const targets = ensureDailyTargets(today);
      const oldest = getOldestPendingReview();
      return {
        statusCounts: getStatusCounts(),
        oldestPendingReview: oldest
          ? { id: oldest.id, createdAt: oldest.createdAt, caption: oldest.caption.slice(0, 80) }
          : null,
        complianceFlaggedPending: countVideosComplianceFlaggedPending(),
        approvedReady: countVideosByStatus("approved"),
        videosPublishedToday: targets.videosPublished,
        videosTarget: targets.videosTarget,
      };
    }
    case "get_compliance_queue": {
      const pending = listPendingComplianceQueue();
      return {
        count: pending.length,
        items: pending.map((p) => ({
          videoId: p.videoId,
          caption: p.caption,
          hook: p.hook,
          pillar: p.title,
          platformTarget: p.platformTarget,
          flaggedReason: p.flaggedReason,
          flaggedAt: p.flaggedAt,
        })),
      };
    }
    case "get_lead_captures": {
      const days = Number(input.days) || 1;
      const since = new Date();
      since.setDate(since.getDate() - days);
      const captures = listLeadCaptures({ limit: 200 }).filter(
        (c) => new Date(c.capturedAt) >= since,
      );
      const byPlatform: Record<string, number> = {};
      let routed = 0;
      for (const c of captures) {
        byPlatform[c.platform] = (byPlatform[c.platform] || 0) + 1;
        if (c.routedToCrm) routed++;
      }
      return {
        days,
        total: captures.length,
        routed,
        notRouted: captures.length - routed,
        byPlatform,
        captures: captures.map((c) => ({
          phoneNumber: c.phoneNumber,
          platform: c.platform,
          capturedAt: c.capturedAt,
          routedToCrm: c.routedToCrm,
        })),
      };
    }
    case "get_learning_history":
      return { entries: listLearningLogs({ limit: Number(input.limit) || 5 }) };
    case "get_performance_model":
      return { model: getPerformanceModel() };
    case "update_performance_model": {
      const patch: Partial<Omit<CmPerformanceModel, "id" | "updatedAt">> = {};
      if (input.overall_avg_views != null) patch.overallAvgViews = Number(input.overall_avg_views);
      if (input.benchmark_gap_pct != null) patch.benchmarkGapPct = Number(input.benchmark_gap_pct);
      if (input.trending_direction) patch.trendingDirection = input.trending_direction as "up" | "down" | "flat";
      if (input.top_performing_pillar) patch.topPerformingPillar = String(input.top_performing_pillar);
      return { model: upsertPerformanceModel(patch) };
    }
    case "write_learning_log": {
      const today = todayDateCst();
      const perf = listPerformanceDataForDays(1);
      const above = perf.filter((p) => p.benchmarkMet).length;
      const below = perf.filter((p) => p.views > 0 && !p.benchmarkMet).length;
      const phones = countLeadCapturesForDate(today);
      const entry = insertLearningLog({
        cycleType: String(input.cycle_type || "manual"),
        date: today,
        insights: Array.isArray(input.insights) ? input.insights.map(String) : [],
        strategyAdjustments: Array.isArray(input.strategy_adjustments)
          ? input.strategy_adjustments.map(String)
          : [],
        performanceSnapshot:
          input.performance_snapshot && typeof input.performance_snapshot === "object"
            ? (input.performance_snapshot as Record<string, unknown>)
            : {},
        videosAboveBenchmark: above,
        videosBelowBenchmark: below,
        phoneNumbersToday: phones,
      });
      return { id: entry.id, loggedAt: entry.loggedAt };
    }
    case "set_daily_strategy": {
      const date = typeof input.date === "string" ? input.date : todayDateCst();
      const strategy = upsertDailyStrategy(date, {
        pillarPriority: Array.isArray(input.pillar_priority)
          ? input.pillar_priority.map(String)
          : ["brand", "education", "listings"],
        recommendedHooks: Array.isArray(input.recommended_hooks)
          ? input.recommended_hooks.map(String)
          : [],
        hashtagSet: Array.isArray(input.hashtag_set) ? input.hashtag_set.map(String) : [],
        avoidAngles: Array.isArray(input.avoid_angles) ? input.avoid_angles.map(String) : [],
        platformDistribution:
          input.platform_distribution && typeof input.platform_distribution === "object"
            ? (input.platform_distribution as Record<string, number>)
            : { tiktok: 4, instagram: 2, facebook: 1 },
        reasoning: String(input.reasoning || ""),
        confidenceScore: Number(input.confidence_score) || 50,
      });
      return strategy;
    }
    case "generate_hook_variations": {
      const model = getPerformanceModel();
      const working = model?.workingHookPatterns ?? [];
      const originalHook = String(input.original_hook || "");
      const pillar = String(input.pillar || "education");
      let variations: string[] = [];
      if (getGeminiApiKey()) {
        const text = await geminiSimpleChat(
          `Write 5 alternative hooks for a ${pillar} real estate video in Marco Puga's voice. Original hook: ${originalHook}. Use these patterns that are currently working above benchmark: ${working.join("; ") || "direct first-person San Antonio real estate"}. Marco's voice rules: direct, first person, contractions, no corporate speak, San Antonio specific, real numbers. Return JSON array of 5 hook strings only.`,
          getCmBrainMiniModel(),
        );
        variations = parseHookJson(text);
      }
      if (variations.length === 0) {
        variations = [
          `${originalHook} — here's what most buyers miss.`,
          `I'm Marco — ${originalHook.toLowerCase()}`,
          `Real talk on ${pillar}: ${originalHook}`,
          `San Antonio buyers: ${originalHook}`,
          `${originalHook} (and what to do next)`,
        ];
      }
      const recommended = variations[0];
      if (input.auto_approve && input.clip_id) {
        updateContentVideo(String(input.clip_id), { hook: recommended });
      }
      return { variations, recommended };
    }
    case "generate_caption": {
      const pillar = String(input.pillar || "");
      const hook = String(input.hook || "");
      const platform = String(input.platform || "tiktok");
      const hashtags = Array.isArray(input.hashtags) ? input.hashtags.map(String) : [];
      if (getGeminiApiKey()) {
        const text = await geminiSimpleChat(
          `Write a social media caption for a ${pillar} real estate video on ${platform} in Marco Puga's voice. Hook: ${hook}. Hashtags to include: ${hashtags.join(" ")}. Max 150 characters for caption body. Return JSON: { "caption": string, "full_post": string }`,
          getCmBrainMiniModel(),
        );
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            return JSON.parse(match[0]);
          } catch { /* fall through */ }
        }
      }
      const caption = hook.slice(0, 150);
      const full = `${caption}\n\n${hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}`;
      return { caption, full_post: full };
    }
    case "flag_underperformer":
      return insertCutListItem({
        contentAngle: String(input.angle_description || ""),
        reason: String(input.reason || ""),
        avgViewsWhenCut: Number(input.avg_views) || 0,
        timesTested: Number(input.times_tested) || 3,
        flaggedBy: "brain",
      });
    case "auto_approve_content": {
      const videoId = String(input.video_id || "");
      const video = getContentVideo(videoId);
      if (!video) return { approved: false, reason: "Video not found" };
      if (video.complianceFlagged) {
        return { approved: false, reason: "Compliance flagged — requires human review" };
      }
      const pending = listPendingComplianceQueue().some((p) => p.videoId === videoId);
      if (pending) return { approved: false, reason: "Pending compliance queue item" };
      if (!video.complianceNotes) {
        return { approved: false, reason: "No compliance check has been run" };
      }
      const perf = getLatestPerformance(videoId);
      const score = perf?.score ?? 0;
      if (score < 60) {
        return { approved: false, reason: `Score ${score} below 60 threshold` };
      }
      updateContentVideo(videoId, {
        status: "approved",
        approvedAt: new Date().toISOString(),
      });
      return { approved: true };
    }
    case "trigger_compliance_check": {
      const videoId = String(input.video_id || "");
      const result = await runComplianceCheck(videoId);
      return {
        passed: result.passed,
        flags: result.flags,
        brand_issues: result.brand_issues,
        recommendation: result.recommendation,
      };
    }
    case "send_harvey_briefing":
      return insertBriefing({
        briefingType: String(input.briefing_type || "escalation"),
        title: String(input.title || ""),
        body: String(input.body || ""),
        keyMetrics:
          input.key_metrics && typeof input.key_metrics === "object"
            ? (input.key_metrics as Record<string, unknown>)
            : {},
        actionItems: Array.isArray(input.action_items) ? input.action_items.map(String) : [],
        sentToHarvey: true,
      });
    case "get_benchmark_trajectory":
      return computeBenchmarkTrajectory();
    case "get_competitive_analysis": {
      const analysis = getLatestCompetitiveAnalysis();
      const recommendations = analysis
        ? listStrategyRecommendations({ analysisId: analysis.id, limit: 10 })
        : [];
      return { analysis, recommendations };
    }
    case "get_strategy_recommendations": {
      const status = input.status ? String(input.status) : undefined;
      const limit = Number(input.limit) || 10;
      if (status) {
        return { recommendations: listStrategyRecommendations({ status, limit }) };
      }
      return { recommendations: getActiveStrategyRecommendations().slice(0, limit) };
    }
    case "get_recording_tasks": {
      const days = Number(input.days) || 14;
      const status = input.status ? String(input.status) : "pending";
      const today = todayDateCst();
      const end = new Date(`${today}T12:00:00`);
      end.setDate(end.getDate() + days);
      const endStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(end);
      return {
        tasks: listRecordingTasks({
          status,
          dueAfter: today,
          dueBefore: endStr,
          limit: 50,
        }),
      };
    }
    case "get_calendar_week": {
      const weekStart = input.week_start ? String(input.week_start) : getWeekStart();
      const days: unknown[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(`${weekStart}T12:00:00`);
        d.setDate(d.getDate() + i);
        const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
        days.push(getCalendarDayData(dateStr));
      }
      return { week_start: weekStart, days };
    }
    case "create_recording_task": {
      const dueDate = String(input.due_date || todayDateCst());
      const hooks = Array.isArray(input.suggested_hooks)
        ? input.suggested_hooks.map(String)
        : [String(input.topic || "")];
      const task = insertRecordingTask({
        dueDate,
        pillar: String(input.pillar || "brand"),
        hookType: null,
        topic: String(input.topic || ""),
        suggestedHooks: hooks,
        suggestedDurationMin: 35,
        suggestedDurationMax: 55,
        filmingNotes: input.filming_notes ? String(input.filming_notes) : null,
        reason: input.reason ? String(input.reason) : null,
        source: "brain",
        priority: input.priority ? String(input.priority) : "normal",
        strategyRecommendationId: null,
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
      return { task };
    }
    case "get_sprint_progress":
      return getSprintProgressData();
    case "run_competitive_analysis": {
      const { contentManagerBrain } = await import("./index.js");
      return {
        message: "Competitive analysis running — this calls Apify and may take 30-60 seconds.",
        analysis: await runFullCompetitiveAnalysis(contentManagerBrain),
      };
    }
    case "get_youtube_insights": {
      const analysis = getLatestYoutubeAnalysis();
      if (!analysis) {
        return {
          analysis: null,
          message:
            "No YouTube analysis yet. It runs automatically on Sunday nights or can be triggered manually.",
        };
      }
      const daysSince = Math.floor(
        (Date.now() - new Date(analysis.analyzedAt).getTime()) / (1000 * 60 * 60 * 24),
      );
      return {
        analyzed_at: analysis.analyzedAt,
        videos_analyzed: analysis.videosAnalyzed,
        channels_analyzed: analysis.channelsAnalyzed,
        top_hook_structures: analysis.topHookStructures,
        top_opening_phrases: analysis.topOpeningPhrases,
        top_topics: analysis.topTopics,
        top_data_points: analysis.topDataPoints,
        top_cta_patterns: analysis.topCtaPatterns,
        content_gaps: analysis.contentGaps,
        key_insights: analysis.keyInsights,
        top_recommended_video_idea: analysis.topRecommendedVideoIdea,
        days_since_analysis: daysSince,
      };
    }
    case "get_youtube_transcripts_sample": {
      const channelName = input.channel_name ? String(input.channel_name) : undefined;
      const limit = Number(input.limit) || 10;
      const transcripts = listYoutubeTranscripts({ channelName, limit });
      return {
        count: transcripts.length,
        transcripts: transcripts.map((t) => ({
          video_id: t.videoId,
          video_title: t.videoTitle,
          channel_name: t.channelName,
          view_count: t.viewCount,
          hook_text: t.hookText,
          cta_text: t.ctaText,
          word_count: t.wordCount,
          fetched_at: t.fetchedAt,
        })),
      };
    }
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

export { computeBenchmarkTrajectory };
