/**
 * Content Manager Brain — four daily intelligence cycles.
 */
import { runPerformanceSync } from "../analytics.js";
import type { ContentManagerBrain } from "./index.js";
import { claudeContent, CONTENT_MODELS, logContentAiFailure } from "../../../integrations/claude-content.js";
import {
  CONTENT_BENCHMARK_VIEWS,
  countLeadCapturesForDate,
  countVideosByStatus,
  countVideosPublishedOnDate,
  ensureDailyTargets,
  getDailyStrategy,
  getDailyTargets,
  getPerformanceModel,
  getActiveStrategyRecommendations,
  getSeasonalWeek,
  insertBriefing,
  insertCutListItem,
  insertLearningLog,
  insertSelfEvaluation,
  insertStrategyAccuracy,
  listConsistentlyBelowBenchmarkVideos,
  listCutList,
  listDailyTargetsLastDays,
  listHookLibrary,
  listLearningLogs,
  listPerformanceWithVideosSince,
  listPendingComplianceQueue,
  listStrategyAccuracy,
  listVideosForWeekNumber,
  listVideosPublishedOnDate,
  recalculatePerformanceModelFromData,
  seasonLabelForWeek,
  todayDateCst,
  upsertDailyStrategy,
  upsertHashtagPerformance,
  upsertHookLibraryEntry,
  upsertPerformanceModel,
  upsertPostingTimeMatrix,
  upsertSeasonalWeek,
  yesterdayDateCst,
} from "../../../core/contentDb.js";
import { getDecayWeight } from "./decay.js";
import { classifyAndUpdateHookLibrary, getHookTypePerformanceSummary } from "./hookClassifier.js";
import { getTopCombinations, getWorstCombinations, updateCombinationPatterns } from "./patterns.js";
import { evaluateCurrentExperiment, proposeWeeklyExperiment } from "./experiments.js";
import { getMomentumStrategyAdjustment, updateMomentumState } from "./momentum.js";
import { generateWeeklyRecordingPlan } from "../calendar.js";
import { runFullCompetitiveAnalysis } from "../competitiveAnalysis.js";
import { runYouTubeCompetitorAnalysis } from "../youtubeIntel.js";
import { runRedditIntel } from "../redditIntel.js";
import {
  countOverdueRecordingTasks,
  countPendingRecordingTasksDueBefore,
} from "../../../core/contentDb.js";
import { getCalibrationAwarePromptSuffix } from "./prompts.js";
import {
  getCurrentWeekNumber,
  getWeekStart,
  gradeFromOutcomeScore,
  isMonday,
  isSunday,
  pearsonCorrelation,
} from "./stats.js";

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

function tomorrowDateCst(): string {
  const today = todayDateCst();
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() + 1);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
}

