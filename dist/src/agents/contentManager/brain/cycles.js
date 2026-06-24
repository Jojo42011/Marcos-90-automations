"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMorningCycle = runMorningCycle;
exports.runMiddayCycle = runMiddayCycle;
exports.runEveningCycle = runEveningCycle;
exports.runNightCycle = runNightCycle;
/**
 * Content Manager Brain — four daily intelligence cycles.
 */
const analytics_js_1 = require("../analytics.js");
const contentDb_js_1 = require("../../../core/contentDb.js");
const decay_js_1 = require("./decay.js");
const hookClassifier_js_1 = require("./hookClassifier.js");
const patterns_js_1 = require("./patterns.js");
const experiments_js_1 = require("./experiments.js");
const momentum_js_1 = require("./momentum.js");
const calendar_js_1 = require("../calendar.js");
const competitiveAnalysis_js_1 = require("../competitiveAnalysis.js");
const contentDb_js_2 = require("../../../core/contentDb.js");
const prompts_js_1 = require("./prompts.js");
const stats_js_1 = require("./stats.js");
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
function tomorrowDateCst() {
    const today = (0, contentDb_js_1.todayDateCst)();
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() + 1);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
}
function gradeYesterdayStrategy(yesterday) {
    const strategy = (0, contentDb_js_1.getDailyStrategy)(yesterday);
    if (!strategy) {
        return { grade: null, outcomeScore: null, gradePrompt: "" };
    }
    const videos = (0, contentDb_js_1.listVideosPublishedOnDate)(yesterday);
    if (videos.length < 2) {
        return { grade: null, outcomeScore: null, gradePrompt: "" };
    }
    const pillarAvgs = {};
    for (const v of videos) {
        const p = v.pillar || "brand";
        if (!pillarAvgs[p])
            pillarAvgs[p] = { sum: 0, count: 0 };
        pillarAvgs[p].sum += v.views;
        pillarAvgs[p].count++;
    }
    const actualTopPillar = Object.entries(pillarAvgs).sort((a, b) => b[1].sum / b[1].count - a[1].sum / a[1].count)[0]?.[0] ?? null;
    const recommendedTop = strategy.pillarPriority[0] ?? null;
    const pillarCorrect = recommendedTop === actualTopPillar;
    const hooksThatBeat = [];
    for (const rec of strategy.recommendedHooks) {
        const recLower = rec.toLowerCase();
        const matched = videos.some((v) => v.views >= contentDb_js_1.CONTENT_BENCHMARK_VIEWS &&
            v.hook &&
            (v.hook.toLowerCase().includes(recLower.slice(0, 20)) ||
                recLower.includes(v.hook.toLowerCase().slice(0, 20))));
        if (matched)
            hooksThatBeat.push(rec);
    }
    const avgViewsYesterday = videos.reduce((s, v) => s + v.views, 0) / videos.length;
    let outcomeScore = 0;
    if (pillarCorrect)
        outcomeScore += 40;
    const hookPoints = Math.min(40, hooksThatBeat.length * 20);
    outcomeScore += hookPoints;
    if (avgViewsYesterday >= contentDb_js_1.CONTENT_BENCHMARK_VIEWS) {
        outcomeScore += Math.min(20, ((avgViewsYesterday - contentDb_js_1.CONTENT_BENCHMARK_VIEWS) / contentDb_js_1.CONTENT_BENCHMARK_VIEWS) * 20);
    }
    else {
        outcomeScore = Math.max(0, outcomeScore - ((contentDb_js_1.CONTENT_BENCHMARK_VIEWS - avgViewsYesterday) / contentDb_js_1.CONTENT_BENCHMARK_VIEWS) * 20);
    }
    outcomeScore = Math.min(100, Math.round(outcomeScore));
    const grade = (0, stats_js_1.gradeFromOutcomeScore)(outcomeScore);
    const hooksHitRate = strategy.recommendedHooks.length > 0 ? hooksThatBeat.length / strategy.recommendedHooks.length : 0;
    (0, contentDb_js_1.insertStrategyAccuracy)({
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
    (0, contentDb_js_1.upsertPerformanceModel)({ selfGradeLastWeek: grade });
    let gradePrompt = `Yesterday's strategy received a grade of ${grade} (${outcomeScore}/100). `;
    if (grade === "C" || grade === "D" || grade === "F") {
        gradePrompt += "Your recommendations underperformed. Adjust your approach significantly today.";
    }
    else {
        gradePrompt += "Your recommendations performed well. Build on what worked.";
    }
    return { grade, outcomeScore, gradePrompt };
}
function buildSeasonalityContext() {
    const weekNumber = (0, stats_js_1.getCurrentWeekNumber)();
    const seasonal = (0, contentDb_js_1.getSeasonalWeek)(weekNumber);
    const historical = (0, contentDb_js_1.listVideosForWeekNumber)(weekNumber);
    const sampleCount = historical.length;
    const multiplier = seasonal?.performanceMultiplier ?? 1;
    const label = seasonal?.seasonLabel ?? (0, contentDb_js_1.seasonLabelForWeek)(weekNumber);
    let text = `Current seasonal multiplier: ${multiplier} (${label}). `;
    if (sampleCount >= 5) {
        if (multiplier > 1.1) {
            text +=
                "Historically this is a strong week for views. Increase Brand content to capture peak buyer intent.";
        }
        else if (multiplier < 0.9) {
            text +=
                "Historically this is a slower week. Focus on Education content for algorithm favor and reduce posting expectations slightly.";
        }
    }
    else {
        text += "Seasonality data still accumulating — multiplier held near 1.0.";
    }
    const logNote = `[cm-brain] Seasonality model: ${sampleCount} historical data points for week ${weekNumber} — ${sampleCount < 5 ? "accumulating data" : "multiplier active"}`;
    return { text, logNote };
}
function updateSeasonalityModel() {
    const weekNumber = (0, stats_js_1.getCurrentWeekNumber)();
    const historical = (0, contentDb_js_1.listVideosForWeekNumber)(weekNumber);
    if (historical.length < 3)
        return;
    const historicalAvg = historical.reduce((s, v) => s + v.views, 0) / historical.length;
    const model = (0, contentDb_js_1.getPerformanceModel)();
    const overallAvg = model.overallAvgViews || 0;
    const multiplier = overallAvg > 0 ? Math.round((historicalAvg / overallAvg) * 100) / 100 : 1;
    (0, contentDb_js_1.upsertSeasonalWeek)({
        weekNumber,
        historicalAvgViews: historicalAvg,
        performanceMultiplier: multiplier,
        seasonLabel: (0, contentDb_js_1.seasonLabelForWeek)(weekNumber),
    });
    (0, contentDb_js_1.upsertPerformanceModel)({ seasonMultiplier: multiplier });
}
async function runMorningCycle(brain) {
    const date = (0, contentDb_js_1.todayDateCst)();
    const yesterday = (0, contentDb_js_1.yesterdayDateCst)();
    const yesterdayTargets = (0, contentDb_js_1.getDailyTargets)(yesterday);
    const recentLogs = (0, contentDb_js_1.listLearningLogs)({ limit: 3 });
    let model = (0, contentDb_js_1.getPerformanceModel)();
    const pendingReview = (0, contentDb_js_1.countVideosByStatus)("pending_review");
    (0, contentDb_js_1.ensureDailyTargets)(date);
    const { gradePrompt } = gradeYesterdayStrategy(yesterday);
    const momentum = (0, momentum_js_1.updateMomentumState)();
    model = (0, contentDb_js_1.getPerformanceModel)();
    const calibrationSuffix = (0, prompts_js_1.getCalibrationAwarePromptSuffix)(model.calibrationScore);
    const topCombinations = (0, patterns_js_1.getTopCombinations)(5);
    const worstCombinations = (0, patterns_js_1.getWorstCombinations)(3);
    const hookTypeSummary = (0, hookClassifier_js_1.getHookTypePerformanceSummary)();
    const { text: seasonalityText, logNote: seasonLog } = buildSeasonalityContext();
    const momentumAdjustment = (0, momentum_js_1.getMomentumStrategyAdjustment)(momentum.streakType, momentum.streakCount);
    if ((0, stats_js_1.isMonday)()) {
        await (0, experiments_js_1.proposeWeeklyExperiment)(brain);
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
    const strategyRaw = await brain.chat(strategyPrompt);
    const parsed = parseJsonFromText(strategyRaw);
    const strategy = (0, contentDb_js_1.upsertDailyStrategy)(date, {
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
    const experimentNote = (0, stats_js_1.isMonday)() ? " Experiment proposed for this week — see cm_experiments." : "";
    const briefingRaw = await brain.chat(`Write a morning briefing for Harvey. Strategy: ${JSON.stringify(strategy)}. Pipeline pending review: ${pendingReview}. Momentum: ${momentum.streakType} (${momentum.streakCount}).${experimentNote} Return JSON: { "body": string (3-4 sentences), "action_items": string[] }`);
    const briefingParsed = parseJsonFromText(briefingRaw);
    let recordingPlanNote = "";
    if ((0, stats_js_1.isMonday)()) {
        try {
            const weekStart = (0, stats_js_1.getWeekStart)();
            const tasks = await (0, calendar_js_1.generateWeeklyRecordingPlan)(weekStart, brain);
            const first = tasks[0];
            recordingPlanNote = `Recording plan for the week: ${tasks.length} sessions planned, ${tasks.length * 2} clips targeted. First session due: ${first?.dueDate ?? "n/a"} — ${first?.topic ?? "see calendar"}.`;
        }
        catch (err) {
            console.error("[cm-brain] Weekly recording plan failed:", err);
        }
    }
    const overdueCount = (0, contentDb_js_2.countOverdueRecordingTasks)(date);
    let overdueNote = "";
    if (overdueCount > 0) {
        const overdueTasks = (0, contentDb_js_2.countPendingRecordingTasksDueBefore)(date);
        overdueNote = `OVERDUE RECORDING TASKS: ${overdueCount} tasks are past due. Pipeline will be short ${overdueCount} videos if not filmed today.`;
    }
    const briefingBody = (briefingParsed?.body ??
        `Yesterday: ${yesterdayTargets.videosPublished}/${yesterdayTargets.videosTarget} videos, ${yesterdayTargets.phoneNumbersCaptured}/${yesterdayTargets.phoneNumbersTarget} phone numbers. Today prioritize ${strategy.pillarPriority[0] ?? "brand"}. ${pendingReview} clips awaiting review.`) +
        (recordingPlanNote ? ` ${recordingPlanNote}` : "") +
        (overdueNote ? ` ${overdueNote}` : "");
    (0, contentDb_js_1.insertBriefing)({
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
    console.log(`[cm-brain] Morning cycle complete for ${date} — strategy confidence ${strategy.confidenceScore}/100, ${pendingReview} clips waiting for review. ${seasonLog}`);
}
async function runMiddayCycle(brain) {
    const today = (0, contentDb_js_1.todayDateCst)();
    const targets = (0, contentDb_js_1.ensureDailyTargets)(today);
    const pendingCompliance = (0, contentDb_js_1.listPendingComplianceQueue)().length;
    const behindPace = targets.videosPublished < 3;
    const bottleneck = pendingCompliance > 3;
    const leadUnder = targets.phoneNumbersCaptured < 8;
    if (behindPace || bottleneck || leadUnder) {
        const alertRaw = await brain.chat(`Midday alert needed. Videos published: ${targets.videosPublished}/7. Compliance queue: ${pendingCompliance}. Phone numbers: ${targets.phoneNumbersCaptured}/22. Write a 2-3 sentence escalation for Harvey.`);
        (0, contentDb_js_1.insertBriefing)({
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
        console.log(`[cm-brain] Midday escalation — ${targets.videosPublished}/7 videos, ${pendingCompliance} compliance items`);
    }
    else {
        console.log(`[cm-brain] Midday check — ${targets.videosPublished}/7 videos, ${targets.phoneNumbersCaptured}/22 numbers. On track.`);
    }
}
async function runEveningCycle(brain) {
    const today = (0, contentDb_js_1.todayDateCst)();
    await (0, analytics_js_1.runPerformanceSync)();
    const freshData = (0, contentDb_js_1.listPerformanceWithVideosSince)(24);
    for (const { video, performance } of freshData) {
        if (video.hook) {
            (0, contentDb_js_1.upsertHookLibraryEntry)({
                hookText: video.hook,
                contentPillar: video.pillar,
                views: performance.views,
                aboveBenchmark: performance.benchmarkMet,
            });
        }
        for (const tag of video.hashtags) {
            (0, contentDb_js_1.upsertHashtagPerformance)({
                hashtag: tag,
                views: performance.views,
                aboveBenchmark: performance.benchmarkMet,
            });
        }
        if (video.publishedAt) {
            const dw = (0, decay_js_1.getDecayWeight)(video.publishedAt);
            (0, contentDb_js_1.upsertPostingTimeMatrix)({
                publishedAt: video.publishedAt,
                views: performance.views * dw,
            });
        }
    }
    const classified = (0, hookClassifier_js_1.classifyAndUpdateHookLibrary)();
    const patternsUpdated = (0, patterns_js_1.updateCombinationPatterns)();
    const topHooks = (0, contentDb_js_1.listHookLibrary)({ minUses: 1, limit: 10, order: "desc" });
    const hookTypeSummary = (0, hookClassifier_js_1.getHookTypePerformanceSummary)();
    const topCombinations = (0, patterns_js_1.getTopCombinations)(5);
    const learningPrompt = `Here is today's performance data (${freshData.length} videos updated). Top hooks: ${JSON.stringify(topHooks)}. Hook type summary: ${JSON.stringify(hookTypeSummary)}. Top combinations: ${JSON.stringify(topCombinations)}. Generate 3-5 data-backed insights and 1-3 strategy adjustments for tomorrow. Return JSON: { "insights": string[], "strategy_adjustments": string[] }`;
    const learningRaw = await brain.chat(learningPrompt);
    const learning = parseJsonFromText(learningRaw);
    const insights = learning?.insights ?? ["Insufficient data for strong patterns today — maintain volume focus."];
    const adjustments = learning?.strategy_adjustments ?? ["Keep 7-video daily target."];
    const above = freshData.filter((d) => d.performance.benchmarkMet).length;
    const below = freshData.filter((d) => !d.performance.benchmarkMet && d.performance.views > 0).length;
    (0, contentDb_js_1.insertLearningLog)({
        cycleType: "evening",
        date: today,
        insights,
        strategyAdjustments: adjustments,
        performanceSnapshot: {
            videosUpdated: freshData.length,
            videosPublished: (0, contentDb_js_1.ensureDailyTargets)(today).videosPublished,
            hooksClassified: classified,
            patternsUpdated,
        },
        videosAboveBenchmark: above,
        videosBelowBenchmark: below,
        phoneNumbersToday: (0, contentDb_js_1.countLeadCapturesForDate)(today),
    });
    (0, contentDb_js_1.recalculatePerformanceModelFromData)();
    (0, momentum_js_1.updateMomentumState)();
    updateSeasonalityModel();
    let cutAdditions = 0;
    const underperformers = (0, contentDb_js_1.listConsistentlyBelowBenchmarkVideos)();
    for (const item of underperformers) {
        const exists = (0, contentDb_js_1.listCutList)().some((c) => c.contentAngle.includes(item.title.slice(0, 40)));
        if (exists)
            continue;
        if (item.latestViews < 3000 && item.consecutiveColdPulls >= 3) {
            const evalRaw = await brain.chat(`Video "${item.title}" averaged ${item.latestViews} views across ${item.consecutiveColdPulls} cold pulls (benchmark 6006). Should we cut this angle? Reply JSON: { "cut": boolean, "reason": string }`);
            const evalParsed = parseJsonFromText(evalRaw);
            if (evalParsed?.cut) {
                (0, contentDb_js_1.insertCutListItem)({
                    contentAngle: item.title,
                    reason: evalParsed.reason || "Consistently below 50% of benchmark",
                    avgViewsWhenCut: item.latestViews,
                    timesTested: item.consecutiveColdPulls,
                    flaggedBy: "brain",
                    benchmarkAtCut: contentDb_js_1.CONTENT_BENCHMARK_VIEWS,
                });
                cutAdditions++;
            }
        }
    }
    console.log(`[cm-brain] Evening cycle complete — performance model updated, ${insights.length} insights logged, ${classified} hooks classified, ${patternsUpdated} patterns updated, ${cutAdditions} angles flagged for cutting`);
}
async function runNightCycle(brain) {
    const today = (0, contentDb_js_1.todayDateCst)();
    const logs = (0, contentDb_js_1.listLearningLogs)({ limit: 28, days: 7 });
    let model = (0, contentDb_js_1.getPerformanceModel)();
    const topHooks = (0, contentDb_js_1.listHookLibrary)({ minUses: 1, limit: 10, order: "desc" });
    const bottomHooks = (0, contentDb_js_1.listHookLibrary)({ minUses: 3, limit: 10, order: "asc" });
    const cutList = (0, contentDb_js_1.listCutList)();
    const accuracyRecords = (0, contentDb_js_1.listStrategyAccuracy)(14);
    let calibrationNote = "";
    if (accuracyRecords.length >= 5) {
        const xs = accuracyRecords.map((r) => r.confidenceScoreGiven);
        const ys = accuracyRecords.map((r) => r.outcomeScore);
        const calibration = (0, stats_js_1.pearsonCorrelation)(xs, ys);
        (0, contentDb_js_1.upsertPerformanceModel)({ calibrationScore: calibration });
        model = (0, contentDb_js_1.getPerformanceModel)();
        calibrationNote = `Your current confidence calibration score is ${calibration.toFixed(2)} (1.0 = perfect, 0 = no correlation between your confidence and accuracy). `;
        if (calibration < 0.3) {
            calibrationNote +=
                "Your confidence scores are poorly calibrated — you need to be more conservative or more aggressive with them.";
        }
        else if (calibration <= 0.7) {
            calibrationNote += "Moderate calibration. Your confidence scores are somewhat predictive.";
        }
        else {
            calibrationNote += "Good calibration. Your stated confidence is a reliable predictor of accuracy.";
        }
    }
    const analysisPrompt = `Nightly deep analysis. ${calibrationNote}
Learning logs: ${JSON.stringify(logs.slice(0, 7))}. Performance model: ${JSON.stringify(model)}. Top hooks: ${JSON.stringify(topHooks)}. Bottom hooks: ${JSON.stringify(bottomHooks)}. Cut list: ${JSON.stringify(cutList)}. Return JSON: { "trend_assessment": string, "top_pillar": string, "biggest_opportunity": string, "biggest_risk": string, "tomorrow_priority": string, "weekly_summary": string }`;
    const analysisRaw = await brain.chat(analysisPrompt);
    const analysis = parseJsonFromText(analysisRaw);
    const tomorrow = tomorrowDateCst();
    const prelimRaw = await brain.chat(`Based on this analysis: ${JSON.stringify(analysis)}. Generate tomorrow's preliminary strategy JSON with pillar_priority, recommended_hooks, hashtag_set, avoid_angles, platform_distribution, reasoning, confidence_score (low, 20-40).`);
    const prelim = parseJsonFromText(prelimRaw);
    (0, contentDb_js_1.upsertDailyStrategy)(tomorrow, {
        pillarPriority: prelim?.pillar_priority ?? ["brand", "education", "listings"],
        recommendedHooks: prelim?.recommended_hooks ?? [],
        hashtagSet: prelim?.hashtag_set ?? [],
        avoidAngles: prelim?.avoid_angles ?? [],
        platformDistribution: prelim?.platform_distribution ?? { tiktok: 4, instagram: 2, facebook: 1 },
        reasoning: prelim?.reasoning ?? analysis?.tomorrow_priority ?? "Preliminary strategy from night cycle.",
        confidenceScore: prelim?.confidence_score ?? 30,
    });
    let weeklyEvalNote = "";
    if ((0, stats_js_1.isSunday)()) {
        try {
            const compAnalysis = await (0, competitiveAnalysis_js_1.runFullCompetitiveAnalysis)(brain);
            const aboveBelow = compAnalysis.marcoVsFieldPct >= 0 ? "above" : "below";
            const recCount = compAnalysis.marcoGaps.length;
            console.log(`[cm-brain] Competitive analysis complete — Marco ${aboveBelow} field by ${compAnalysis.marcoVsFieldPct.toFixed(1)}%, strategy recommendations generated, recording tasks created`);
            const compNote = `Competitive analysis: Marco is ${Math.abs(compAnalysis.marcoVsFieldPct).toFixed(0)}% ${aboveBelow} competitor average. Top gap: ${compAnalysis.marcoGaps[0] ?? "n/a"}. Top recommendation: ${(0, contentDb_js_1.getActiveStrategyRecommendations)()[0]?.recommendation ?? "see strategy panel"}.`;
            (0, contentDb_js_1.insertBriefing)({
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
        }
        catch (err) {
            console.error("[cm-brain] Sunday competitive analysis failed:", err);
        }
        await (0, experiments_js_1.evaluateCurrentExperiment)(brain);
        const weekStart = (0, stats_js_1.getWeekStart)();
        const weekAccuracy = (0, contentDb_js_1.listStrategyAccuracy)(7);
        let strategiesFollowed = 0;
        for (let i = 0; i < 7; i++) {
            const d = new Date(`${weekStart}T12:00:00`);
            d.setDate(d.getDate() + i);
            const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
            if ((0, contentDb_js_1.countVideosPublishedOnDate)(dateStr) >= 2)
                strategiesFollowed++;
        }
        const strategiesIgnored = 7 - strategiesFollowed;
        const avgOutcome = weekAccuracy.length > 0
            ? weekAccuracy.reduce((s, r) => s + r.outcomeScore, 0) / weekAccuracy.length
            : 0;
        const topInsights = logs.slice(0, 3).flatMap((l) => l.insights);
        const evalRaw = await brain.chat(`Write your weekly self-evaluation for the week of ${weekStart}. Data: strategies followed ${strategiesFollowed}/7, average outcome score ${avgOutcome.toFixed(0)}/100, calibration score ${model.calibrationScore ?? "n/a"}, top insights this week: ${JSON.stringify(topInsights)}. Answer: (1) What did you get right? (2) What did you get wrong? (3) One change going forward? (4) 6006 benchmark trajectory? Return JSON only: { "what_worked": string, "what_failed": string, "one_change": string, "benchmark_assessment": string, "calibration_score": number }`);
        const evalParsed = parseJsonFromText(evalRaw);
        if (evalParsed) {
            const grade = (0, stats_js_1.gradeFromOutcomeScore)(avgOutcome);
            (0, contentDb_js_1.insertSelfEvaluation)({
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
            (0, contentDb_js_1.upsertPerformanceModel)({ selfGradeLastWeek: grade });
            weeklyEvalNote = `Weekly self-evaluation complete. Grade: ${grade}. ${evalParsed.one_change.slice(0, 120)}. Benchmark trajectory: ${evalParsed.benchmark_assessment.slice(0, 120)}.`;
        }
    }
    (0, contentDb_js_1.insertBriefing)({
        briefingType: "evening",
        title: `Content Manager — Evening Briefing ${today}`,
        body: weeklyEvalNote ||
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
    if ((0, stats_js_1.isSunday)()) {
        const weekTargets = (0, contentDb_js_1.listDailyTargetsLastDays)(7);
        const totalVideos = weekTargets.reduce((s, t) => s + t.videosPublished, 0);
        const totalPhones = weekTargets.reduce((s, t) => s + t.phoneNumbersCaptured, 0);
        const weeklyRaw = await brain.chat(`Weekly summary: ${totalVideos}/49 videos, ${totalPhones}/154 phone numbers. Daily breakdown: ${JSON.stringify(weekTargets)}. Write a weekly content briefing for Harvey in 4-5 sentences.`);
        (0, contentDb_js_1.insertBriefing)({
            briefingType: "weekly",
            title: `Content Manager — Weekly Briefing ${today}`,
            body: weeklyRaw,
            keyMetrics: { totalVideos, totalPhones, videoTarget: 49, phoneTarget: 154 },
            actionItems: [],
            sentToHarvey: true,
        });
        console.log(`[cm-brain] Night cycle complete — weekly briefing and self-evaluation written for Harvey`);
    }
    else {
        console.log(`[cm-brain] Night cycle complete — deep analysis done, tomorrow's preliminary strategy set, evening briefing written for Harvey`);
    }
    (0, contentDb_js_1.insertLearningLog)({
        cycleType: "night",
        date: today,
        insights: analysis?.trend_assessment ? [analysis.trend_assessment] : ["Night analysis complete"],
        strategyAdjustments: analysis?.tomorrow_priority ? [analysis.tomorrow_priority] : [],
        performanceSnapshot: { analysis, calibration: model.calibrationScore },
        phoneNumbersToday: (0, contentDb_js_1.countLeadCapturesForDate)(today),
    });
}
