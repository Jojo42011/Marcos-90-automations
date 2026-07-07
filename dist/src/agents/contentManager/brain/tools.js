"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeBenchmarkTrajectory = exports.CM_BRAIN_TOOL_DEFINITIONS = void 0;
exports.executeContentBrainTool = executeContentBrainTool;
const claude_content_js_1 = require("../../../integrations/claude-content.js");
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
Question hooks drive comments. Data hooks (a specific number/price/rate) drive saves. Local hooks ("Stone Oak buyers...") drive DMs. Personal-story hooks build trust. Controversy/shock hooks drive shares. Every hook must sound like something Marco would actually say out loud on camera — never marketing copy.

THE FUNNEL (every caption moves a viewer down this path):
entertained -> educated -> trusting -> DM -> phone number -> Carlos closes.
CTAs should nudge toward a DM or comment Marco's team can convert into a phone number — never "link in bio" or generic engagement bait.

PLATFORM PACING:
TikTok (primary) wants the fastest pacing and native slang is fine. Instagram Reels reuses the same clip with a slightly warmer, more polished tone. Facebook Reels reuses it again with slightly more explanation since that audience skews older. Write for TikTok-native pacing first — it reads fine on Reels and Facebook too.

Respond with valid JSON only. No markdown, no backticks, no explanation. Just the raw JSON.`;
const compliance_js_1 = require("../compliance.js");
const contentDb_js_1 = require("../../../core/contentDb.js");
Object.defineProperty(exports, "computeBenchmarkTrajectory", { enumerable: true, get: function () { return contentDb_js_1.computeBenchmarkTrajectory; } });
const calendar_js_1 = require("../calendar.js");
const competitiveAnalysis_js_1 = require("../competitiveAnalysis.js");
const googleDrivePull_js_1 = require("../googleDrivePull.js");
const stats_js_1 = require("./stats.js");
const contentDb_js_2 = require("../../../core/contentDb.js");
exports.CM_BRAIN_TOOL_DEFINITIONS = [
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
        description: "Auto-approve only if compliance passed, not flagged, and score >= 60. Never approves flagged content.",
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
        description: "Trigger full competitive analysis (Apify + Claude, 30-60 seconds).",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_youtube_insights",
        description: "Latest YouTube competitor transcript analysis — hook structures, opening phrases, topics, data points, CTA patterns, content gaps, key insights, and the recommended video idea. Use when Marco asks what competitors are doing on YouTube, what content he's missing, or for a video idea based on competitor research.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_youtube_transcripts_sample",
        description: "Recent cached competitor YouTube transcripts (hook + CTA excerpts), optionally filtered by channel. Use to reference specific competitor video content.",
        input_schema: {
            type: "object",
            properties: {
                channel_name: { type: "string" },
                limit: { type: "number" },
            },
            required: [],
        },
    },
    {
        name: "get_drive_folder_status",
        description: "Status of the Google Drive auto-pull that watches Marco's 'New Raw Videos' folder and feeds new videos into the Upload & Clip pipeline. Returns whether Drive is connected (valid credentials + folder accessible), how many videos are currently in the folder, how many have been pulled/processed so far, how many are still pending (detected but not yet pulled — e.g. downloading or waiting on disk space), and the last poll time. Use when Marco asks about Google Drive: how many videos are in the folder, whether anything has been pulled recently, or if the Drive connection is working.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
];
function parseHookJson(text) {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match)
        return [];
    try {
        const arr = JSON.parse(match[0]);
        return arr.map(String).filter(Boolean);
    }
    catch {
        return [];
    }
}
async function executeContentBrainTool(toolName, input) {
    console.log(`[cm-brain/tool] ${toolName}`);
    switch (toolName) {
        case "get_performance_data": {
            const days = Number(input.days) || 7;
            const videos = (0, contentDb_js_1.listPerformanceDataForDays)(days);
            const dailyTotals = {};
            for (const v of videos) {
                const d = v.date || (0, contentDb_js_1.todayDateCst)();
                if (!dailyTotals[d])
                    dailyTotals[d] = { views: 0, count: 0 };
                dailyTotals[d].views += v.views;
                dailyTotals[d].count++;
            }
            return { days, videos, dailyTotals };
        }
        case "get_pipeline_status": {
            const today = (0, contentDb_js_1.todayDateCst)();
            const targets = (0, contentDb_js_1.ensureDailyTargets)(today);
            const oldest = (0, contentDb_js_1.getOldestPendingReview)();
            return {
                statusCounts: (0, contentDb_js_1.getStatusCounts)(),
                oldestPendingReview: oldest
                    ? { id: oldest.id, createdAt: oldest.createdAt, caption: oldest.caption.slice(0, 80) }
                    : null,
                complianceFlaggedPending: (0, contentDb_js_1.countVideosComplianceFlaggedPending)(),
                approvedReady: (0, contentDb_js_1.countVideosByStatus)("approved"),
                videosPublishedToday: targets.videosPublished,
                videosTarget: targets.videosTarget,
            };
        }
        case "get_compliance_queue": {
            const pending = (0, contentDb_js_1.listPendingComplianceQueue)();
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
            const captures = (0, contentDb_js_1.listLeadCaptures)({ limit: 200 }).filter((c) => new Date(c.capturedAt) >= since);
            const byPlatform = {};
            let routed = 0;
            for (const c of captures) {
                byPlatform[c.platform] = (byPlatform[c.platform] || 0) + 1;
                if (c.routedToCrm)
                    routed++;
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
            return { entries: (0, contentDb_js_1.listLearningLogs)({ limit: Number(input.limit) || 5 }) };
        case "get_performance_model":
            return { model: (0, contentDb_js_1.getPerformanceModel)() };
        case "update_performance_model": {
            const patch = {};
            if (input.overall_avg_views != null)
                patch.overallAvgViews = Number(input.overall_avg_views);
            if (input.benchmark_gap_pct != null)
                patch.benchmarkGapPct = Number(input.benchmark_gap_pct);
            if (input.trending_direction)
                patch.trendingDirection = input.trending_direction;
            if (input.top_performing_pillar)
                patch.topPerformingPillar = String(input.top_performing_pillar);
            return { model: (0, contentDb_js_1.upsertPerformanceModel)(patch) };
        }
        case "write_learning_log": {
            const today = (0, contentDb_js_1.todayDateCst)();
            const perf = (0, contentDb_js_1.listPerformanceDataForDays)(1);
            const above = perf.filter((p) => p.benchmarkMet).length;
            const below = perf.filter((p) => p.views > 0 && !p.benchmarkMet).length;
            const phones = (0, contentDb_js_1.countLeadCapturesForDate)(today);
            const entry = (0, contentDb_js_1.insertLearningLog)({
                cycleType: String(input.cycle_type || "manual"),
                date: today,
                insights: Array.isArray(input.insights) ? input.insights.map(String) : [],
                strategyAdjustments: Array.isArray(input.strategy_adjustments)
                    ? input.strategy_adjustments.map(String)
                    : [],
                performanceSnapshot: input.performance_snapshot && typeof input.performance_snapshot === "object"
                    ? input.performance_snapshot
                    : {},
                videosAboveBenchmark: above,
                videosBelowBenchmark: below,
                phoneNumbersToday: phones,
            });
            return { id: entry.id, loggedAt: entry.loggedAt };
        }
        case "set_daily_strategy": {
            const date = typeof input.date === "string" ? input.date : (0, contentDb_js_1.todayDateCst)();
            const strategy = (0, contentDb_js_1.upsertDailyStrategy)(date, {
                pillarPriority: Array.isArray(input.pillar_priority)
                    ? input.pillar_priority.map(String)
                    : ["brand", "education", "listings"],
                recommendedHooks: Array.isArray(input.recommended_hooks)
                    ? input.recommended_hooks.map(String)
                    : [],
                hashtagSet: Array.isArray(input.hashtag_set) ? input.hashtag_set.map(String) : [],
                avoidAngles: Array.isArray(input.avoid_angles) ? input.avoid_angles.map(String) : [],
                platformDistribution: input.platform_distribution && typeof input.platform_distribution === "object"
                    ? input.platform_distribution
                    : { tiktok: 4, instagram: 2, facebook: 1 },
                reasoning: String(input.reasoning || ""),
                confidenceScore: Number(input.confidence_score) || 50,
            });
            return strategy;
        }
        case "generate_hook_variations": {
            const model = (0, contentDb_js_1.getPerformanceModel)();
            const working = model?.workingHookPatterns ?? [];
            const originalHook = String(input.original_hook || "");
            const pillar = String(input.pillar || "education");
            let variations = [];
            if (process.env.ANTHROPIC_API_KEY?.trim()) {
                try {
                    const response = await claude_content_js_1.claudeContent.messages.create({
                        model: claude_content_js_1.CONTENT_MODELS.QUALITY,
                        max_tokens: 1024,
                        system: MARCO_VOICE_SYSTEM,
                        messages: [{
                                role: "user",
                                content: `Write 5 alternative hooks for a ${pillar} pillar real estate video. The hook currently in use: "${originalHook}". Marco's hook patterns that are currently beating the 6,006-view benchmark: ${working.join("; ") || "direct first-person San Antonio real estate"}. Vary the hook type across the 5 (mix question/data/local/personal-story/controversy) so we can test which converts best — do not just reword the original 5 times. Return a JSON array of exactly 5 hook strings, nothing else.`,
                            }],
                    });
                    const text = response.content
                        .filter((b) => b.type === "text")
                        .map((b) => (b.type === "text" ? b.text : ""))
                        .join("");
                    variations = parseHookJson(text);
                }
                catch (err) {
                    (0, claude_content_js_1.logContentAiFailure)("generate_hook_variations", err);
                }
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
                (0, contentDb_js_1.updateContentVideo)(String(input.clip_id), { hook: recommended });
            }
            return { variations, recommended };
        }
        case "generate_caption": {
            const pillar = String(input.pillar || "");
            const hook = String(input.hook || "");
            const platform = String(input.platform || "tiktok");
            const hashtags = Array.isArray(input.hashtags) ? input.hashtags.map(String) : [];
            if (process.env.ANTHROPIC_API_KEY?.trim()) {
                try {
                    const ctaByPillar = {
                        brand: `"DM me" — trust is already built by this point in a brand video, so ask directly`,
                        education: `"Comment your question and I'll answer it" — drives the comment signal and qualifies the lead`,
                        listings: `"DM me for the address" — gates a hyperlocal lead behind a DM`,
                    };
                    const cta = ctaByPillar[pillar] ?? ctaByPillar.brand;
                    const response = await claude_content_js_1.claudeContent.messages.create({
                        model: claude_content_js_1.CONTENT_MODELS.QUALITY,
                        max_tokens: 1024,
                        system: MARCO_VOICE_SYSTEM,
                        messages: [{
                                role: "user",
                                content: `Write the caption for this ${pillar} pillar video, going out on ${platform} first. The video opens with this exact hook: "${hook}". Hashtags to include: ${hashtags.join(" ")}. Caption body (the part after the hook) must be under 150 characters and end with a CTA styled like: ${cta}. Return JSON: { "caption": string, "full_post": string (hook + caption + hashtags, ready to post) }`,
                            }],
                    });
                    const text = response.content
                        .filter((b) => b.type === "text")
                        .map((b) => (b.type === "text" ? b.text : ""))
                        .join("");
                    const match = text.match(/\{[\s\S]*\}/);
                    if (match) {
                        return JSON.parse(match[0]);
                    }
                }
                catch (err) {
                    (0, claude_content_js_1.logContentAiFailure)("generate_caption", err);
                }
            }
            const caption = hook.slice(0, 150);
            const full = `${caption}\n\n${hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}`;
            return { caption, full_post: full };
        }
        case "flag_underperformer":
            return (0, contentDb_js_1.insertCutListItem)({
                contentAngle: String(input.angle_description || ""),
                reason: String(input.reason || ""),
                avgViewsWhenCut: Number(input.avg_views) || 0,
                timesTested: Number(input.times_tested) || 3,
                flaggedBy: "brain",
            });
        case "auto_approve_content": {
            const videoId = String(input.video_id || "");
            const video = (0, contentDb_js_1.getContentVideo)(videoId);
            if (!video)
                return { approved: false, reason: "Video not found" };
            if (video.complianceFlagged) {
                return { approved: false, reason: "Compliance flagged — requires human review" };
            }
            const pending = (0, contentDb_js_1.listPendingComplianceQueue)().some((p) => p.videoId === videoId);
            if (pending)
                return { approved: false, reason: "Pending compliance queue item" };
            if (!video.complianceNotes) {
                return { approved: false, reason: "No compliance check has been run" };
            }
            const perf = (0, contentDb_js_1.getLatestPerformance)(videoId);
            const score = perf?.score ?? 0;
            if (score < 60) {
                return { approved: false, reason: `Score ${score} below 60 threshold` };
            }
            (0, contentDb_js_1.updateContentVideo)(videoId, {
                status: "approved",
                approvedAt: new Date().toISOString(),
            });
            return { approved: true };
        }
        case "trigger_compliance_check": {
            const videoId = String(input.video_id || "");
            const result = await (0, compliance_js_1.runComplianceCheck)(videoId);
            return {
                passed: result.passed,
                flags: result.flags,
                brand_issues: result.brand_issues,
                recommendation: result.recommendation,
            };
        }
        case "send_harvey_briefing":
            return (0, contentDb_js_1.insertBriefing)({
                briefingType: String(input.briefing_type || "escalation"),
                title: String(input.title || ""),
                body: String(input.body || ""),
                keyMetrics: input.key_metrics && typeof input.key_metrics === "object"
                    ? input.key_metrics
                    : {},
                actionItems: Array.isArray(input.action_items) ? input.action_items.map(String) : [],
                sentToHarvey: true,
            });
        case "get_benchmark_trajectory":
            return (0, contentDb_js_1.computeBenchmarkTrajectory)();
        case "get_competitive_analysis": {
            const analysis = (0, contentDb_js_1.getLatestCompetitiveAnalysis)();
            const recommendations = analysis
                ? (0, contentDb_js_1.listStrategyRecommendations)({ analysisId: analysis.id, limit: 10 })
                : [];
            return { analysis, recommendations };
        }
        case "get_strategy_recommendations": {
            const status = input.status ? String(input.status) : undefined;
            const limit = Number(input.limit) || 10;
            if (status) {
                return { recommendations: (0, contentDb_js_1.listStrategyRecommendations)({ status, limit }) };
            }
            return { recommendations: (0, contentDb_js_1.getActiveStrategyRecommendations)().slice(0, limit) };
        }
        case "get_recording_tasks": {
            const days = Number(input.days) || 14;
            const status = input.status ? String(input.status) : "pending";
            const today = (0, contentDb_js_1.todayDateCst)();
            const end = new Date(`${today}T12:00:00`);
            end.setDate(end.getDate() + days);
            const endStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(end);
            return {
                tasks: (0, contentDb_js_1.listRecordingTasks)({
                    status,
                    dueAfter: today,
                    dueBefore: endStr,
                    limit: 50,
                }),
            };
        }
        case "get_calendar_week": {
            const weekStart = input.week_start ? String(input.week_start) : (0, stats_js_1.getWeekStart)();
            const days = [];
            for (let i = 0; i < 7; i++) {
                const d = new Date(`${weekStart}T12:00:00`);
                d.setDate(d.getDate() + i);
                const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
                days.push((0, calendar_js_1.getCalendarDayData)(dateStr));
            }
            return { week_start: weekStart, days };
        }
        case "create_recording_task": {
            const dueDate = String(input.due_date || (0, contentDb_js_1.todayDateCst)());
            const hooks = Array.isArray(input.suggested_hooks)
                ? input.suggested_hooks.map(String)
                : [String(input.topic || "")];
            const task = (0, contentDb_js_1.insertRecordingTask)({
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
            return { task };
        }
        case "get_sprint_progress":
            return (0, contentDb_js_2.getSprintProgressData)();
        case "run_competitive_analysis": {
            const { contentManagerBrain } = await Promise.resolve().then(() => __importStar(require("./index.js")));
            return {
                message: "Competitive analysis running — this calls Apify and may take 30-60 seconds.",
                analysis: await (0, competitiveAnalysis_js_1.runFullCompetitiveAnalysis)(contentManagerBrain),
            };
        }
        case "get_youtube_insights": {
            const analysis = (0, contentDb_js_1.getLatestYoutubeAnalysis)();
            if (!analysis) {
                return {
                    analysis: null,
                    message: "No YouTube analysis yet. It runs automatically on Sunday nights or can be triggered manually.",
                };
            }
            const daysSince = Math.floor((Date.now() - new Date(analysis.analyzedAt).getTime()) / (1000 * 60 * 60 * 24));
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
            const transcripts = (0, contentDb_js_1.listYoutubeTranscripts)({ channelName, limit });
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
        case "get_drive_folder_status": {
            const s = (0, googleDrivePull_js_1.getDriveStatus)();
            const pending = Math.max(0, s.known - s.processed);
            return {
                connected: s.configured && s.connected && s.folderAccessible,
                configured: s.configured,
                folder_accessible: s.folderAccessible,
                videos_in_folder: s.known,
                videos_processed: s.processed,
                videos_pending: pending, // detected but not yet pulled (downloading or waiting on disk space)
                last_poll_at: s.lastPollAt,
                last_error: s.lastError,
                note: !s.configured
                    ? "Google Drive not connected — GOOGLE_DRIVE_CREDENTIALS is not set."
                    : s.lastError
                        ? `Last poll had an error: ${s.lastError}`
                        : s.lastPollAt
                            ? "Healthy. Polls every 30 minutes."
                            : "Connected; first poll in progress (large videos download and clip one at a time).",
            };
        }
        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}