function gradeYesterdayStrategy(yesterday: string): {
  grade: string | null;
  outcomeScore: number | null;
  gradePrompt: string;
} {
  const strategy = getDailyStrategy(yesterday);
  if (!strategy) {
    return { grade: null, outcomeScore: null, gradePrompt: "" };
  }

  const videos = listVideosPublishedOnDate(yesterday);
  if (videos.length < 2) {
    return { grade: null, outcomeScore: null, gradePrompt: "" };
  }

  const pillarAvgs: Record<string, { sum: number; count: number }> = {};
  for (const v of videos) {
    const p = v.pillar || "brand";
    if (!pillarAvgs[p]) pillarAvgs[p] = { sum: 0, count: 0 };
    pillarAvgs[p].sum += v.views;
    pillarAvgs[p].count++;
  }
  const actualTopPillar = Object.entries(pillarAvgs).sort(
    (a, b) => b[1].sum / b[1].count - a[1].sum / a[1].count,
  )[0]?.[0] ?? null;

  const recommendedTop = strategy.pillarPriority[0] ?? null;
  const pillarCorrect = recommendedTop === actualTopPillar;

  const hooksThatBeat: string[] = [];
  for (const rec of strategy.recommendedHooks) {
    const recLower = rec.toLowerCase();
    const matched = videos.some(
      (v) =>
        v.views >= CONTENT_BENCHMARK_VIEWS &&
        v.hook &&
        (v.hook.toLowerCase().includes(recLower.slice(0, 20)) ||
          recLower.includes(v.hook.toLowerCase().slice(0, 20))),
    );
    if (matched) hooksThatBeat.push(rec);
  }

  const avgViewsYesterday = videos.reduce((s, v) => s + v.views, 0) / videos.length;
  let outcomeScore = 0;
  if (pillarCorrect) outcomeScore += 40;
  const hookPoints = Math.min(40, hooksThatBeat.length * 20);
  outcomeScore += hookPoints;
  if (avgViewsYesterday >= CONTENT_BENCHMARK_VIEWS) {
    outcomeScore += Math.min(20, ((avgViewsYesterday - CONTENT_BENCHMARK_VIEWS) / CONTENT_BENCHMARK_VIEWS) * 20);
  } else {
    outcomeScore = Math.max(
      0,
      outcomeScore - ((CONTENT_BENCHMARK_VIEWS - avgViewsYesterday) / CONTENT_BENCHMARK_VIEWS) * 20,
    );
  }
  outcomeScore = Math.min(100, Math.round(outcomeScore));

  const grade = gradeFromOutcomeScore(outcomeScore);
  const hooksHitRate =
    strategy.recommendedHooks.length > 0 ? hooksThatBeat.length / strategy.recommendedHooks.length : 0;

  insertStrategyAccuracy({
    strategyDate: yesterday,
    recommendedTopPillar: recommendedTop,
    actualTopPillar,
    recommendedHooks: strategy.recommendedHooks,
    hooksThatBeatBenchmark: hooksThatBeat,
    confidenceScoreGiven: strategy.confidenceScore,
    outcomeScore,
    pillarPredictionCorrect: pillarCorrect,
    hooksHitRate,
    overallGrade: grade,
    evaluatedAt: new Date().toISOString(),
  });

  upsertPerformanceModel({ selfGradeLastWeek: grade });

  let gradePrompt = `Yesterday's strategy received a grade of ${grade} (${outcomeScore}/100). `;
  if (grade === "C" || grade === "D" || grade === "F") {
    gradePrompt += "Your recommendations underperformed. Adjust your approach significantly today.";
  } else {
    gradePrompt += "Your recommendations performed well. Build on what worked.";
  }

  return { grade, outcomeScore, gradePrompt };
}

function buildSeasonalityContext(): { text: string; logNote: string } {
  const weekNumber = getCurrentWeekNumber();
  const seasonal = getSeasonalWeek(weekNumber);
  const historical = listVideosForWeekNumber(weekNumber);
  const sampleCount = historical.length;
  const multiplier = seasonal?.performanceMultiplier ?? 1;
  const label = seasonal?.seasonLabel ?? seasonLabelForWeek(weekNumber);

  let text = `Current seasonal multiplier: ${multiplier} (${label}). `;
  if (sampleCount >= 5) {
    if (multiplier > 1.1) {
      text +=
        "Historically this is a strong week for views. Increase Brand content to capture peak buyer intent.";
    } else if (multiplier < 0.9) {
      text +=
        "Historically this is a slower week. Focus on Education content for algorithm favor and reduce posting expectations slightly.";
    }
  } else {
    text += "Seasonality data still accumulating — multiplier held near 1.0.";
  }

  const logNote = `[cm-brain] Seasonality model: ${sampleCount} historical data points for week ${weekNumber} — ${sampleCount < 5 ? "accumulating data" : "multiplier active"}`;
  return { text, logNote };
}

function updateSeasonalityModel(): void {
  const weekNumber = getCurrentWeekNumber();
  const historical = listVideosForWeekNumber(weekNumber);
  if (historical.length < 3) return;

  const historicalAvg =
    historical.reduce((s, v) => s + v.views, 0) / historical.length;
  const model = getPerformanceModel();
  const overallAvg = model.overallAvgViews || 0;
  const multiplier =
    overallAvg > 0 ? Math.round((historicalAvg / overallAvg) * 100) / 100 : 1;

  upsertSeasonalWeek({
    weekNumber,
    historicalAvgViews: historicalAvg,
    performanceMultiplier: multiplier,
    seasonLabel: seasonLabelForWeek(weekNumber),
  });
  upsertPerformanceModel({ seasonMultiplier: multiplier });
}

