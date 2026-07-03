"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contentManagerBrain = exports.ContentManagerBrain = void 0;
exports.getOrCreateSession = getOrCreateSession;
exports.scheduleContentBrainCycles = scheduleContentBrainCycles;
/**
 * Content Manager Brain — autonomous content intelligence agent (Anthropic Claude).
 */
const prompts_js_1 = require("./prompts.js");
const tools_js_1 = require("./tools.js");
const cycles_js_1 = require("./cycles.js");
const contentDb_js_1 = require("../../../core/contentDb.js");
const youtubeIntel_js_1 = require("../youtubeIntel.js");
const claudeTools_js_1 = require("./claudeTools.js");
const claude_content_js_1 = require("../../../integrations/claude-content.js");
class ContentManagerBrain {
    apiKey;
    constructor() {
        this.apiKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
    }
    buildContextSnapshot() {
        const model = (0, contentDb_js_1.getPerformanceModel)();
        const strategy = (0, contentDb_js_1.getDailyStrategy)((0, contentDb_js_1.todayDateCst)());
        const targets = (0, contentDb_js_1.ensureDailyTargets)((0, contentDb_js_1.todayDateCst)());
        const logs = (0, contentDb_js_1.listLearningLogs)({ limit: 2 });
        const analysis = (0, contentDb_js_1.getLatestCompetitiveAnalysis)();
        const activeRecs = (0, contentDb_js_1.getActiveStrategyRecommendations)().slice(0, 3);
        const today = (0, contentDb_js_1.todayDateCst)();
        const weekEnd = new Date(`${today}T12:00:00`);
        weekEnd.setDate(weekEnd.getDate() + 7);
        const weekEndStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(weekEnd);
        const pendingTasks = (0, contentDb_js_1.listRecordingTasks)({
            status: "pending",
            dueAfter: today,
            dueBefore: weekEndStr,
            limit: 20,
        });
        const sprint = (0, contentDb_js_1.getSprintProgressData)();
        let youtubeContext = null;
        try {
            const latestYT = (0, youtubeIntel_js_1.getLatestYouTubeAnalysis)();
            if (latestYT) {
                const daysSince = Math.floor((Date.now() - new Date(latestYT.analyzedAt).getTime()) / (1000 * 60 * 60 * 24));
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
        }
        catch {
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
    buildContextBlock() {
        return "\n\nCurrent context: " + JSON.stringify(this.buildContextSnapshot());
    }
    async runToolRound(userMessage, extraContext = "", history) {
        if (!this.apiKey) {
            return "Content Manager Brain is offline — set ANTHROPIC_API_KEY in .env.";
        }
        const system = prompts_js_1.CONTENT_MANAGER_BRAIN_PROMPT + extraContext;
        return (0, claudeTools_js_1.claudeChatWithTools)({
            system,
            userMessage,
            history,
            tools: tools_js_1.CM_BRAIN_TOOL_DEFINITIONS,
            model: (0, claudeTools_js_1.getContentBrainModel)(),
            maxRounds: 8,
            onToolCall: tools_js_1.executeContentBrainTool,
        });
    }
    /**
     * Public entry point for Harvey's `ask_content_manager` tool
     * (src/harvey/tools.ts) — the one remaining caller. Every internal content
     * manager module (cycles.ts, competitiveAnalysis.ts, youtubeIntel.ts,
     * calendar.ts, clipEnhancer.ts, experiments.ts) now makes its own direct,
     * independently-routed Claude call instead of going through this method.
     */
    async chat(message, context) {
        const model = (0, contentDb_js_1.getPerformanceModel)();
        const strategy = (0, contentDb_js_1.getDailyStrategy)((0, contentDb_js_1.todayDateCst)());
        const logs = (0, contentDb_js_1.listLearningLogs)({ limit: 3 });
        let extra = `\n\nCURRENT PERFORMANCE MODEL:\n${JSON.stringify(model, null, 2)}`;
        extra += `\n\nTODAY'S STRATEGY:\n${JSON.stringify(strategy, null, 2)}`;
        extra += `\n\nRECENT LEARNING (last 3):\n${JSON.stringify(logs, null, 2)}`;
        extra += this.buildContextBlock();
        if (context)
            extra += `\n\nADDITIONAL CONTEXT:\n${JSON.stringify(context, null, 2)}`;
        return this.runToolRound(message, extra);
    }
    /** Persistent session chat for the dashboard Ask the Brain UI. */
    async chatWithSession(message, sessionId) {
        if (!this.apiKey) {
            return {
                response: "Content Manager Brain is offline — set ANTHROPIC_API_KEY in .env.",
                sessionId: sessionId ?? "",
            };
        }
        const now = new Date().toISOString();
        let session = sessionId ? (0, contentDb_js_1.getChatSession)(sessionId) : null;
        if (session && session.expiresAt <= now)
            session = null;
        if (!session)
            session = (0, contentDb_js_1.createChatSession)();
        const priorMessages = (0, contentDb_js_1.listChatMessages)(session.id);
        const history = priorMessages
            .slice(-20)
            .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
        const contextSnapshot = this.buildContextSnapshot();
        const system = prompts_js_1.CONTENT_MANAGER_BRAIN_PROMPT +
            this.buildContextBlock() +
            "\n\nYou are answering a question in the dashboard chat. Answer directly and " +
            "concisely using the real numbers in the context above — never generic advice. " +
            "If the context does not contain what is needed, say so plainly.";
        (0, contentDb_js_1.insertChatMessage)({
            sessionId: session.id,
            role: "user",
            content: message,
            performanceContext: contextSnapshot,
        });
        // One direct Claude call with the live context injected — no agentic tool
        // loop. The former tool loop could invoke slow tools (competitive analysis
        // hits Apify) or nested Claude calls across up to 8 rounds and hang or 500;
        // this answers in a single QUALITY-tier call, fast and reliably.
        let response;
        try {
            const completion = await claude_content_js_1.claudeContent.messages.create({
                model: claude_content_js_1.CONTENT_MODELS.QUALITY,
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
        }
        catch (err) {
            (0, claude_content_js_1.logContentAiFailure)("content-chat", err);
            throw new Error("The content manager couldn't answer that just now — the AI request failed. Please try again in a moment.");
        }
        (0, contentDb_js_1.insertChatMessage)({
            sessionId: session.id,
            role: "assistant",
            content: response,
            performanceContext: null,
        });
        const updated = (0, contentDb_js_1.getChatSession)(session.id);
        if (updated && updated.messageCount >= 6 && !updated.sessionSummary) {
            try {
                const recent = (0, contentDb_js_1.listChatMessages)(session.id).slice(-6);
                const summaryText = recent.map((m) => `${m.role}: ${m.content}`).join("\n");
                const summary = await (0, claudeTools_js_1.claudeSimpleChat)(`Summarize this conversation in one sentence:\n${summaryText}`);
                if (summary)
                    (0, contentDb_js_1.updateChatSessionSummary)(session.id, summary);
            }
            catch (err) {
                // A summary failure must never break the chat response.
                console.warn(`[content-chat] session summary skipped: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return { response, sessionId: session.id };
    }
    async runMorningCycle() {
        await (0, cycles_js_1.runMorningCycle)(this);
    }
    async runMiddayCycle() {
        await (0, cycles_js_1.runMiddayCycle)(this);
    }
    async runEveningCycle() {
        await (0, cycles_js_1.runEveningCycle)(this);
    }
    async runNightCycle() {
        await (0, cycles_js_1.runNightCycle)(this);
    }
}
exports.ContentManagerBrain = ContentManagerBrain;
exports.contentManagerBrain = new ContentManagerBrain();
function getOrCreateSession() {
    return (0, contentDb_js_1.createChatSession)().id;
}
const lastBrainRuns = {};
/** Schedule 6am, 12pm, 6pm, 10pm CST intelligence cycles. */
function scheduleContentBrainCycles() {
    const keyValid = (0, claude_content_js_1.validateAnthropicKey)();
    const provider = keyValid
        ? `Claude (${(0, claudeTools_js_1.getContentBrainModel)()})`
        : "offline — set ANTHROPIC_API_KEY";
    console.log(`[cm-brain] intelligence cycles scheduled: 6am, 12pm, 6pm, 10pm America/Chicago — ${provider}`);
    const cycles = [
        { hour: 6, key: "morning", run: () => exports.contentManagerBrain.runMorningCycle() },
        { hour: 12, key: "midday", run: () => exports.contentManagerBrain.runMiddayCycle() },
        { hour: 18, key: "evening", run: () => exports.contentManagerBrain.runEveningCycle() },
        { hour: 22, key: "night", run: () => exports.contentManagerBrain.runNightCycle() },
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