export async function runMorningCycle(brain: ContentManagerBrain): Promise<void> {
  // Refresh Reddit buyer-question signals once daily (cached; non-blocking —
  // a failure must never break the morning cycle).
  runRedditIntel().catch((err) =>
    console.warn(`[cm-brain] reddit intel refresh skipped: ${err instanceof Error ? err.message : String(err)}`),
  );

  const date = todayDateCst();
  const yesterday = yesterdayDateCst();
  const yesterdayTargets = getDailyTargets(yesterday);
  const recentLogs = listLearningLogs({ limit: 3 });
  let model = getPerformanceModel();
  const pendingReview = countVideosByStatus("pending_review");
  ensureDailyTargets(date);

  const { gradePrompt } = gradeYesterdayStrategy(yesterday);
  const momentum = updateMomentumState();
  model = getPerformanceModel();

  const calibrationSuffix = getCalibrationAwarePromptSuffix(model.calibrationScore);
  const topCombinations = getTopCombinations(5);
  const worstCombinations = getWorstCombinations(3);
  const hookTypeSummary = getHookTypePerformanceSummary();
  const { text: seasonalityText, logNote: seasonLog } = buildSeasonalityContext();
  const momentumAdjustment = getMomentumStrategyAdjustment(momentum.streakType, momentum.streakCount);

  if (isMonday()) {
    await proposeWeeklyExperiment(brain);
  }

  const strategyPrompt = `It is ${date}. Generate today's content strategy.
${gradePrompt}
${momentumAdjustment}
${seasonalityText}
${calibrationSuffix}
Top combination patterns: ${JSON.stringify(topCombinations)}
Combinations to avoid: ${JSON.stringify(worstCombinations)}
Hook type performance: ${JSON.stringify(hookTypeSummary)}
Yesterday's performance: ${JSON.stringify(yesterdayTargets)}
Recent learning: ${JSON.stringify(recentLogs)}
Performance model: ${JSON.stringify(model)}
Generate pillar_priority, recommended_hooks (3), hashtag_set, platform_distribution, avoid_angles, reasoning, confidence_score (0-100). Return JSON only: { "pillar_priority": string[], "recommended_hooks": string[], "hashtag_set": string[], "avoid_angles": string[], "platform_distribution": object, "reasoning": string, "confidence_score": number }`;

  let strategyRaw = "";
  try {
    const response = await claudeContent.messages.create({
      model: CONTENT_MODELS.QUALITY,
      max_tokens: 1024,
      system: "Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON object.",
      messages: [{ role: "user", content: strategyPrompt }],
    });
    strategyRaw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
  } catch (err) {
    logContentAiFailure("morning strategy", err);
  }
  const parsed = parseJsonFromText<{
    pillar_priority: string[];
    recommended_hooks: string[];
    hashtag_set: string[];
    avoid_angles: string[];
    platform_distribution: Record<string, number>;
    reasoning: string;
    confidence_score: number;
  }>(strategyRaw);

  const strategy = upsertDailyStrategy(date, {
    pillarPriority: parsed?.pillar_priority ?? ["brand", "education", "listings"],
    recommendedHooks: parsed?.recommended_hooks ?? [
      "What San Antonio buyers need to know this week",
      "I just showed a home that surprised everyone",
      "Here's the real number on rates right now",
    ],
    hashtagSet: parsed?.hashtag_set ?? ["sanantonio", "sanantoniorealestate", "marcoPuga"],
    avoidAngles: parsed?.avoid_angles ?? [],
    platformDistribution: parsed?.platform_distribution ?? { tiktok: 4, instagram: 2, facebook: 1 },
    reasoning: parsed?.reasoning ?? strategyRaw.slice(0, 500),
    confidenceScore: parsed?.confidence_score ?? 40,
  });

  const experimentNote = isMonday() ? " Experiment proposed for this week — see cm_experiments." : "";
  let briefingRaw = "";
  try {
    const response = await claudeContent.messages.create({
      model: CONTENT_MODELS.QUALITY,
      max_tokens: 500,
      system: "Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON object.",
      messages: [{
        role: "user",
        content: `Write a morning briefing for Harvey. Strategy: ${JSON.stringify(strategy)}. Pipeline pending review: ${pendingReview}. Momentum: ${momentum.streakType} (${momentum.streakCount}).${experimentNote} Return JSON: { "body": string (3-4 sentences), "action_items": string[] }`,
      }],
    });
    briefingRaw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
  } catch (err) {
    logContentAiFailure("morning briefing", err);
  }
  const briefingParsed = parseJsonFromText<{ body: string; action_items: string[] }>(briefingRaw);

  let recordingPlanNote = "";
  if (isMonday()) {
    try {
      const weekStart = getWeekStart();
      const tasks = await generateWeeklyRecordingPlan(weekStart, brain);
      const first = tasks[0];
      recordingPlanNote = `Recording plan for the week: ${tasks.length} sessions planned, ${tasks.length * 2} clips targeted. First session due: ${first?.dueDate ?? "n/a"} — ${first?.topic ?? "see calendar"}.`;
    } catch (err) {
      console.error("[cm-brain] Weekly recording plan failed:", err);
    }
  }

  const overdueCount = countOverdueRecordingTasks(date);
  let overdueNote = "";
  if (overdueCount > 0) {
    const overdueTasks = countPendingRecordingTasksDueBefore(date);
    overdueNote = `OVERDUE RECORDING TASKS: ${overdueCount} tasks are past due. Pipeline will be short ${overdueCount} videos if not filmed today.`;
  }

  const briefingBody =
    (briefingParsed?.body ??
      `Yesterday: ${yesterdayTargets.videosPublished}/${yesterdayTargets.videosTarget} videos, ${yesterdayTargets.phoneNumbersCaptured}/${yesterdayTargets.phoneNumbersTarget} phone numbers. Today prioritize ${strategy.pillarPriority[0] ?? "brand"}. ${pendingReview} clips awaiting review.`) +
    (recordingPlanNote ? ` ${recordingPlanNote}` : "") +
    (overdueNote ? ` ${overdueNote}` : "");

  insertBriefing({
    briefingType: "morning",
    title: `Content Manager — Morning Briefing ${date}`,
    body: briefingBody,
    keyMetrics: {
      yesterday_videos: yesterdayTargets.videosPublished,
      yesterday_phones: yesterdayTargets.phoneNumbersCaptured,
      pending_review_count: pendingReview,
      today_strategy_confidence: strategy.confidenceScore,
      streak_type: momentum.streakType,
    },
    actionItems: briefingParsed?.action_items ?? (pendingReview > 0 ? ["Clear review queue before noon"] : []),
    sentToHarvey: true,
  });

  console.log(
    `[cm-brain] Morning cycle complete for ${date} — strategy confidence ${strategy.confidenceScore}/100, ${pendingReview} clips waiting for review. ${seasonLog}`,
  );
}

export async function runMiddayCycle(brain: ContentManagerBrain): Promise<void> {
  const today = todayDateCst();
  const targets = ensureDailyTargets(today);
  const pendingCompliance = listPendingComplianceQueue().length;
  const behindPace = targets.videosPublished < 3;
  const bottleneck = pendingCompliance > 3;
  const leadUnder = targets.phoneNumbersCaptured < 8;

  if (behindPace || bottleneck || leadUnder) {
    let alertRaw = "";
    try {
      const response = await claudeContent.messages.create({
        model: CONTENT_MODELS.QUALITY,
        max_tokens: 300,
        messages: [{
          role: "user",
          content: `Midday alert needed. Videos published: ${targets.videosPublished}/7. Compliance queue: ${pendingCompliance}. Phone numbers: ${targets.phoneNumbersCaptured}/22. Write a 2-3 sentence escalation for Harvey.`,
        }],
      });
      alertRaw = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
    } catch (err) {
      logContentAiFailure("midday alert", err);
    }
    if (!alertRaw) {
      alertRaw = `Midday check: ${targets.videosPublished}/7 videos published, ${pendingCompliance} items in compliance queue, ${targets.phoneNumbersCaptured}/22 phone numbers captured. Needs attention.`;
    }
    insertBriefing({
      briefingType: "escalation",
      title: `Content Manager — Midday Alert ${today}`,
      body: alertRaw,
      keyMetrics: {
        videos_published: targets.videosPublished,
        compliance_pending: pendingCompliance,
        phone_numbers: targets.phoneNumbersCaptured,
      },
      actionItems: [
        behindPace ? "Accelerate publishing to hit 7 videos today" : "",
        bottleneck ? "Clear compliance review queue in next 2 hours" : "",
        leadUnder ? "Focus DM triage for phone capture" : "",
      ].filter(Boolean),
      sentToHarvey: true,
    });
    console.log(
      `[cm-brain] Midday escalation — ${targets.videosPublished}/7 videos, ${pendingCompliance} compliance items`,
    );
  } else {
    console.log(
      `[cm-brain] Midday check — ${targets.videosPublished}/7 videos, ${targets.phoneNumbersCaptured}/22 numbers. On track.`,
    );
  }
}

export async function runEveningCycle(brain: ContentManagerBrain): Promise<void> {
  const today = todayDateCst();
  await runPerformanceSync();

  const freshData = listPerformanceWithVideosSince(24);
  for (const { video, performance } of freshData) {
    if (video.hook) {
      upsertHookLibraryEntry({
        hookText: video.hook,
        contentPillar: video.pillar,
        views: performance.views,
        aboveBenchmark: performance.benchmarkMet,
      });
    }
    for (const tag of video.hashtags) {
      upsertHashtagPerformance({
        hashtag: tag,
        views: performance.views,
        aboveBenchmark: performance.benchmarkMet,
      });
    }
    if (video.publishedAt) {
      const dw = getDecayWeight(video.publishedAt);
      upsertPostingTimeMatrix({
        publishedAt: video.publishedAt,
        views: performance.views * dw,
      });
    }
  }

  const classified = classifyAndUpdateHookLibrary();
  const patternsUpdated = updateCombinationPatterns();

  const topHooks = listHookLibrary({ minUses: 1, limit: 10, order: "desc" });
  const hookTypeSummary = getHookTypePerformanceSummary();
  const topCombinations = getTopCombinations(5);
  const learningPrompt = `Here is today's performance data (${freshData.length} videos updated). Top hooks: ${JSON.stringify(topHooks)}. Hook type summary: ${JSON.stringify(hookTypeSummary)}. Top combinations: ${JSON.stringify(topCombinations)}. Generate 3-5 data-backed insights and 1-3 strategy adjustments for tomorrow. Return JSON: { "insights": string[], "strategy_adjustments": string[] }`;
  let learningRaw = "";
  try {
    const response = await claudeContent.messages.create({
      model: CONTENT_MODELS.QUALITY,
      max_tokens: 700,
      system: "Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON object.",
      messages: [{ role: "user", content: learningPrompt }],
    });
    learningRaw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
  } catch (err) {
    logContentAiFailure("evening insights", err);
  }
  const learning = parseJsonFromText<{ insights: string[]; strategy_adjustments: string[] }>(learningRaw);

  const insights = learning?.insights ?? ["Insufficient data for strong patterns today — maintain volume focus."];
  const adjustments = learning?.strategy_adjustments ?? ["Keep 7-video daily target."];

  const above = freshData.filter((d) => d.performance.benchmarkMet).length;
  const below = freshData.filter((d) => !d.performance.benchmarkMet && d.performance.views > 0).length;

  insertLearningLog({
    cycleType: "evening",
    date: today,
    insights,
    strategyAdjustments: adjustments,
    performanceSnapshot: {
      videosUpdated: freshData.length,
      videosPublished: ensureDailyTargets(today).videosPublished,
      hooksClassified: classified,
      patternsUpdated,
    },
    videosAboveBenchmark: above,
    videosBelowBenchmark: below,
    phoneNumbersToday: countLeadCapturesForDate(today),
  });

  recalculatePerformanceModelFromData();
  updateMomentumState();
  updateSeasonalityModel();

  let cutAdditions = 0;
  const underperformers = listConsistentlyBelowBenchmarkVideos();
  for (const item of underperformers) {
    const exists = listCutList().some((c) => c.contentAngle.includes(item.title.slice(0, 40)));
    if (exists) continue;
    if (item.latestViews < 3000 && item.consecutiveColdPulls >= 3) {
      let evalRaw = "";
      try {
        const response = await claudeContent.messages.create({
          model: CONTENT_MODELS.FAST,
          max_tokens: 200,
          system: "Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON object.",
          messages: [{
            role: "user",
            content: `Video "${item.title}" averaged ${item.latestViews} views across ${item.consecutiveColdPulls} cold pulls (benchmark 6006). Should we cut this angle? Reply JSON: { "cut": boolean, "reason": string }`,
          }],
        });
        evalRaw = response.content
          .filter((b) => b.type === "text")
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("");
      } catch (err) {
        logContentAiFailure("cut-angle decision", err);
      }
      const evalParsed = parseJsonFromText<{ cut: boolean; reason: string }>(evalRaw);
      if (evalParsed?.cut) {
        insertCutListItem({
          contentAngle: item.title,
          reason: evalParsed.reason || "Consistently below 50% of benchmark",
          avgViewsWhenCut: item.latestViews,
          timesTested: item.consecutiveColdPulls,
          flaggedBy: "brain",
          benchmarkAtCut: CONTENT_BENCHMARK_VIEWS,
        });
        cutAdditions++;
      }
    }
  }

  console.log(
    `[cm-brain] Evening cycle complete — performance model updated, ${insights.length} insights logged, ${classified} hooks classified, ${patternsUpdated} patterns updated, ${cutAdditions} angles flagged for cutting`,
  );
}

export async function runNightCycle(brain: ContentManagerBrain): Promise<void> {
  const today = todayDateCst();
  const logs = listLearningLogs({ limit: 28, days: 7 });
  let model = getPerformanceModel();
  const topHooks = listHookLibrary({ minUses: 1, limit: 10, order: "desc" });
  const bottomHooks = listHookLibrary({ minUses: 3, limit: 10, order: "asc" });
  const cutList = listCutList();

  const accuracyRecords = listStrategyAccuracy(14);
  let calibrationNote = "";
  if (accuracyRecords.length >= 5) {
    const xs = accuracyRecords.map((r) => r.confidenceScoreGiven);
    const ys = accuracyRecords.map((r) => r.outcomeScore);
    const calibration = pearsonCorrelation(xs, ys);
    upsertPerformanceModel({ calibrationScore: calibration });
    model = getPerformanceModel();
    calibrationNote = `Your current confidence calibration score is ${calibration.toFixed(2)} (1.0 = perfect, 0 = no correlation between your confidence and accuracy). `;
    if (calibration < 0.3) {
      calibrationNote +=
        "Your confidence scores are poorly calibrated — you need to be more conservative or more aggressive with them.";
    } else if (calibration <= 0.7) {
      calibrationNote += "Moderate calibration. Your confidence scores are somewhat predictive.";
    } else {
      calibrationNote += "Good calibration. Your stated confidence is a reliable predictor of accuracy.";
    }
  }

  const analysisPrompt = `Nightly deep analysis. ${calibrationNote}
Learning logs: ${JSON.stringify(logs.slice(0, 7))}. Performance model: ${JSON.stringify(model)}. Top hooks: ${JSON.stringify(topHooks)}. Bottom hooks: ${JSON.stringify(bottomHooks)}. Cut list: ${JSON.stringify(cutList)}. Return JSON: { "trend_assessment": string, "top_pillar": string, "biggest_opportunity": string, "biggest_risk": string, "tomorrow_priority": string, "weekly_summary": string }`;
  let analysisRaw = "";
  try {
    const response = await claudeContent.messages.create({
      model: CONTENT_MODELS.QUALITY,
      max_tokens: 900,
      system: "Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON object.",
      messages: [{ role: "user", content: analysisPrompt }],
    });
    analysisRaw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
  } catch (err) {
    logContentAiFailure("nightly deep analysis", err);
  }
  const analysis = parseJsonFromText<{
    trend_assessment: string;
    top_pillar: string;
    biggest_opportunity: string;
    biggest_risk: string;
    tomorrow_priority: string;
    weekly_summary: string;
  }>(analysisRaw);

  const tomorrow = tomorrowDateCst();
  let prelimRaw = "";
  try {
    const response = await claudeContent.messages.create({
      model: CONTENT_MODELS.QUALITY,
      max_tokens: 900,
      system: "Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON object.",
      messages: [{
        role: "user",
        content: `Based on this analysis: ${JSON.stringify(analysis)}. Generate tomorrow's preliminary strategy JSON with pillar_priority, recommended_hooks, hashtag_set, avoid_angles, platform_distribution, reasoning, confidence_score (low, 20-40).`,
      }],
    });
    prelimRaw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
  } catch (err) {
    logContentAiFailure("preliminary strategy", err);
  }
  const prelim = parseJsonFromText<{
    pillar_priority: string[];
    recommended_hooks: string[];
    hashtag_set: string[];
    avoid_angles: string[];
    platform_distribution: Record<string, number>;
    reasoning: string;
    confidence_score: number;
  }>(prelimRaw);

  upsertDailyStrategy(tomorrow, {
    pillarPriority: prelim?.pillar_priority ?? ["brand", "education", "listings"],
    recommendedHooks: prelim?.recommended_hooks ?? [],
    hashtagSet: prelim?.hashtag_set ?? [],
    avoidAngles: prelim?.avoid_angles ?? [],
    platformDistribution: prelim?.platform_distribution ?? { tiktok: 4, instagram: 2, facebook: 1 },
    reasoning: prelim?.reasoning ?? analysis?.tomorrow_priority ?? "Preliminary strategy from night cycle.",
    confidenceScore: prelim?.confidence_score ?? 30,
  });

  let weeklyEvalNote = "";

  if (isSunday()) {
    try {
      const compAnalysis = await runFullCompetitiveAnalysis(brain);
      const aboveBelow = compAnalysis.marcoVsFieldPct >= 0 ? "above" : "below";
      const recCount = compAnalysis.marcoGaps.length;
      console.log(
        `[cm-brain] Competitive analysis complete — Marco ${aboveBelow} field by ${compAnalysis.marcoVsFieldPct.toFixed(1)}%, strategy recommendations generated, recording tasks created`,
      );
      const compNote = `Competitive analysis: Marco is ${Math.abs(compAnalysis.marcoVsFieldPct).toFixed(0)}% ${aboveBelow} competitor average. Top gap: ${compAnalysis.marcoGaps[0] ?? "n/a"}. Top recommendation: ${getActiveStrategyRecommendations()[0]?.recommendation ?? "see strategy panel"}.`;
      insertBriefing({
        briefingType: "weekly",
        title: `Content Manager — Competitive Analysis ${today}`,
        body: compNote,
        keyMetrics: {
          marco_vs_field_pct: compAnalysis.marcoVsFieldPct,
          top_competitor: compAnalysis.topCompetitorHandle,
        },
        actionItems: compAnalysis.marcoGaps.slice(0, 2),
        sentToHarvey: true,
      });
    } catch (err) {
      console.error("[cm-brain] Sunday competitive analysis failed:", err);
    }

    // SUNDAY NIGHT — YouTube competitor transcript analysis (non-blocking)
    try {
      console.log("[cm-brain] Running YouTube competitor transcript analysis...");
      const youtubeAnalysis = await runYouTubeCompetitorAnalysis(brain);
      if (youtubeAnalysis) {
        console.log(
          `[cm-brain] YouTube analysis complete — ${youtubeAnalysis.videosAnalyzed} videos, ${youtubeAnalysis.channelsAnalyzed} channels`,
        );
        if (youtubeAnalysis.contentGaps.length) {
          insertBriefing({
            briefingType: "weekly",
            title: `Content Manager — YouTube Intelligence ${today}`,
            body: `YouTube Intelligence: Analyzed ${youtubeAnalysis.videosAnalyzed} competitor videos across ${youtubeAnalysis.channelsAnalyzed} channels. Top content gap: ${youtubeAnalysis.contentGaps[0]}. Recommended video idea: ${youtubeAnalysis.topRecommendedVideoIdea.slice(0, 150)}`,
            keyMetrics: {
              videos_analyzed: youtubeAnalysis.videosAnalyzed,
              channels_analyzed: youtubeAnalysis.channelsAnalyzed,
            },
            actionItems: youtubeAnalysis.contentGaps.slice(0, 2),
            sentToHarvey: true,
          });
        }
      }
    } catch (youtubeErr) {
      const msg = youtubeErr instanceof Error ? youtubeErr.message : String(youtubeErr);
      console.warn(`[cm-brain] YouTube analysis failed (non-blocking): ${msg}`);
    }

    await evaluateCurrentExperiment(brain);

    const weekStart = getWeekStart();
    const weekAccuracy = listStrategyAccuracy(7);
    let strategiesFollowed = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(`${weekStart}T12:00:00`);
      d.setDate(d.getDate() + i);
      const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
      if (countVideosPublishedOnDate(dateStr) >= 2) strategiesFollowed++;
    }
    const strategiesIgnored = 7 - strategiesFollowed;
    const avgOutcome =
      weekAccuracy.length > 0
        ? weekAccuracy.reduce((s, r) => s + r.outcomeScore, 0) / weekAccuracy.length
        : 0;
    const topInsights = logs.slice(0, 3).flatMap((l) => l.insights);

    let evalRaw = "";
    try {
      const response = await claudeContent.messages.create({
        model: CONTENT_MODELS.QUALITY,
        max_tokens: 800,
        system: "Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON object.",
        messages: [{
          role: "user",
          content: `Write your weekly self-evaluation for the week of ${weekStart}. Data: strategies followed ${strategiesFollowed}/7, average outcome score ${avgOutcome.toFixed(0)}/100, calibration score ${model.calibrationScore ?? "n/a"}, top insights this week: ${JSON.stringify(topInsights)}. Answer: (1) What did you get right? (2) What did you get wrong? (3) One change going forward? (4) 6006 benchmark trajectory? Return JSON only: { "what_worked": string, "what_failed": string, "one_change": string, "benchmark_assessment": string, "calibration_score": number }`,
        }],
      });
      evalRaw = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
    } catch (err) {
      logContentAiFailure("weekly self-evaluation", err);
    }
    const evalParsed = parseJsonFromText<{
      what_worked: string;
      what_failed: string;
      one_change: string;
      benchmark_assessment: string;
      calibration_score: number;
    }>(evalRaw);

    if (evalParsed) {
      const grade = gradeFromOutcomeScore(avgOutcome);
      insertSelfEvaluation({
        weekStart,
        strategiesFollowed,
        strategiesIgnored,
        avgOutcomeScore: avgOutcome,
        whatWorked: evalParsed.what_worked,
        whatFailed: evalParsed.what_failed,
        oneChange: evalParsed.one_change,
        calibrationScore: evalParsed.calibration_score ?? model.calibrationScore,
        benchmarkAssessment: evalParsed.benchmark_assessment,
      });
      upsertPerformanceModel({ selfGradeLastWeek: grade });
      weeklyEvalNote = `Weekly self-evaluation complete. Grade: ${grade}. ${evalParsed.one_change.slice(0, 120)}. Benchmark trajectory: ${evalParsed.benchmark_assessment.slice(0, 120)}.`;
    }
  }

  insertBriefing({
    briefingType: "evening",
    title: `Content Manager — Evening Briefing ${today}`,
    body:
      weeklyEvalNote ||
      analysis?.weekly_summary ||
      analysis?.trend_assessment ||
      "Night cycle complete. Review tomorrow's preliminary strategy in the morning.",
    keyMetrics: {
      top_pillar: analysis?.top_pillar,
      biggest_opportunity: analysis?.biggest_opportunity,
      biggest_risk: analysis?.biggest_risk,
      tomorrow_priority: analysis?.tomorrow_priority,
      calibration_score: model.calibrationScore,
    },
    actionItems: analysis?.tomorrow_priority ? [analysis.tomorrow_priority] : [],
    sentToHarvey: true,
  });

  if (isSunday()) {
    const weekTargets = listDailyTargetsLastDays(7);
    const totalVideos = weekTargets.reduce((s, t) => s + t.videosPublished, 0);
    const totalPhones = weekTargets.reduce((s, t) => s + t.phoneNumbersCaptured, 0);
    let weeklyRaw = "";
    try {
      const response = await claudeContent.messages.create({
        model: CONTENT_MODELS.QUALITY,
        max_tokens: 500,
        messages: [{
          role: "user",
          content: `Weekly summary: ${totalVideos}/49 videos, ${totalPhones}/154 phone numbers. Daily breakdown: ${JSON.stringify(weekTargets)}. Write a weekly content briefing for Harvey in 4-5 sentences.`,
        }],
      });
      weeklyRaw = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
    } catch (err) {
      logContentAiFailure("weekly summary briefing", err);
    }
    if (!weeklyRaw) {
      weeklyRaw = `Weekly summary: ${totalVideos}/49 videos published, ${totalPhones}/154 phone numbers captured this week.`;
    }
    insertBriefing({
      briefingType: "weekly",
      title: `Content Manager — Weekly Briefing ${today}`,
      body: weeklyRaw,
      keyMetrics: { totalVideos, totalPhones, videoTarget: 49, phoneTarget: 154 },
      actionItems: [],
      sentToHarvey: true,
    });
    console.log(`[cm-brain] Night cycle complete — weekly briefing and self-evaluation written for Harvey`);
  } else {
    console.log(
      `[cm-brain] Night cycle complete — deep analysis done, tomorrow's preliminary strategy set, evening briefing written for Harvey`,
    );
  }

  insertLearningLog({
    cycleType: "night",
    date: today,
    insights: analysis?.trend_assessment ? [analysis.trend_assessment] : ["Night analysis complete"],
    strategyAdjustments: analysis?.tomorrow_priority ? [analysis.tomorrow_priority] : [],
    performanceSnapshot: { analysis, calibration: model.calibrationScore },
    phoneNumbersToday: countLeadCapturesForDate(today),
  });
}
