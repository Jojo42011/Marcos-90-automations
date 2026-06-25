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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeDueAutoPlanSteps = executeDueAutoPlanSteps;
/**
 * HTTP server: GET / lead dashboard, POST /webhook & /simulate → pipeline (CORS on simulate/webhook).
 */
require("dotenv/config");
const http_1 = __importDefault(require("http"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const multer_1 = __importDefault(require("multer"));
const webhook_js_1 = require("./app/webhook.js");
const socialRefresh_js_1 = require("./app/socialRefresh.js");
const index_js_1 = require("./agents/socialMedia/index.js");
const jobs_js_1 = require("./app/jobs.js");
const socialStore_js_1 = require("./core/socialStore.js");
const index_js_2 = require("./agents/morningScan/index.js");
const index_js_3 = require("./agents/commentReply/index.js");
const index_js_4 = require("./agents/videoFeedback/index.js");
const index_js_5 = require("./agents/eveningPull/index.js");
const index_js_6 = require("./agents/reporting/index.js");
const index_js_7 = require("./agents/contentSuggestions/index.js");
const index_js_8 = require("./agents/escalations/index.js");
const index_js_9 = require("./agents/harveyContentDigest/index.js");
const db_js_1 = require("./core/db.js");
const crmNotificationStore_js_1 = require("./core/crmNotificationStore.js");
const index_js_10 = require("./agents/reEngagement/index.js");
const index_js_11 = require("./agents/listingStatusAutomation/index.js");
const index_js_12 = require("./agents/contentManager/index.js");
const index_js_13 = require("./agents/contentManager/brain/index.js");
const batchProcessor_js_1 = require("./agents/contentManager/batchProcessor.js");
const competitorIntel_js_1 = require("./agents/contentManager/competitorIntel.js");
const stats_js_1 = require("./agents/contentManager/brain/stats.js");
const tools_js_1 = require("./agents/contentManager/brain/tools.js");
const contentDb_js_1 = require("./core/contentDb.js");
const youtubeIntel_js_1 = require("./agents/contentManager/youtubeIntel.js");
const competitiveAnalysis_js_1 = require("./agents/contentManager/competitiveAnalysis.js");
const calendar_js_1 = require("./agents/contentManager/calendar.js");
const stats_js_2 = require("./agents/contentManager/brain/stats.js");
const autoPlans_js_1 = require("./core/autoPlans.js");
const tagTemplates_js_1 = require("./core/tagTemplates.js");
const leadFilter_js_1 = require("./core/leadFilter.js");
const users_js_1 = require("./core/users.js");
const types_js_1 = require("./core/types.js");
const types_js_2 = require("./core/types.js");
const tasks_js_1 = require("./core/tasks.js");
const marcoTasks_js_1 = require("./core/marcoTasks.js");
const harveyNotes_js_1 = require("./core/harveyNotes.js");
const deals_js_1 = require("./core/deals.js");
const transactionsStore_js_1 = require("./core/transactionsStore.js");
const documentFill_js_1 = require("./core/documentFill.js");
const index_js_14 = require("./agents/transactionDeadlines/index.js");
const inspectionFlow_js_1 = require("./agents/transactionFlows/inspectionFlow.js");
const postCloseFlow_js_1 = require("./agents/transactionFlows/postCloseFlow.js");
const index_js_15 = require("./agents/leadScoring/index.js");
const warmLeadFlow_js_1 = require("./agents/leadNurture/warmLeadFlow.js");
const coldLeadFlow_js_1 = require("./agents/leadNurture/coldLeadFlow.js");
const sourceRouting_js_1 = require("./agents/leadNurture/sourceRouting.js");
const leadScoreStore_js_1 = require("./core/leadScoreStore.js");
const dailyDigest_js_1 = require("./agents/reporting/dailyDigest.js");
const weeklyKPI_js_1 = require("./agents/reporting/weeklyKPI.js");
const reportingStore_js_1 = require("./core/reportingStore.js");
const financeStore_js_1 = require("./core/financeStore.js");
const index_js_16 = require("./agents/finance/index.js");
const state_js_1 = require("./core/state.js");
const dialSession_js_1 = require("./core/dialSession.js");
const callAssistant_js_1 = require("./core/callAssistant.js");
const forewarn_js_1 = require("./integrations/forewarn.js");
const db_js_2 = require("./core/db.js");
const index_js_17 = require("./integrations/sinch/index.js");
const index_js_18 = require("./integrations/twilio/index.js");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const index_js_19 = require("./integrations/llm/index.js");
const adsUpstream_js_1 = require("./harvey/adsUpstream.js");
const crypto_1 = require("crypto");
const index_js_20 = require("./harvey/index.js");
const index_js_21 = require("./hull/index.js");
const deepgramProxy_js_1 = require("./hull/voice/deepgramProxy.js");
const ws_1 = require("ws");
const smsStore_js_1 = require("./core/smsStore.js");
const inboundReplyHelper_js_1 = require("./app/inboundReplyHelper.js");
const index_js_22 = require("./agents/showingReminders/index.js");
const index_js_23 = require("./agents/mojoOutreach/index.js");
const index_js_24 = require("./agents/conversationEscalations/index.js");
const textingRules_js_1 = require("./core/textingRules.js");
const marcoLog_js_1 = require("./app/marcoLog.js");
const index_js_25 = require("./integrations/openshorts/index.js");
const http_proxy_middleware_1 = require("http-proxy-middleware");
const index_js_26 = require("./integrations/voxcpm/index.js");
const safetyLock_js_1 = require("./agents/voiceClone/safetyLock.js");
const voiceCloneStore_js_1 = require("./core/voiceCloneStore.js");
const app = (0, express_1.default)();
const PORT = parseInt(process.env.PORT || "3000", 10);
app.use("/openshorts", (0, http_proxy_middleware_1.createProxyMiddleware)({
    target: process.env.OPENSHORTS_URL || "http://localhost:8000",
    changeOrigin: true,
    pathRewrite: { "^/openshorts": "" },
}));
/** Base URL of the Flask ad dashboard (no trailing slash), e.g. http://127.0.0.1:5050 or https://your-ad-app.fly.dev */
const AD_DASHBOARD_BASE_URL = process.env.AD_DASHBOARD_BASE_URL?.trim().replace(/\/$/, "") || "";
/** Optional Bearer token sent to the ad app if you add auth there later */
const AD_DASHBOARD_API_KEY = process.env.AD_DASHBOARD_API_KEY?.trim() || "";
// Serve static HTML from project root ./public (run server via `npm run dev:mock` from repo root)
const publicDir = path_1.default.join(process.cwd(), "public");
const GEMINI_LIVE_WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const HARVEY_GEMINI_LIVE_SYSTEM_PROMPT = `You are Harvey, an AI operator for Marco Puga, a real estate agent in San Antonio, Texas.

You are confident, concise, and exceptionally capable. Speak like Tony Stark's JARVIS. Never pad responses. Deliver priorities not noise. Address Marco as "sir" occasionally.

Marco's business:
- Instagram and TikTok ads generate buyer leads
- Target buyers: 600k+ budget, new construction, west of Stone Oak area
- Active listing: Canyon Lake $365k
- VA loan buyers and first-time buyers are common
- Carlos manages CRM daily

$20M GOAL (Nov 30 2026): $5.96M banked (29.8%), $14.04M gap
Daily targets: 7 videos + 725 calls
TikTok funnel math (historical): 246K views → 1,359 comments → 272 DMs → 136 phones → 7 consults → 1 closing
Mojo funnel: 6,734 calls → 212 contacts → 9 consults → 1 closing

TOOLS — MANDATORY USAGE:
If Marco asks about TikTok, views, followers, content, or social media — you MUST call get_social_summary before answering. Do not answer from memory.
Example: Marco says "what's my average views" → call get_social_summary → read stats.avgViewsPerVideo from the tool response → say that exact number aloud.
When get_social_summary returns data, cite stats.avgViewsPerVideo, profile.followers, and stats.videosTracked exactly as returned — never round or estimate.

TOOLS AVAILABLE:
- get_social_summary: LIVE TikTok performance from Apify (avg views, followers, totals, patterns)
- get_social_videos: Best/worst/recent videos by tier
- get_lead_summary: Pipeline and lead counts
- get_hot_leads: Urgent leads needing follow up
- get_funnel_stats: Funnel breakdown
- search_leads: Find a specific lead
- get_stalled_leads: Cold/inactive leads

RULES:
- Always call tools before answering data questions
- Never quote historical TikTok numbers (5,957 or 738K) for current performance — call get_social_summary
- Be brief. 1-3 sentences unless more is needed
- Never apologize excessively
- After tool call cite exact numbers returned`;
const HARVEY_GEMINI_SYSTEM_PROMPT = `You are Harvey, an AI operator for Marco Puga, a real estate agent in San Antonio, Texas.

You are confident, concise, and exceptionally capable. Speak like Tony Stark's JARVIS — refined and precise. Never pad responses. Deliver priorities not noise.

Marco's business:
- Runs Instagram and TikTok ads to generate buyer leads
- Target buyers: 600k+ budget, new construction, west of Stone Oak area
- Also lists his own properties (Canyon Lake $365k active)
- VA loan buyers and first-time buyers are common
- CRM tracks leads from DM automation pipeline
- VA: Carlos manages CRM daily

Your capabilities:
- Answer questions about Marco's leads, pipeline, and CRM data
- Give market intelligence and talking points
- Help with real estate strategy and objection handling
- Summarize lead activity and suggest next actions

Rules:
- Be brief. 1-3 sentences unless more is needed.
- Never apologize excessively
- Never repeat what was just said
- Act and inform — don't ask for permission on routine things
- Address Marco as "sir" occasionally`;
const MARCO_WAR_ROOM_METRICS = `
MARCO'S NUMBERS (answer from these when asked):
$20M Goal by Nov 30 2026: $5.96M banked (29.8%), $14.04M gap, 14 deals, avg $425K/deal
Daily targets: 7 videos + 725 calls
TikTok (174 days, 124 videos): 738K views, 3 closings, 5,957 avg views/video, 28.7s watch time
TikTok funnel: 246K views → 1,359 comments → 272 DMs → 136 phones → 7 consults → 1 closing
At 5 vids/week = 1 closing/8wks. Need 10.3 vids/week for monthly closing.
Mojo (Jan-May 2026): 26,938 calls → 846 contacts → 4 closings, 1 contact per 32 calls
Mojo funnel: 6,734 calls → 212 contacts → 9 consults → 1 closing
Cold calling is 36x more efficient per touch than TikTok
`;
function geminiApiKey() {
    return process.env.GEMINI_API_KEY?.trim() || "";
}
function geminiLiveModel() {
    return process.env.GEMINI_LIVE_MODEL?.trim() || "gemini-3.1-flash-live-preview";
}
const GEMINI_LIVE_SYSTEM_PROMPT_MAX = 4000;
function trimGeminiSystemPrompt(prompt) {
    if (prompt.length <= GEMINI_LIVE_SYSTEM_PROMPT_MAX)
        return prompt;
    const trimmed = prompt.slice(0, GEMINI_LIVE_SYSTEM_PROMPT_MAX - 32).trimEnd();
    console.warn(`[GeminiLive] System prompt truncated from ${prompt.length} to ${trimmed.length} chars (max ${GEMINI_LIVE_SYSTEM_PROMPT_MAX})`);
    return `${trimmed}\n\n[Context truncated for Live API limit]`;
}
app.get("/health", async (_req, res) => {
    const apiKeyConfigured = (0, index_js_19.isAnthropicApiKeyConfigured)();
    const openShortsHealth = await (0, index_js_25.checkOpenShortsHealth)().catch(() => ({ running: false }));
    res.status(200).json({
        ok: true,
        anthropic: {
            api_key_configured: apiKeyConfigured,
            model: (0, index_js_19.getAnthropicModel)(),
            hint: apiKeyConfigured
                ? "Haiku runs for preflight, opening, and pipeline when those paths call the API (billing and valid JSON still required)."
                : "Set ANTHROPIC_API_KEY on the host. Without it, DMs use hardcoded fallbacks only.",
        },
        twilio: {
            configured: (0, index_js_18.isTwilioConfigured)(),
            hint: (0, index_js_18.isTwilioConfigured)()
                ? "Outbound SMS available; inbound webhook should point to POST /webhook/twilio"
                : "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER for SMS handoff from CRM.",
        },
        harvey: {
            model: (0, index_js_20.getHarveyModel)(),
            api_key_configured: (0, index_js_19.isAnthropicApiKeyConfigured)(),
            hull: "aethon-intelligence",
            voice: {
                engine: process.env.DEEPGRAM_API_KEY ? "deepgram-flux" : "none",
                deepgram_configured: Boolean(process.env.DEEPGRAM_API_KEY?.trim()),
                brain: "claude",
                tts: geminiApiKey() ? "gemini" : "none",
                gemini_configured: Boolean(geminiApiKey()),
            },
        },
        openshorts: {
            running: openShortsHealth.running,
            model: "model" in openShortsHealth ? openShortsHealth.model || "gemini-2.5-flash" : "gemini-2.5-flash",
            active_jobs: "activeJobs" in openShortsHealth ? openShortsHealth.activeJobs || 0 : 0,
        },
    });
});
/** OpenClaw — OpenAI-compatible brain endpoint (WhatsApp / messaging gateway). */
app.post("/v1/chat/completions", express_1.default.json({ limit: "256kb" }), async (req, res) => {
    if (!(0, index_js_19.isAnthropicApiKeyConfigured)()) {
        res.status(503).json({ error: "ANTHROPIC_API_KEY not configured" });
        return;
    }
    try {
        const { handleOpenClawChatCompletions } = await Promise.resolve().then(() => __importStar(require("./hull/openclaw.js")));
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const { status, json } = await handleOpenClawChatCompletions(body);
        res.status(status).json(json);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[openclaw] /v1/chat/completions", msg);
        res.status(500).json({ error: msg });
    }
});
app.post("/v1/sessions/reset", express_1.default.json(), async (req, res) => {
    const sessionId = typeof req.body?.sessionId === "string" && req.body.sessionId.trim()
        ? req.body.sessionId.trim()
        : "harvey";
    const { resetOpenClawSession } = await Promise.resolve().then(() => __importStar(require("./hull/openclaw.js")));
    resetOpenClawSession(sessionId);
    res.json({ ok: true, message: "Thread cleared. Memory saved. Fresh start.", sessionId });
});
app.get("/v1/sessions/:sessionId", async (req, res) => {
    const sessionId = String(req.params.sessionId || "harvey").trim();
    const { getOpenClawSession } = await Promise.resolve().then(() => __importStar(require("./hull/openclaw.js")));
    res.json(getOpenClawSession(sessionId));
});
app.get("/", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "dashboard.html"));
});
app.get("/dashboard", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "dashboard.html"));
});
/** Legacy DM simulator */
app.get("/chat", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "chat.html"));
});
app.get("/jarvis", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "jarvis.html"));
});
app.get("/memory", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "memory.html"));
});
app.get("/tasks", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "tasks.html"));
});
app.get("/social", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "social.html"));
});
app.get("/email-marketing", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "email-marketing.html"));
});
app.get("/lead-nurture", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "lead-nurture.html"));
});
app.get("/reporting", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "reporting.html"));
});
app.get("/finance", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "finance.html"));
});
app.get("/voice-clone", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "voice-clone.html"));
});
const voiceCloneDataRoot = (0, voiceCloneStore_js_1.resolveVoiceCloneDataRoot)();
app.use("/voice-clone-files", express_1.default.static(voiceCloneDataRoot));
function mapVoiceCloneFileUrl(filePath, voxcpmApiUrl) {
    if (!filePath)
        return "";
    const root = path_1.default.normalize(voiceCloneDataRoot);
    const normPath = path_1.default.normalize(filePath);
    if (normPath.startsWith(root)) {
        const rel = path_1.default.relative(root, normPath).replace(/\\/g, "/");
        return `/voice-clone-files/${rel}`;
    }
    if (voxcpmApiUrl && !filePath.startsWith("http")) {
        const base = voxcpmApiUrl.replace(/\/$/, "");
        const filename = path_1.default.basename(filePath);
        return `${base}/audio/${filename}`;
    }
    return filePath;
}
function enrichVoiceoverRequest(req) {
    if (!req)
        return null;
    const voxcpmUrl = process.env.VOXCPM_API_URL?.trim();
    const audioUrls = (req.outputFilePaths || []).map((p) => mapVoiceCloneFileUrl(p, voxcpmUrl));
    const exportUrl = req.exportFilePath
        ? mapVoiceCloneFileUrl(req.exportFilePath, voxcpmUrl)
        : undefined;
    return { ...req, audioUrls, exportUrl };
}
app.get("/crm-followup-tasks.js", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "crm-followup-tasks.js"));
});
function dashboardTokenOk(req) {
    return dashboardTokenOkIncoming(req);
}
function dashboardTokenOkIncoming(req) {
    const expected = process.env.DASHBOARD_TOKEN?.trim();
    if (!expected)
        return true;
    let q = "";
    if ("query" in req && req.query && typeof req.query.token === "string") {
        q = req.query.token;
    }
    else {
        try {
            const host = req.headers.host || "localhost";
            const url = new URL(req.url || "/", `http://${host}`);
            q = url.searchParams.get("token") || "";
        }
        catch {
            q = "";
        }
    }
    const auth = req.headers.authorization;
    const bearer = typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
        ? auth.slice(7).trim()
        : "";
    return q === expected || bearer === expected;
}
app.get("/api/dashboard/data", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    try {
        const data = await (0, db_js_1.getDashboardSnapshot)();
        res.status(200).json(data);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.get("/api/social/data", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    try {
        res.status(200).json((0, socialRefresh_js_1.getSocialTikTokData)());
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.post("/api/social/refresh", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    try {
        const data = await (0, socialRefresh_js_1.refreshSocialTikTokData)();
        res.status(200).json(data);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[social] refresh failed:", message);
        res.status(502).json({ error: message });
    }
});
app.get("/api/social/test", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    try {
        const summary = (0, socialStore_js_1.getSocialSummaryForHarvey)();
        const sampleVideos = (0, socialStore_js_1.getSocialVideos)({ limit: 3 });
        const stats = summary.stats;
        res.status(200).json({
            summary,
            avgViewsPerVideo: stats?.avgViewsPerVideo ?? summary.avg_views,
            dashboardAvgViews: summary.avg_views,
            sampleVideos,
            toolsAvailable: [
                "get_social_summary",
                "get_social_videos",
                "get_morning_scan",
                "get_pending_comment_replies",
            ],
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.get("/api/social/video-scores", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    try {
        const tier = typeof req.query.tier === "string" ? req.query.tier : "all";
        const sort = typeof req.query.sort === "string" ? req.query.sort : "score_desc";
        const data = (0, socialStore_js_1.getLatestSocialDashboardData)();
        let videos = (data.videos || []).map((v) => ({
            ...v,
            improvements: (0, socialStore_js_1.getVideoImprovements)(v.id) ?? null,
        }));
        if (tier && tier !== "all") {
            videos = videos.filter((v) => {
                const t = v.scoreBreakdown?.tier ?? v.tier;
                return t === tier || (tier === "warm" && t === "average");
            });
        }
        if (sort === "score_asc") {
            videos.sort((a, b) => (a.scoreBreakdown?.score ?? a.score ?? 0) - (b.scoreBreakdown?.score ?? b.score ?? 0));
        }
        else if (sort === "recent") {
            videos.sort((a, b) => new Date(b.postedAt || 0).getTime() - new Date(a.postedAt || 0).getTime());
        }
        else if (sort === "views") {
            videos.sort((a, b) => (b.views || 0) - (a.views || 0));
        }
        else {
            videos.sort((a, b) => (b.scoreBreakdown?.score ?? b.score ?? 0) - (a.scoreBreakdown?.score ?? a.score ?? 0));
        }
        res.json({ videos });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.post("/api/social/video-improvements/:postId", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    try {
        const postId = String(req.params.postId || "");
        const data = (0, socialStore_js_1.getLatestSocialDashboardData)();
        const video = (data.videos || []).find((v) => v.id === postId);
        if (!video) {
            res.status(404).json({ error: "Video not found" });
            return;
        }
        const breakdown = video.scoreBreakdown ?? {
            score: video.score ?? 0,
            viewsScore: 0,
            retentionScore: 0,
            savesScore: 0,
            sharesScore: 0,
            tier: video.tier ?? "cold",
        };
        const improvements = await (0, index_js_4.generateVideoImprovements)({
            description: video.caption || "",
            views: video.views || 0,
            likes: video.likes || 0,
            comments: video.comments || 0,
            shares: video.shares || 0,
            saves: video.saves || 0,
            scoreBreakdown: breakdown,
        });
        (0, socialStore_js_1.saveVideoImprovements)(postId, improvements);
        res.json({ improvements });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.post("/api/social/video-improvements/generate-all", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    try {
        const data = (0, socialStore_js_1.getLatestSocialDashboardData)();
        const videos = data.videos || [];
        let generated = 0;
        for (const video of videos) {
            const postId = video.id;
            const existing = (0, socialStore_js_1.getVideoImprovements)(postId);
            if (existing)
                continue;
            const breakdown = video.scoreBreakdown ?? {
                score: video.score ?? 0,
                viewsScore: 0,
                retentionScore: 0,
                savesScore: 0,
                sharesScore: 0,
                tier: video.tier ?? "cold",
            };
            const improvements = await (0, index_js_4.generateVideoImprovements)({
                description: video.caption || "",
                views: video.views || 0,
                likes: video.likes || 0,
                comments: video.comments || 0,
                shares: video.shares || 0,
                saves: video.saves || 0,
                scoreBreakdown: breakdown,
            });
            (0, socialStore_js_1.saveVideoImprovements)(postId, improvements);
            generated++;
            await new Promise((r) => setTimeout(r, 500));
        }
        res.json({ generated, total: videos.length });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.get("/api/social/refresh-schedule", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const time = (0, socialStore_js_1.getSocialRefreshTime)();
    res.json({ time });
});
app.post("/api/social/refresh-schedule", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const time = typeof body.time === "string" ? body.time : "";
    if (!time || !/^\d{2}:\d{2}$/.test(time)) {
        res.status(400).json({ error: "time must be HH:MM format" });
        return;
    }
    (0, socialStore_js_1.setSocialRefreshTime)(time);
    res.json({ success: true, time });
});
app.get("/api/evening-pull/latest", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    res.json({ result: (0, index_js_6.getLatestReportingSnapshot)("evening") });
});
app.post("/api/evening-pull/run", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    try {
        const result = await (0, index_js_5.runEveningPull)();
        res.json({ result });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.get("/api/reporting/recent", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const limitRaw = req.query.limit;
    const limit = typeof limitRaw === "string" && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : 14;
    res.json({ snapshots: (0, index_js_6.getRecentReportingSnapshots)(limit) });
});
app.get("/api/content-suggestions/latest", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    res.json({ result: (0, index_js_7.getLatestContentSuggestions)() });
});
app.post("/api/content-suggestions/generate", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    try {
        const result = await (0, index_js_7.generateWeeklyContentSuggestions)();
        res.json({ result });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.get("/api/agent/pull-log", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const limitRaw = req.query.limit;
    const limit = typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
        ? parseInt(limitRaw, 10)
        : 20;
    res.json({ pulls: (0, socialStore_js_1.getRecentAgentPulls)(limit) });
});
app.get("/api/agent/pull-log/today", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    res.json({ pulls: (0, socialStore_js_1.getTodaysAgentPulls)() });
});
app.get("/api/agent/status", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const digest = (0, index_js_9.getLatestContentDigest)();
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    let lastRunAt = null;
    let nextRunAt = null;
    let msUntilNext = null;
    if (digest) {
        lastRunAt = digest.generatedAt;
        const nextRunMs = new Date(digest.generatedAt).getTime() + THREE_DAYS_MS;
        nextRunAt = new Date(nextRunMs).toISOString();
        msUntilNext = Math.max(0, nextRunMs - Date.now());
    }
    else {
        nextRunAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        msUntilNext = 60 * 60 * 1000;
    }
    res.json({
        lastRunAt,
        nextRunAt,
        msUntilNext,
        intervalDays: 3,
    });
});
app.get("/api/escalations/recent", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const limitRaw = req.query.limit;
    const limit = typeof limitRaw === "string" && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : 20;
    res.json({ escalations: (0, index_js_8.getRecentEscalations)(limit) });
});
app.post("/api/escalations/check-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    try {
        await (0, index_js_8.runAllEscalationChecks)();
        res.json({ success: true });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.get("/api/morning-scan/latest", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const result = (0, index_js_2.getLatestMorningScan)();
    res.json({ result });
});
app.post("/api/morning-scan/run", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    try {
        const result = await (0, index_js_2.runMorningScan)();
        res.json({ result });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.get("/api/comment-replies/pending", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const replies = (0, socialStore_js_1.getPendingCommentReplies)();
    res.json({ replies });
});
app.post("/api/comment-replies/:id/approve", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    (0, socialStore_js_1.updateCommentReplyStatus)(parseInt(String(req.params.id), 10), "approved");
    res.json({ success: true });
});
app.post("/api/comment-replies/:id/reject", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    (0, socialStore_js_1.updateCommentReplyStatus)(parseInt(String(req.params.id), 10), "rejected");
    res.json({ success: true });
});
app.post("/api/comment-replies/generate", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const commentText = typeof body.commentText === "string" ? body.commentText : "";
    const authorUsername = typeof body.authorUsername === "string" ? body.authorUsername : "";
    const postId = typeof body.postId === "string" ? body.postId : undefined;
    if (!commentText || !authorUsername) {
        res.status(400).json({ error: "commentText and authorUsername required" });
        return;
    }
    try {
        const reply = await (0, index_js_3.generateCommentReply)(commentText, authorUsername, postId);
        res.json({ reply });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.patch("/api/crm/lead/:id", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    if (!id) {
        res.status(400).json({ error: "Missing lead id" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const crmStatusRaw = typeof body.crmStatus === "string" ? body.crmStatus : undefined;
    const crmStatus = crmStatusRaw !== undefined ? (0, db_js_2.normalizeCrmStatus)(crmStatusRaw) : undefined;
    const crmStage = typeof body.crmStage === "string" ? body.crmStage : undefined;
    const crmPriority = typeof body.crmPriority === "string" ? body.crmPriority : undefined;
    const crmIntent = typeof body.crmIntent === "string" ? body.crmIntent : undefined;
    const crmCallQueueRaw = typeof body.crmCallQueue === "string" ? body.crmCallQueue : undefined;
    const crmCallQueue = crmCallQueueRaw === "urgent" || crmCallQueueRaw === "routine" || crmCallQueueRaw === "none"
        ? crmCallQueueRaw
        : undefined;
    const crmNotes = body.crmNotes === null ? null : typeof body.crmNotes === "string" ? body.crmNotes : undefined;
    const name = body.name === null ? null : typeof body.name === "string" ? body.name : undefined;
    const email = body.email === null ? null : typeof body.email === "string" ? body.email : undefined;
    const phone = body.phone === null ? null : typeof body.phone === "string" ? body.phone : undefined;
    const source = body.source === null ? null : typeof body.source === "string" ? body.source : undefined;
    const propertyInquired = body.propertyInquired === null
        ? null
        : typeof body.propertyInquired === "string"
            ? body.propertyInquired
            : undefined;
    const brivityId = body.brivityId === null ? null : typeof body.brivityId === "string" ? body.brivityId : undefined;
    const tags = body.tags !== undefined ? (0, db_js_2.normalizeCrmTags)(body.tags) : undefined;
    const assignedUserId = body.assignedUserId === null
        ? null
        : typeof body.assignedUserId === "string"
            ? body.assignedUserId.trim() || null
            : undefined;
    const assignedUserName = body.assignedUserName === null
        ? null
        : typeof body.assignedUserName === "string"
            ? body.assignedUserName.trim() || null
            : undefined;
    const deal = body.deal !== undefined ? body.deal : undefined;
    const activity = body.activity !== undefined ? body.activity : undefined;
    const skipTraceResults = body.skipTraceResults !== undefined ? body.skipTraceResults : undefined;
    const phoneNumberSeen = body.phoneNumberSeen === true ? true : body.phoneNumberSeen === false ? false : undefined;
    const preApprovalStatus = body.preApprovalStatus === null
        ? null
        : typeof body.preApprovalStatus === "string"
            ? body.preApprovalStatus
            : undefined;
    const propertyViewsCount = typeof body.propertyViewsCount === "number" ? body.propertyViewsCount : undefined;
    let criteria = undefined;
    if (body.criteria === null)
        criteria = null;
    else if (body.criteria && typeof body.criteria === "object") {
        const c = body.criteria;
        criteria = {};
        if ("priceCap" in c) {
            const n = c.priceCap;
            criteria.priceCap = n === null || n === "" ? null : typeof n === "number" ? n : Number(n);
        }
        if ("beds" in c) {
            const n = c.beds;
            criteria.beds = n === null || n === "" ? null : typeof n === "number" ? n : Number(n);
        }
        if ("baths" in c) {
            const n = c.baths;
            criteria.baths = n === null || n === "" ? null : typeof n === "number" ? n : Number(n);
        }
        if ("area" in c) {
            criteria.area = c.area === null ? null : typeof c.area === "string" ? c.area : String(c.area);
        }
        if ("timeline" in c) {
            criteria.timeline =
                c.timeline === null || c.timeline === ""
                    ? null
                    : typeof c.timeline === "string"
                        ? c.timeline
                        : String(c.timeline);
        }
    }
    try {
        const updated = await (0, db_js_1.updateLeadCrmFields)({
            leadId: id,
            crmStatus: crmStatus,
            crmStage: crmStage,
            crmPriority: crmPriority,
            crmIntent: crmIntent !== undefined ? (0, db_js_1.normalizeCrmIntent)(crmIntent) : undefined,
            crmCallQueue,
            crmNotes,
            name,
            email,
            phone,
            source,
            propertyInquired,
            brivityId,
            criteria: criteria,
            tags,
            assignedUserId,
            assignedUserName,
            deal,
            activity,
            skipTraceResults,
            phoneNumberSeen,
            preApprovalStatus: preApprovalStatus,
            propertyViewsCount,
        });
        if (!updated) {
            res.status(404).json({ error: "Lead not found" });
            return;
        }
        res.status(200).json({ ok: true });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
async function handleMassDeleteLeads(req, res) {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    const leadIds = req.body?.leadIds;
    if (!Array.isArray(leadIds) || leadIds.length === 0) {
        res.status(400).json({ error: "leadIds array required" });
        return;
    }
    const ids = leadIds.map((id) => String(id || "").trim()).filter(Boolean);
    if (!ids.length) {
        res.status(400).json({ error: "leadIds array required" });
        return;
    }
    try {
        const deleted = await (0, db_js_1.deleteLeads)(ids);
        console.log("[MassDelete] Deleted", deleted, "of", ids.length, "requested leads");
        res.json({ deleted, requested: ids.length });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
}
app.post("/api/leads/mass-delete", express_1.default.json(), handleMassDeleteLeads);
console.log("[Routes] POST /api/leads/mass-delete registered");
app.post("/api/crm/leads/mass-delete", express_1.default.json(), handleMassDeleteLeads);
console.log("[Routes] POST /api/crm/leads/mass-delete registered");
app.post("/api/crm/lead/:id/mark-phone-seen", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    if (!id) {
        res.status(400).json({ error: "Missing lead id" });
        return;
    }
    try {
        const updated = await (0, db_js_1.updateLeadCrmFields)({ leadId: id, phoneNumberSeen: true });
        if (!updated) {
            res.status(404).json({ error: "Lead not found" });
            return;
        }
        res.json({ success: true });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.get("/api/sms/thread/:leadId", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    const leadId = String(req.params.leadId || "").trim();
    if (!leadId) {
        res.status(400).json({ error: "Missing lead id" });
        return;
    }
    const thread = (0, smsStore_js_1.getThreadForLead)(leadId);
    res.json({ thread });
});
app.post("/api/crm/lead/:id/showing", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const address = typeof body.address === "string" ? body.address.trim() : "";
    const scheduledAt = typeof body.scheduledAt === "string" ? body.scheduledAt.trim() : "";
    if (!address || !scheduledAt) {
        res.status(400).json({ error: "address and scheduledAt required" });
        return;
    }
    try {
        const updated = await (0, db_js_1.updateLeadCrmFields)({
            leadId: id,
            showingAppointment: {
                address,
                scheduledAt,
                confirmationStatus: "pending",
            },
        });
        if (!updated) {
            res.status(404).json({ error: "Lead not found" });
            return;
        }
        res.json({ success: true, showingAppointment: updated.showingAppointment });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.get("/api/showings/upcoming", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    try {
        const upcoming = await (0, index_js_22.getUpcomingShowings)();
        res.json({ upcoming });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.post("/api/showings/check-reminders", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    try {
        const result = await (0, index_js_22.checkAndSendShowingReminders)();
        res.json(result);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.post("/api/mojo-outreach/run", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    try {
        const result = await (0, index_js_23.runMojoOutreachSequence)();
        res.json(result);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.get("/api/texting-rules/status/:leadId", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    const leadId = String(req.params.leadId || "").trim();
    if (!leadId) {
        res.status(400).json({ error: "Missing lead id" });
        return;
    }
    const gate = (0, textingRules_js_1.checkTextingAllowed)(leadId);
    const withinHours = (0, textingRules_js_1.isWithinTextingHours)();
    res.json({ ...gate, withinHours });
});
app.post("/api/crm/lead/:id/resume-automation", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    try {
        const updated = await (0, db_js_1.updateLeadCrmFields)({
            leadId: id,
            automationPaused: false,
            automationPausedReason: null,
            automationPausedAt: null,
        });
        if (!updated) {
            res.status(404).json({ error: "Lead not found" });
            return;
        }
        console.log("[ConvEscalation] Automation resumed for", id);
        res.json({ success: true });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.get("/api/crm/leads/paused", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    try {
        const leads = (await (0, db_js_1.listAllLeads)()).filter((l) => l.automationPaused);
        res.json({
            paused: leads.map((l) => ({
                leadId: l.id,
                name: l.name || l.username,
                phone: l.phone,
                reason: l.automationPausedReason,
                pausedAt: l.automationPausedAt,
            })),
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
/** CRM: manually add a lead from the dashboard (not from ManyChat). */
app.post("/api/crm/lead", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
    const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
    const name = [firstName, lastName].filter(Boolean).join(" ") || null;
    const phoneRaw = typeof body.phone === "string" ? body.phone.trim() : "";
    const digits = phoneRaw.replace(/\D/g, "");
    const phone = digits.length === 10
        ? digits
        : digits.length === 11 && digits.startsWith("1")
            ? digits.slice(1)
            : null;
    if (!phone) {
        res.status(400).json({ error: "A valid US phone number is required" });
        return;
    }
    const existing = await (0, db_js_1.findLeadByPhoneDigits)(phone);
    if (existing) {
        res.status(409).json({ error: "A lead with this phone already exists", leadId: existing.id });
        return;
    }
    const email = typeof body.email === "string" && body.email.trim() ? body.email.trim() : null;
    const crmStatus = (0, db_js_2.normalizeCrmStatus)(body.crmStatus);
    const crmStage = (["new", "hot", "warm", "cold", "pending", "appointment_set", "showing_set", "under_contract", "closed"].includes(String(body.crmStage || ""))
        ? body.crmStage
        : "new");
    const crmIntent = (0, db_js_1.normalizeCrmIntent)(body.crmIntent);
    const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "Manual";
    const personType = typeof body.personType === "string" ? body.personType.trim() : "Lead";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const company = typeof body.company === "string" ? body.company.trim() : "";
    const street = typeof body.street === "string" ? body.street.trim() : "";
    const city = typeof body.city === "string" ? body.city.trim() : "";
    const stateAddr = typeof body.state === "string" ? body.state.trim() : "";
    const zip = typeof body.zip === "string" ? body.zip.trim() : "";
    const areaParts = [city, stateAddr, zip].filter(Boolean);
    const notesParts = [
        personType !== "Lead" ? `Person type: ${personType}` : "",
        description,
        company ? `Company: ${company}` : "",
        street ? `Address: ${[street, ...areaParts].filter(Boolean).join(", ")}` : areaParts.length ? `Area: ${areaParts.join(", ")}` : "",
    ].filter(Boolean);
    const userId = `manual-${phone}`;
    try {
        const lead = await (0, db_js_1.createLead)({
            platform: "manual",
            userId,
            username: null,
            name,
            phone,
            email,
            state: state_js_1.FunnelStage.New,
            source,
            propertyInquired: null,
            criteria: areaParts.length ? { priceCap: null, beds: null, baths: null, area: areaParts.join(", ") } : null,
            brivityId: null,
            crmStatus,
            crmStage,
            crmPriority: "normal",
            crmIntent: crmIntent,
            crmCallQueue: "none",
            crmNotes: notesParts.length ? notesParts.join("\n") : null,
            adCampaign: null,
        });
        res.status(201).json({ ok: true, leadId: lead.id });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
function harveyDeps() {
    return {
        adDashboardBaseUrl: AD_DASHBOARD_BASE_URL,
        adDashboardApiKey: AD_DASHBOARD_API_KEY,
    };
}
app.get("/api/ads/summary", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    if (!AD_DASHBOARD_BASE_URL) {
        res.status(503).json({
            error: "Ads dashboard not linked",
            hint: "Set AD_DASHBOARD_BASE_URL to your Flask app base URL (e.g. http://127.0.0.1:5050)",
        });
        return;
    }
    try {
        const summary = await (0, adsUpstream_js_1.fetchAdsSummaryFromUpstream)(AD_DASHBOARD_BASE_URL, AD_DASHBOARD_API_KEY);
        res.status(200).json(summary);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[ads/summary]", message);
        res.status(502).json({ error: message, hint: "Is the ad Flask app running and reachable?" });
    }
});
/** Harvey ops snapshot (perception + judgment, no LLM). */
app.get("/api/jarvis/ops", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    try {
        const ops = await (0, index_js_20.runHarveyOps)(harveyDeps());
        res.status(200).json(ops);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[jarvis/ops]", message);
        res.status(500).json({ error: message });
    }
});
app.post("/api/jarvis/chat", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
        res.status(400).json({ error: "Missing message" });
        return;
    }
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : undefined;
    try {
        const result = await (0, index_js_20.runHarveyChat)({
            message,
            sessionId,
            deps: harveyDeps(),
        });
        res.status(200).json(result);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[jarvis/chat]", msg);
        res.status(500).json({ error: msg });
    }
});
/** Aethon voice command — Claude brain (not Gemini Live). */
function findFirstSentenceBoundary(text) {
    const match = text.match(/[.!?…]\s/);
    return match ? match.index + 1 : -1;
}
app.post("/api/jarvis/voice/command", express_1.default.json({ limit: "64kb" }), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
        res.status(400).json({ error: "Missing message" });
        return;
    }
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : undefined;
    const streamMode = req.body?.stream === true;
    if (streamMode) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        let accumulated = "";
        let firstChunkSent = false;
        try {
            const result = await (0, index_js_20.runHarveyChat)({
                message,
                sessionId,
                deps: harveyDeps(),
                voiceMode: true,
                onToken: (t) => {
                    accumulated += t;
                    if (!firstChunkSent) {
                        const boundary = findFirstSentenceBoundary(accumulated);
                        if (boundary > 0) {
                            const first = accumulated.slice(0, boundary).trim();
                            if (first.length > 10) {
                                firstChunkSent = true;
                                res.write(`data: ${JSON.stringify({ type: "speech_chunk", text: first, isFinal: false })}\n\n`);
                                console.log("[Voice Command] Streamed first sentence at", first.length, "chars");
                            }
                        }
                    }
                },
            });
            res.write(`data: ${JSON.stringify({
                type: "speech_complete",
                speech: result.speech,
                sessionId: result.sessionId,
            })}\n\n`);
            res.end();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.write(`data: ${JSON.stringify({ type: "error", error: msg })}\n\n`);
            res.end();
        }
        return;
    }
    try {
        const result = await (0, index_js_20.runHarveyChat)({
            message,
            sessionId,
            deps: harveyDeps(),
            voiceMode: true,
        });
        res.status(200).json({ speech: result.speech, sessionId: result.sessionId });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
    }
});
/** First-open-of-day activation brief. */
app.get("/api/jarvis/activation", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    try {
        const packet = await (0, index_js_21.buildMemoryPacketForQuery)("morning activation brief");
        const text = await (0, index_js_21.handleActivation)(packet);
        res.status(200).json({ text });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
    }
});
/** Gemini Live removed — Aethon hull uses Deepgram Flux + Claude + Gemini TTS. */
app.post("/api/jarvis/gemini-live/token", express_1.default.json({ limit: "64kb" }), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    res.status(410).json({
        error: "Gemini Live removed",
        hint: "Use Aethon voice pipeline: Deepgram Flux STT + Claude + Gemini TTS via /jarvis",
    });
});
/** Execute Harvey / hull tools (legacy voice tool relay). */
app.post("/api/jarvis/execute-tool", express_1.default.json({ limit: "64kb" }), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const toolName = String(body.toolName ?? "").trim();
    const toolInput = body.toolInput && typeof body.toolInput === "object" && !Array.isArray(body.toolInput)
        ? body.toolInput
        : {};
    if (!toolName) {
        res.status(400).json({ error: "toolName required" });
        return;
    }
    console.log("[Harvey Voice Tool] Executing:", toolName, "input:", JSON.stringify(toolInput));
    try {
        const result = await (0, index_js_20.runHarveyTool)(toolName, toolInput);
        console.log("[Harvey Voice Tool] Result for", toolName, ":", JSON.stringify(result).substring(0, 200));
        res.status(200).json({ success: true, result });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[Harvey Voice Tool] Error:", message);
        res.status(500).json({ error: message });
    }
});
/** War Room — static campaign metrics for Harvey UI strip. */
app.get("/api/jarvis/metrics", (req, res) => {
    const authorized = dashboardTokenOk(req);
    console.log("[Metrics] Request received");
    console.log("[Metrics] Auth header:", !!req.headers.authorization);
    console.log("[Metrics] Token query:", !!req.query.token);
    console.log("[Metrics] Authorized:", authorized);
    if (!authorized) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    res.json({
        goal: {
            target: 20000000,
            banked: 5956520,
            gap: 14043480,
            percentComplete: 29.8,
            deadline: "Nov 30, 2026",
            avgDealPrice: 425466,
            dealsCount: 14,
        },
        dailyTargets: { videos: 7, calls: 725 },
        tiktok: {
            days: 174,
            videos: 124,
            views: 738682,
            comments: 4076,
            shares: 8322,
            closings: 3,
            avgViewsPerVideo: 5957,
            avgWatchSeconds: 28.7,
            platformAvgWatch: 17.5,
            viewsPerClosing: 246227,
            dmsPerClosing: 272,
            phonesPerClosing: 136,
            consultsPerClosing: 7,
            videosPerWeekCurrent: 5,
            weeksPerClosingCurrent: 8,
            videosPerWeekForMonthly: 10.3,
        },
        mojo: {
            calls: 26938,
            contacts: 846,
            consults: 37,
            apptsHeld: 25,
            agreements: 8,
            closings: 4,
            callsPerClosing: 6734,
            contactsPerClosing: 212,
            callsPerContact: 32,
            efficiencyVsTiktok: "36x more efficient per touch",
        },
        insights: [
            { priority: "critical", text: "Need 725 calls/day + 7 videos/day to hit $20M by Nov 30" },
            { priority: "high", text: "At current pace (5 videos/week): 1 closing every 8 weeks" },
            { priority: "high", text: "Need 10.3 videos/week for 1 closing/month from TikTok" },
            { priority: "medium", text: "Cold calling is 36x more efficient per touch than TikTok" },
            { priority: "medium", text: "Watch time 28.7s is above platform average — hooks are working" },
            { priority: "medium", text: "DM to phone capture rate is the biggest TikTok leverage point" },
        ],
    });
});
/** Harvey daily game plan — static targets + motivation. */
app.get("/api/jarvis/daily-plan", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    const now = new Date();
    const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long" });
    const dateStr = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const daysRemaining = Math.ceil((new Date("2026-11-30").getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    res.json({
        date: dateStr,
        dayOfWeek,
        targets: {
            videos: 7,
            calls: 725,
            description: "Non-negotiable daily minimums for $20M by Nov 30",
        },
        goalStatus: {
            banked: 5956520,
            gap: 14043480,
            percentComplete: 29.8,
            deadline: "Nov 30, 2026",
            daysRemaining,
        },
        needleMovers: [
            "7 videos posted today = TikTok engine stays alive",
            "725 calls = 22 contacts at current rate = 0.1 closings in pipeline",
            "Every video above 7 compounds — 10.3/week hits monthly closing pace",
            "Every 6,734 calls = 1 seller closing = $425K avg deal",
        ],
        motivation: `${dayOfWeek}. $14M gap. ${daysRemaining} days left. The only thing that moves the needle today is reps — videos and calls. Everything else is noise.`,
    });
});
/** Harvey market intel — Claude + web search. */
app.post("/api/jarvis/market-intel", express_1.default.json({ limit: "64kb" }), async (req, res) => {
    console.log("[MarketIntel] Route hit — method:", req.method, "auth:", dashboardTokenOk(req));
    if (!dashboardTokenOk(req)) {
        console.log("[MarketIntel] Auth failed");
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
        res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
        return;
    }
    try {
        console.log("[MarketIntel] Fetching market data...");
        const anthropic = new sdk_1.default({ apiKey });
        const lastUpdated = new Date().toISOString();
        const response = await anthropic.messages.create({
            model: (0, index_js_20.getHarveyModel)(),
            max_tokens: 1500,
            tools: [{
                    type: "web_search_20250305",
                    name: "web_search",
                }],
            messages: [{
                    role: "user",
                    content: `Search for and return current real estate market data as of today. Find:
1. Current 30-year fixed mortgage rate (exact percentage)
2. Current Fed funds rate and any recent Fed decisions
3. Current US inflation rate (CPI)
4. National housing market: inventory levels, median home price, pending sales trends
5. San Antonio Texas housing market specifically if available
6. Any major economic news affecting real estate this week

Return the data in this exact JSON format with no markdown:
{
  "mortgageRate": "X.XX%",
  "mortgageRateChange": "+/- X.XX% from last week",
  "fedRate": "X.XX%",
  "fedNote": "brief note on recent Fed action",
  "inflation": "X.X%",
  "inflationNote": "brief context",
  "nationalInventory": "description",
  "medianHomePrice": "$XXX,XXX",
  "marketTrend": "buyer/seller/neutral market description",
  "sanAntonioNote": "SA specific note or national if SA not found",
  "weeklyInsight": "2-3 sentence insight connecting these numbers to real estate opportunity",
  "lastUpdated": "${lastUpdated}"
}`,
                }],
        });
        const fullText = response.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
        let marketData;
        try {
            const jsonMatch = fullText.match(/\{[\s\S]*\}/);
            marketData = jsonMatch
                ? JSON.parse(jsonMatch[0])
                : { error: "Could not parse market data", raw: fullText.substring(0, 500) };
        }
        catch {
            marketData = { error: "Parse failed", raw: fullText.substring(0, 500) };
        }
        console.log("[MarketIntel] Data fetched successfully");
        res.json({ success: true, data: marketData, fetchedAt: new Date().toISOString() });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[MarketIntel] Error:", msg);
        res.status(500).json({ error: msg });
    }
});
/** Harvey world intel — Claude + web search (business-relevant events). */
app.post("/api/jarvis/world-intel", express_1.default.json({ limit: "64kb" }), async (req, res) => {
    console.log("[WorldIntel] Route hit — method:", req.method, "auth:", dashboardTokenOk(req));
    if (!dashboardTokenOk(req)) {
        console.log("[WorldIntel] Auth failed");
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
        res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
        return;
    }
    try {
        console.log("[WorldIntel] Fetching world events via web search...");
        const anthropic = new sdk_1.default({ apiKey });
        const lastUpdated = new Date().toISOString();
        const response = await anthropic.messages.create({
            model: (0, index_js_20.getHarveyModel)(),
            max_tokens: 2000,
            tools: [{
                    type: "web_search_20250305",
                    name: "web_search",
                }],
            messages: [{
                    role: "user",
                    content: `Search for major world and political events from the last 7 days that could impact business, the economy, or real estate.

EXCLUDE: entertainment, celebrity, sports, lifestyle news.
INCLUDE: policy changes, legislation affecting housing or mortgages, Federal Reserve actions, inflation data, geopolitical events affecting markets, housing policy, interest rate news, major economic decisions, election results affecting economic policy.

Return ONLY this JSON with no markdown:
{
  "events": [
    {
      "headline": "short headline",
      "category": "policy|legislation|economic|geopolitical|housing|fed",
      "summary": "2-3 sentence summary of what happened",
      "impact": "high|medium|low",
      "realEstateRelevance": "how this specifically affects real estate or Marco's business, or null if not relevant"
    }
  ],
  "economicSummary": "2-3 sentence overall economic picture this week",
  "realEstateImpact": "2-3 sentence summary of how current events specifically affect real estate agents and buyers in Texas",
  "lastUpdated": "${lastUpdated}"
}

Include 4-6 events maximum. Only include events with real business relevance.`,
                }],
        });
        const fullText = response.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
        console.log("[WorldIntel] Raw response length:", fullText.length);
        let worldData;
        try {
            const jsonMatch = fullText.match(/\{[\s\S]*\}/);
            worldData = jsonMatch
                ? JSON.parse(jsonMatch[0])
                : {
                    events: [],
                    economicSummary: "Data unavailable",
                    realEstateImpact: "Data unavailable",
                    error: "Could not parse response",
                };
        }
        catch (parseErr) {
            const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            console.error("[WorldIntel] JSON parse failed:", msg);
            worldData = {
                events: [],
                economicSummary: "Parse error",
                realEstateImpact: "Parse error",
                raw: fullText.substring(0, 200),
            };
        }
        const events = worldData.events;
        console.log("[WorldIntel] Success — events count:", Array.isArray(events) ? events.length : 0);
        res.json({ success: true, data: worldData, fetchedAt: new Date().toISOString() });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[WorldIntel] Error:", msg);
        res.status(500).json({ error: msg });
    }
});
const MOJO_TIKTOK_RESEARCH_QUERY = `Research these two topics for a real estate agent automation system:

1. MOJO DIALER API:
- Does Mojo Dialer have a public API or webhook system?
- Can call stats (calls made, contacts reached, talk time) be exported automatically?
- Is there a Zapier integration or any automation options?
- What would be needed to pull daily call stats into a custom dashboard?

2. TIKTOK ANALYTICS API:
- Does TikTok have a business/creator API that exposes video analytics?
- Can views, watch time, comments, shares be pulled automatically per video?
- What are the API access requirements (business account, approval process)?
- Is there a way to get daily performance data automatically?

Return findings as JSON:
{
  "mojo": {
    "hasApi": true,
    "apiDetails": "description of what's available",
    "exportOptions": ["list of export mechanisms"],
    "automationOptions": ["zapier", "webhook", etc],
    "integrationComplexity": "simple|moderate|complex",
    "recommendation": "what to build",
    "limitations": "what's not possible"
  },
  "tiktok": {
    "hasApi": true,
    "apiDetails": "description",
    "analyticsAccess": "what data is accessible",
    "accessRequirements": "what's needed to get access",
    "integrationComplexity": "simple|moderate|complex",
    "recommendation": "what to build",
    "limitations": "what's not possible"
  },
  "summary": "2-3 sentence executive summary of what's buildable",
  "nextSteps": ["ordered list of recommended next steps"]
}`;
async function runClaudeResearchJson(prompt) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey)
        throw new Error("ANTHROPIC_API_KEY not configured");
    const anthropic = new sdk_1.default({ apiKey });
    const response = await anthropic.messages.create({
        model: (0, index_js_20.getHarveyModel)(),
        max_tokens: 2500,
        tools: [{
                type: "web_search_20250305",
                name: "web_search",
            }],
        messages: [{ role: "user", content: prompt }],
    });
    const fullText = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    const jsonMatch = fullText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        return { error: "Could not parse research response", raw: fullText.substring(0, 500) };
    }
    return JSON.parse(jsonMatch[0]);
}
/** Harvey research report — Claude + web search on arbitrary topic. */
app.post("/api/jarvis/research-report", express_1.default.json({ limit: "64kb" }), async (req, res) => {
    console.log("[Research] Route hit — method:", req.method, "auth:", dashboardTokenOk(req));
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    if (!topic) {
        res.status(400).json({ error: "Missing topic" });
        return;
    }
    try {
        console.log("[Research] Fetching report for:", topic.substring(0, 80));
        const prompt = `Research the following topic thoroughly for a real estate agent building automation tools. Use current web sources.

TOPIC: ${topic}

Return findings as JSON with no markdown:
{
  "topic": "${topic.replace(/"/g, "'")}",
  "summary": "2-4 sentence executive summary",
  "findings": ["bullet finding 1", "bullet finding 2"],
  "recommendation": "what to build or do next",
  "limitations": "what is not possible or risky",
  "sources": ["brief source description"]
}`;
        const data = await runClaudeResearchJson(prompt);
        console.log("[Research] Success — topic:", topic.substring(0, 40));
        res.json({ success: true, data, fetchedAt: new Date().toISOString() });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Research] Error:", msg);
        res.status(500).json({ error: msg });
    }
});
/** One-time Mojo + TikTok API integration research. */
app.get("/api/jarvis/mojo-tiktok-research", async (req, res) => {
    console.log("[Research] Mojo+TikTok route hit — auth:", dashboardTokenOk(req));
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    try {
        console.log("[Research] Fetching Mojo + TikTok API research...");
        const data = await runClaudeResearchJson(MOJO_TIKTOK_RESEARCH_QUERY);
        console.log("[Research] Mojo+TikTok success");
        res.json({ success: true, data, fetchedAt: new Date().toISOString() });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Research] Mojo+TikTok error:", msg);
        res.status(500).json({ error: msg });
    }
});
/** Marco operational tasks — separate from lead follow-up tasks. */
app.get("/api/marco-tasks", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    (0, marcoTasks_js_1.seedMarcoTasksIfEmpty)();
    const tasks = (0, marcoTasks_js_1.sortMarcoTasks)((0, marcoTasks_js_1.getMarcoTasks)());
    res.status(200).json({ tasks, summary: (0, marcoTasks_js_1.buildMarcoTasksSummary)(tasks) });
});
app.post("/api/marco-tasks", express_1.default.json({ limit: "64kb" }), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
        res.status(400).json({ error: "Missing title" });
        return;
    }
    const priority = body.priority === "high" || body.priority === "medium" || body.priority === "low"
        ? body.priority
        : "medium";
    const status = types_js_2.MARCO_TASK_STATUSES.includes(body.status)
        ? body.status
        : "pending";
    const task = (0, marcoTasks_js_1.createMarcoTask)({
        title,
        description: typeof body.description === "string" ? body.description : undefined,
        dueDate: typeof body.dueDate === "string" ? body.dueDate.slice(0, 10) : undefined,
        priority,
        status,
        createdBy: typeof body.createdBy === "string" ? body.createdBy : "carlos",
    });
    res.status(201).json({ task });
});
app.patch("/api/marco-tasks/:id", express_1.default.json({ limit: "64kb" }), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const updates = {};
    if (typeof body.title === "string")
        updates.title = body.title.trim();
    if (typeof body.description === "string")
        updates.description = body.description;
    if (typeof body.dueDate === "string")
        updates.dueDate = body.dueDate.slice(0, 10);
    if (body.priority === "high" || body.priority === "medium" || body.priority === "low") {
        updates.priority = body.priority;
    }
    if (types_js_2.MARCO_TASK_STATUSES.includes(body.status)) {
        updates.status = body.status;
        updates.previousStatus = undefined;
    }
    if (typeof body.createdBy === "string")
        updates.createdBy = body.createdBy;
    const task = (0, marcoTasks_js_1.updateMarcoTask)(id, updates);
    if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
    }
    res.status(200).json({ task });
});
app.delete("/api/marco-tasks/:id", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const ok = (0, marcoTasks_js_1.deleteMarcoTask)(id);
    res.status(ok ? 200 : 404).json({ success: ok });
});
app.post("/api/marco-tasks/:id/complete", express_1.default.json({ limit: "16kb" }), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const task = (0, marcoTasks_js_1.updateMarcoTask)(id, { status: "done", completedAt: new Date().toISOString(), previousStatus: undefined });
    if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
    }
    res.status(200).json({ task });
});
/** Harvey notes — standalone and lead-linked. */
app.get("/api/notes", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const leadId = typeof req.query.leadId === "string" ? req.query.leadId : undefined;
    const notes = (0, harveyNotes_js_1.filterNotes)({ category, leadId });
    res.status(200).json(notes);
});
app.get("/api/notes/search", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const q = typeof req.query.q === "string" ? req.query.q : "";
    res.status(200).json((0, harveyNotes_js_1.searchNotes)(q));
});
app.post("/api/notes", express_1.default.json({ limit: "256kb" }), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) {
        res.status(400).json({ error: "Missing content" });
        return;
    }
    const category = body.category === "general" ||
        body.category === "lead" ||
        body.category === "listing" ||
        body.category === "idea" ||
        body.category === "follow_up" ||
        body.category === "meeting"
        ? body.category
        : "general";
    const source = body.source === "voice" || body.source === "text" || body.source === "auto"
        ? body.source
        : "text";
    const note = (0, harveyNotes_js_1.createNote)({
        content,
        title: typeof body.title === "string" ? body.title : undefined,
        category,
        leadId: typeof body.leadId === "string" ? body.leadId : undefined,
        leadName: typeof body.leadName === "string" ? body.leadName : undefined,
        tags: Array.isArray(body.tags)
            ? body.tags.filter((t) => typeof t === "string")
            : undefined,
        source,
    });
    res.status(201).json(note);
});
app.patch("/api/notes/:id", express_1.default.json({ limit: "256kb" }), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const updates = {};
    if (typeof body.content === "string")
        updates.content = body.content.trim();
    if (typeof body.title === "string")
        updates.title = body.title;
    if (body.category === "general" ||
        body.category === "lead" ||
        body.category === "listing" ||
        body.category === "idea" ||
        body.category === "follow_up" ||
        body.category === "meeting") {
        updates.category = body.category;
    }
    if (typeof body.leadId === "string")
        updates.leadId = body.leadId;
    if (typeof body.leadName === "string")
        updates.leadName = body.leadName;
    const note = (0, harveyNotes_js_1.updateNote)(id, updates);
    if (!note) {
        res.status(404).json({ error: "Note not found" });
        return;
    }
    res.status(200).json(note);
});
app.delete("/api/notes/:id", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const ok = (0, harveyNotes_js_1.deleteNote)(id);
    res.status(ok ? 200 : 404).json({ success: ok });
});
function hullMemoryStats(db) {
    const facts = db.prepare("SELECT COUNT(*) as c FROM facts WHERE superseded_by IS NULL").get().c;
    const nodes = db.prepare("SELECT COUNT(*) as c FROM nodes").get().c;
    const edges = db.prepare("SELECT COUNT(*) as c FROM edges").get().c;
    const rules = db.prepare("SELECT COUNT(*) as c FROM rules").get().c;
    const episodes = db.prepare("SELECT COUNT(*) as c FROM episodes").get().c;
    const syntheses = db.prepare("SELECT COUNT(*) as c FROM syntheses").get().c;
    return { facts, nodes, edges, rules, episodes, syntheses };
}
/** Hull memory — full snapshot (legacy /api/jarvis/memory). */
app.get("/api/jarvis/memory", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const db = (0, index_js_21.getHullDb)();
    res.json({
        facts: db.prepare("SELECT * FROM facts WHERE superseded_by IS NULL ORDER BY strength DESC LIMIT 50").all(),
        nodes: db.prepare("SELECT * FROM nodes ORDER BY created_at DESC LIMIT 50").all(),
        edges: db.prepare("SELECT * FROM edges ORDER BY created_at DESC LIMIT 50").all(),
        rules: db.prepare("SELECT * FROM rules ORDER BY confidence DESC LIMIT 50").all(),
        episodes: db.prepare("SELECT * FROM episodes ORDER BY timestamp DESC LIMIT 20").all(),
        stats: hullMemoryStats(db),
    });
});
/** Neural Map API — full combined payload. */
app.get("/api/memory/all", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const db = (0, index_js_21.getHullDb)();
    const facts = db.prepare("SELECT * FROM facts WHERE superseded_by IS NULL ORDER BY strength DESC").all();
    const nodes = db.prepare("SELECT * FROM nodes").all();
    const edges = db
        .prepare(`SELECT e.id, e.source_id, e.target_id, e.relationship, e.strength, e.created_at,
              s.name as source_name, t.name as target_name
       FROM edges e JOIN nodes s ON e.source_id = s.id JOIN nodes t ON e.target_id = t.id`)
        .all();
    const rules = db.prepare("SELECT * FROM rules ORDER BY confidence DESC").all();
    const episodes = db.prepare("SELECT * FROM episodes ORDER BY timestamp DESC LIMIT 20").all();
    const identityProfile = db.prepare("SELECT dimension, confidence FROM identity_dimensions ORDER BY dimension").all();
    res.json({
        facts,
        nodes,
        edges,
        rules,
        episodes,
        stats: hullMemoryStats(db),
        identityProfile,
        lastSync: new Date().toISOString(),
    });
});
app.get("/api/memory/graph", (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const db = (0, index_js_21.getHullDb)();
    res.json({
        nodes: db.prepare("SELECT * FROM nodes").all(),
        edges: db.prepare("SELECT * FROM edges").all(),
    });
});
app.get("/api/memory/episodes", (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const db = (0, index_js_21.getHullDb)();
    res.json(db.prepare("SELECT * FROM episodes ORDER BY timestamp DESC LIMIT 20").all());
});
app.get("/api/memory/rules", (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const db = (0, index_js_21.getHullDb)();
    res.json(db.prepare("SELECT * FROM rules ORDER BY confidence DESC").all());
});
app.get("/api/memory/identity", (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const db = (0, index_js_21.getHullDb)();
    const profile = db.prepare("SELECT dimension, confidence FROM identity_dimensions ORDER BY dimension").all();
    const recentQuestions = db
        .prepare("SELECT dimension, question, asked_at, answered FROM identity_questions ORDER BY asked_at DESC LIMIT 10")
        .all();
    res.json({ profile, recentQuestions });
});
/** Email marketing API */
app.get("/api/email/recent", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { getRecentEmails } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
    res.json({ emails: getRecentEmails(parseInt(String(req.query.limit || "50"), 10) || 50) });
});
app.get("/api/email/lead/:leadId", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { getEmailsForLead } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
    res.json({ emails: getEmailsForLead(req.params.leadId) });
});
app.get("/api/email/stats", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { getEmailStats, countActiveDripSequences } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
    const since = req.query.since ||
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    res.json({ ...getEmailStats(since), activeSequences: countActiveDripSequences() });
});
app.get("/api/email/sequences", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { getActiveDripSequences } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
    const { listAllLeads } = await Promise.resolve().then(() => __importStar(require("./core/db.js")));
    const sequences = getActiveDripSequences(100);
    const leads = await listAllLeads();
    const byId = new Map(leads.map((l) => [l.id, l]));
    res.json({
        sequences: sequences.map((s) => ({
            ...s,
            leadName: byId.get(s.leadId)?.name || byId.get(s.leadId)?.username || s.leadId,
        })),
    });
});
/** Mass email templates + send */
app.get("/api/email/templates", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    try {
        const { getEmailTemplates } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
        const type = typeof req.query.type === "string" ? req.query.type : undefined;
        res.json({ templates: getEmailTemplates(type) });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[api/email/templates] GET failed:", message);
        res.status(500).json({ error: message || "Failed to load templates" });
    }
});
app.post("/api/email/templates", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { saveEmailTemplate } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    const templateType = typeof req.body?.templateType === "string" ? req.body.templateType.trim() : "mass_email";
    if (!name || !subject || !body) {
        return res.status(400).json({ error: "name, subject, and body required" });
    }
    const template = saveEmailTemplate({
        name,
        subject,
        body,
        templateType: templateType,
        isActive: true,
    });
    res.json({ template });
});
app.patch("/api/email/templates/:id", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { updateEmailTemplate } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
    const updates = {};
    if (typeof req.body?.name === "string")
        updates.name = req.body.name.trim();
    if (typeof req.body?.subject === "string")
        updates.subject = req.body.subject.trim();
    if (typeof req.body?.body === "string")
        updates.body = req.body.body.trim();
    if (typeof req.body?.isActive === "boolean")
        updates.isActive = req.body.isActive;
    updateEmailTemplate(String(req.params.id || ""), updates);
    res.json({ success: true });
});
app.delete("/api/email/templates/:id", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { deleteEmailTemplate } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
    deleteEmailTemplate(String(req.params.id || ""));
    res.json({ success: true });
});
app.post("/api/email/mass-send", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { isEmailConfigured, sendEmail } = await Promise.resolve().then(() => __importStar(require("./integrations/email/index.js")));
    if (!isEmailConfigured()) {
        return res.status(503).json({
            error: "Email not configured — set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN",
        });
    }
    const { logEmail, markEmailSent, markEmailFailed, getEmailTemplate } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
    const { findLeadById } = await Promise.resolve().then(() => __importStar(require("./core/db.js")));
    const leadIds = req.body?.leadIds;
    const templateId = typeof req.body?.templateId === "string" ? req.body.templateId.trim() : "";
    if (!Array.isArray(leadIds) || leadIds.length === 0) {
        return res.status(400).json({ error: "leadIds array required" });
    }
    if (!templateId) {
        return res.status(400).json({ error: "templateId required" });
    }
    const template = getEmailTemplate(templateId);
    if (!template) {
        return res.status(404).json({ error: "Template not found" });
    }
    const leads = await Promise.all(leadIds.map((id) => findLeadById(String(id))));
    const leadsWithEmail = leads.filter((l) => !!l && !!l.email && String(l.email).trim().length > 0);
    const leadsWithoutEmail = leadIds.length - leadsWithEmail.length;
    console.log("[MassEmail] Sending to", leadsWithEmail.length, "leads (", leadsWithoutEmail, "skipped — no email)");
    res.json({
        queued: leadsWithEmail.length,
        skipped: leadsWithoutEmail,
        templateName: template.name,
        message: `Sending to ${leadsWithEmail.length} lead${leadsWithEmail.length !== 1 ? "s" : ""} — check Email Marketing for results.`,
    });
    const DELAY_MS = 750;
    for (let i = 0; i < leadsWithEmail.length; i++) {
        const lead = leadsWithEmail[i];
        const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
        const displayName = lead.name?.trim() || firstName;
        const personalizedSubject = template.subject
            .replace(/\{firstName\}/g, firstName)
            .replace(/\{name\}/g, displayName);
        const personalizedBody = template.body
            .replace(/\{firstName\}/g, firstName)
            .replace(/\{name\}/g, displayName);
        const emailRecord = logEmail({
            leadId: lead.id,
            subject: personalizedSubject,
            body: personalizedBody,
            emailType: "mass_email",
            sendStatus: "pending",
        });
        setTimeout(async () => {
            const result = await sendEmail(lead.email, personalizedSubject, personalizedBody);
            if (result.success) {
                markEmailSent(emailRecord.id, result.messageId);
                console.log("[MassEmail] Sent to", lead.email, `(${i + 1}/${leadsWithEmail.length})`);
            }
            else {
                markEmailFailed(emailRecord.id, result.error || "unknown error");
                console.error("[MassEmail] Failed for", lead.email, "-", result.error);
            }
        }, i * DELAY_MS);
    }
});
app.post("/api/email/send-existing-client", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { sendContextAwareEmail } = await Promise.resolve().then(() => __importStar(require("./agents/emailMarketing/existingClientFlow.js")));
    const leadId = String(req.body?.leadId || "");
    const subject = String(req.body?.subject || "");
    const body = String(req.body?.body || "");
    const result = await sendContextAwareEmail(leadId, subject, () => body);
    res.json(result);
});
app.get("/api/email/client-context/:leadId", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { buildClientContext } = await Promise.resolve().then(() => __importStar(require("./agents/emailMarketing/existingClientFlow.js")));
    res.json(await buildClientContext(req.params.leadId));
});
app.post("/api/email/start-drip", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { leadId, sequenceType } = req.body || {};
    if (sequenceType === "buyer_drip") {
        void Promise.resolve().then(() => __importStar(require("./agents/emailMarketing/buyerDrip.js"))).then((m) => m.startBuyerDrip(String(leadId)));
    }
    else if (sequenceType === "seller_drip") {
        void Promise.resolve().then(() => __importStar(require("./agents/emailMarketing/sellerDrip.js"))).then((m) => m.startSellerDrip(String(leadId)));
    }
    else {
        res.status(400).json({ error: "Invalid sequenceType" });
        return;
    }
    res.json({ success: true });
});
app.post("/api/email/sequence/:id/pause", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { pauseSequence } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
    pauseSequence(req.params.id);
    res.json({ ok: true });
});
app.get("/api/email/connection-status", async (_req, res) => {
    const { isEmailConfigured, verifyEmailConnection } = await Promise.resolve().then(() => __importStar(require("./integrations/email/index.js")));
    const configured = isEmailConfigured();
    const verified = configured ? await verifyEmailConnection() : false;
    res.json({ configured, verified });
});
app.post("/api/email/process-buyer-drips-now", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { processDueBuyerDrips } = await Promise.resolve().then(() => __importStar(require("./agents/emailMarketing/buyerDrip.js")));
    res.json(await processDueBuyerDrips());
});
app.post("/api/email/process-seller-drips-now", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { processDueSellerDrips } = await Promise.resolve().then(() => __importStar(require("./agents/emailMarketing/sellerDrip.js")));
    res.json(await processDueSellerDrips());
});
app.post("/api/email/quarterly-touch-now", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { runPastClientQuarterlyTouch } = await Promise.resolve().then(() => __importStar(require("./agents/emailMarketing/pastClientQuarterly.js")));
    res.json(await runPastClientQuarterlyTouch());
});
app.post("/api/email/no-reply-check-now", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { checkNoReplyFollowups } = await Promise.resolve().then(() => __importStar(require("./agents/emailMarketing/noReplyFollowup.js")));
    res.json(await checkNoReplyFollowups());
});
app.get("/api/email/detail/:id", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { getEmailById } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
    const email = getEmailById(req.params.id);
    if (!email)
        return res.status(404).json({ error: "Email not found" });
    const { listAllLeads } = await Promise.resolve().then(() => __importStar(require("./core/db.js")));
    const leads = await listAllLeads();
    const lead = leads.find((l) => l.id === email.leadId);
    res.json({
        email,
        leadName: lead?.name || lead?.username || email.leadId,
        leadEmail: lead?.email,
    });
});
app.get("/api/email/replies", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { getRepliedEmails, getInboundCachedReplies } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
    const { listAllLeads } = await Promise.resolve().then(() => __importStar(require("./core/db.js")));
    const leads = await listAllLeads();
    const byId = new Map(leads.map((l) => [l.id, l]));
    const limit = parseInt(String(req.query.limit || "50"), 10) || 50;
    const replied = getRepliedEmails(limit).map((e) => ({
        ...e,
        leadName: byId.get(e.leadId)?.name || byId.get(e.leadId)?.username || e.leadId,
    }));
    const inbound = getInboundCachedReplies(limit).map((m) => ({
        ...m,
        leadName: m.leadId ? byId.get(m.leadId)?.name || m.leadId : undefined,
    }));
    res.json({ replied, inbound });
});
app.get("/api/email/active-drips-detail", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { getActiveDripSequences, getEmailsForDripType } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
    const { listAllLeads } = await Promise.resolve().then(() => __importStar(require("./core/db.js")));
    const sequences = getActiveDripSequences(100);
    const leads = await listAllLeads();
    const byId = new Map(leads.map((l) => [l.id, l]));
    const dripTypeMap = {
        buyer_drip: "buyer_drip",
        seller_drip: "seller_drip",
    };
    res.json({
        sequences: sequences.map((s) => {
            const emailType = dripTypeMap[s.sequenceType];
            const emails = emailType ? getEmailsForDripType(s.leadId, emailType) : [];
            return {
                ...s,
                leadName: byId.get(s.leadId)?.name || byId.get(s.leadId)?.username || s.leadId,
                leadEmail: byId.get(s.leadId)?.email,
                emailsSent: emails,
            };
        }),
    });
});
app.get("/api/email/inbox", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const { getCachedGmailMessages } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
    const limit = parseInt(String(req.query.limit || "30"), 10) || 30;
    res.json({ messages: getCachedGmailMessages(limit) });
});
app.post("/api/email/sync-gmail", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    try {
        const { syncGmailInbox } = await Promise.resolve().then(() => __importStar(require("./agents/emailMarketing/gmailSync.js")));
        const result = await syncGmailInbox();
        res.json({ success: true, ...result });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ success: false, error: message });
    }
});
app.get("/api/email/gmail/:messageId", async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    try {
        const { getGmailMessage } = await Promise.resolve().then(() => __importStar(require("./integrations/gmail/inbox.js")));
        const { getCachedGmailMessage, cacheGmailMessage } = await Promise.resolve().then(() => __importStar(require("./core/emailStore.js")));
        const msg = await getGmailMessage(req.params.messageId);
        const now = new Date().toISOString();
        cacheGmailMessage({
            id: msg.id,
            threadId: msg.threadId,
            direction: msg.direction,
            fromAddr: msg.from,
            toAddr: msg.to,
            subject: msg.subject,
            snippet: msg.snippet,
            body: msg.bodyText,
            receivedAt: msg.date,
            syncedAt: now,
        });
        const cached = getCachedGmailMessage(msg.id);
        res.json({ message: msg, cached });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.post("/api/memory/extract-voice", express_1.default.json({ limit: "512kb" }), async (req, res) => {
    if (!dashboardTokenOk(req))
        return res.status(401).json({ error: "Unauthorized" });
    const transcript = Array.isArray(req.body?.transcript) ? req.body.transcript : [];
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "voice";
    await (0, index_js_21.runPostConversationExtraction)(sessionId, transcript.map((t) => ({
        role: String(t.role || "user"),
        text: String(t.text || ""),
    })));
    (0, index_js_21.broadcastHullEvent)({ type: "memory_updated" });
    res.json({ ok: true });
});
/** Harvey memory search — hybrid retrieval. */
app.get("/api/jarvis/memory/search", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const { searchFacts } = await Promise.resolve().then(() => __importStar(require("./hull/memory/retrieval.js")));
    const results = await searchFacts(q, 10);
    res.json(results);
});
/** Harvey memory — add fact. */
app.post("/api/jarvis/memory/add", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const content = typeof req.body?.fact === "string" ? req.body.fact.trim() : "";
    const category = typeof req.body?.category === "string" ? req.body.category.trim() : "business";
    const keywords = typeof req.body?.tags === "string" ? req.body.tags.trim() : "";
    const strength = typeof req.body?.weight === "number" ? req.body.weight : 1.0;
    if (!content) {
        res.status(400).json({ error: "Missing fact" });
        return;
    }
    const db = (0, index_js_21.getHullDb)();
    const id = (0, crypto_1.randomUUID)();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO facts (id, content, category, keywords, strength, access_count, last_accessed, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(id, content, category, keywords, strength, now, now);
    (0, index_js_21.broadcastHullEvent)({ type: "memory_updated" });
    res.status(201).json({ id, content, category, keywords, strength });
});
/** Delete memory row by id across hull tables. */
app.delete("/api/jarvis/memory/:id", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const id = String(req.params.id || "").trim();
    if (!id) {
        res.status(400).json({ error: "Missing id" });
        return;
    }
    const db = (0, index_js_21.getHullDb)();
    const tables = ["facts", "nodes", "edges", "rules", "episodes", "syntheses", "identity_questions"];
    let deleted = false;
    for (const table of tables) {
        const result = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
        if (result.changes > 0)
            deleted = true;
    }
    if (!deleted) {
        res.status(404).json({ error: "Memory not found" });
        return;
    }
    (0, index_js_21.broadcastHullEvent)({ type: "memory_updated" });
    res.status(200).json({ ok: true, id });
});
/** Gemini TTS — Aethon mouth (director's notes + Charon). */
let ttsInFlight = 0;
const TTS_MAX_CONCURRENT = 2;
app.post("/api/jarvis/voice", express_1.default.json({ limit: "256kb" }), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
        res.status(400).json({ error: "Missing text" });
        return;
    }
    if (ttsInFlight >= TTS_MAX_CONCURRENT) {
        console.warn("[TTS] Concurrent limit reached — rejecting request");
        res.status(429).json({ error: "TTS busy — try again" });
        return;
    }
    ttsInFlight++;
    try {
        const audio = await (0, index_js_21.generateTTS)(text);
        if (!audio) {
            res.status(502).json({ error: "TTS failed" });
            return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("X-Sample-Rate", String(audio.sampleRate));
        res.setHeader("Cache-Control", "no-store");
        res.status(200).send(audio.pcm);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: message });
    }
    finally {
        ttsInFlight--;
    }
});
/** Legacy alias — gemini-tts → hull TTS. */
app.post("/api/jarvis/gemini-tts", express_1.default.json({ limit: "256kb" }), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
        res.status(400).json({ error: "Missing text" });
        return;
    }
    try {
        const audio = await (0, index_js_21.generateTTS)(text);
        if (!audio) {
            res.status(502).json({ error: "TTS failed" });
            return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("X-Sample-Rate", String(audio.sampleRate));
        res.setHeader("Cache-Control", "no-store");
        res.status(200).send(audio.pcm);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: message });
    }
});
const simulateCors = (0, cors_1.default)({
    origin: true,
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
});
const resetCors = (0, cors_1.default)({
    origin: true,
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
});
async function handleSimulateBody(body, res) {
    try {
        const result = await (0, webhook_js_1.handleWebhook)(body);
        if (result.status === 400) {
            res.status(400).json({ error: "Invalid payload (need user_id, message, etc.)" });
            return;
        }
        res.status(200).json({ reply: result.reply ?? null });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
}
app.options("/simulate", simulateCors);
app.post("/simulate", express_1.default.json(), simulateCors, (req, res) => {
    void handleSimulateBody(req.body, res);
});
/** ManyChat External Request — same body/response as /simulate */
app.options("/webhook", simulateCors);
app.post("/webhook", express_1.default.json(), simulateCors, (req, res) => {
    void handleSimulateBody(req.body, res);
});
app.options("/reset", resetCors);
app.post("/reset", resetCors, (_req, res) => {
    (0, db_js_1.resetMemoryStore)();
    res.status(200).json({ ok: true, message: "In-memory store cleared." });
});
app.post("/sinch/inbound", express_1.default.json(), async (req, res) => {
    try {
        const payload = (0, index_js_17.receiveInbound)(req.body);
        if (!payload) {
            res.status(400).json({ error: "Invalid or unparseable Sinch inbound payload" });
            return;
        }
        const result = await (0, webhook_js_1.handleIncomingPayload)(payload);
        res.status(result.status).json({
            ok: result.status === 200,
            reply: result.reply ?? null,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[Sinch] /sinch/inbound error:", err);
        res.status(500).json({ error: message });
    }
});
/** Twilio inbound SMS — configure in Twilio Console → phone number → Messaging webhook. */
app.post("/webhook/twilio", express_1.default.urlencoded({ extended: false }), async (req, res) => {
    const inboundReceivedAt = Date.now();
    try {
        const signature = req.get("x-twilio-signature") ?? "";
        const protocol = req.get("x-forwarded-proto") || req.protocol;
        const url = `${protocol}://${req.get("host")}${req.originalUrl}`;
        if (signature && !(0, index_js_18.validateTwilioSignature)(signature, url, req.body)) {
            console.warn("[Twilio Webhook] Invalid signature — rejecting");
            res.status(403).send("Invalid signature");
            return;
        }
        const messageSid = typeof req.body?.MessageSid === "string" ? req.body.MessageSid.trim() : "";
        const from = typeof req.body?.From === "string" ? req.body.From.trim() : "";
        const message = typeof req.body?.Body === "string" ? req.body.Body.trim() : "";
        console.log("[Twilio Webhook] Inbound from", from, "- body:", message.substring(0, 100));
        if (messageSid && ((0, smsStore_js_1.isMessageHandleSeen)(messageSid) || !(0, index_js_18.claimTwilioInboundSid)(messageSid))) {
            console.log("[Twilio Webhook] Duplicate message, ignoring:", messageSid);
            res.status(200).send("");
            return;
        }
        if (!from) {
            res.status(200).send("");
            return;
        }
        const inspectionConfirmation = (0, inspectionFlow_js_1.checkInspectionConfirmation)(from, message);
        if (inspectionConfirmation.handled && inspectionConfirmation.replyMessage?.trim()) {
            const replyText = inspectionConfirmation.replyMessage.trim();
            if ((0, index_js_18.isTwilioConfigured)()) {
                const send = await (0, index_js_18.sendTwilioMessage)({ to: from, content: replyText });
                if (!send.success) {
                    console.error("[Twilio] inspection confirmation reply failed:", send.error);
                }
                else {
                    console.log("[InspectionFlow] Confirmation reply sent to", inspectionConfirmation.role, "for tx", inspectionConfirmation.transactionId);
                }
            }
            const latencyMs = Date.now() - inboundReceivedAt;
            console.log("[InboundSMS] Reply latency:", latencyMs, "ms (inspection confirmation)");
            res.status(200).send("");
            return;
        }
        const lead = await (0, db_js_1.findLeadByPhoneDigits)(from);
        if (!lead) {
            console.warn("[Twilio] inbound from unknown phone:", from);
            res.status(200).send("");
            return;
        }
        const inboundSentAt = new Date().toISOString();
        const inboundSmsId = (0, smsStore_js_1.logSmsIfNew)({
            leadId: lead.id,
            messageBody: message,
            direction: "inbound",
            sentAt: inboundSentAt,
            messageHandle: messageSid || undefined,
            threadType: "general",
        });
        const firstName = (0, inboundReplyHelper_js_1.getLeadFirstName)(lead);
        if (firstName) {
            console.log("[InboundSMS] Lead", lead.id, "first name available for greeting:", firstName);
        }
        const confirmationResult = await (0, index_js_22.checkShowingConfirmation)(lead, message);
        if (confirmationResult.handled && confirmationResult.replyMessage.trim()) {
            const replyText = confirmationResult.replyMessage.trim();
            if (message) {
                await (0, db_js_1.appendMessage)(lead.id, "user", message);
            }
            if ((0, index_js_18.isTwilioConfigured)() && lead.phone) {
                const send = await (0, index_js_18.sendTwilioMessage)({ to: lead.phone, content: replyText });
                if (!send.success) {
                    console.error("[Twilio] showing confirmation reply failed:", send.error);
                }
                else {
                    const replySentAt = new Date().toISOString();
                    (0, smsStore_js_1.logSmsMessage)({
                        leadId: lead.id,
                        messageBody: replyText,
                        direction: "outbound",
                        sentAt: replySentAt,
                        threadType: "showing_reminder",
                        messageHandle: send.messageSid,
                    });
                    if (inboundSmsId)
                        (0, smsStore_js_1.markRepliedAt)(inboundSmsId, replySentAt);
                    await (0, db_js_1.appendMessage)(lead.id, "assistant", replyText);
                }
            }
            const latencyMs = Date.now() - inboundReceivedAt;
            console.log("[InboundSMS] Reply latency:", latencyMs, "ms for lead", lead.id, "(showing confirmation)");
            if (latencyMs > 60000) {
                console.warn("[InboundSMS] ⚠️ Reply exceeded 60s target:", latencyMs, "ms");
            }
            res.status(200).send("");
            return;
        }
        await (0, index_js_22.checkPostShowingFeedback)(lead, message);
        let activeLead = (await (0, db_js_1.getLeadById)(lead.id)) ?? lead;
        if ((0, index_js_23.isMojoLead)(activeLead) &&
            activeLead.mojoOutreach &&
            (activeLead.mojoOutreach.status === "active" || activeLead.mojoOutreach.status === "paused")) {
            await (0, db_js_1.updateLeadCrmFields)({
                leadId: activeLead.id,
                mojoOutreach: { ...activeLead.mojoOutreach, status: "replied" },
            });
            activeLead = (await (0, db_js_1.getLeadById)(activeLead.id)) ?? activeLead;
        }
        const escalation = (0, index_js_24.detectConversationEscalation)(message);
        if (escalation.triggered && escalation.type) {
            await (0, db_js_1.updateLeadCrmFields)({
                leadId: activeLead.id,
                automationPaused: true,
                automationPausedReason: escalation.type,
                automationPausedAt: new Date().toISOString(),
            });
            await (0, index_js_24.notifyMarcoOfConversationEscalation)(activeLead, escalation.type, message);
            if (escalation.type === "angry_client" &&
                escalation.holdMessage &&
                (0, index_js_18.isTwilioConfigured)() &&
                activeLead.phone) {
                const holdText = escalation.holdMessage;
                const send = await (0, index_js_18.sendTwilioMessage)({ to: activeLead.phone, content: holdText });
                if (!send.success) {
                    console.error("[ConvEscalation] empathy hold send failed:", send.error);
                }
                else {
                    const holdSentAt = new Date().toISOString();
                    (0, smsStore_js_1.logSmsMessage)({
                        leadId: activeLead.id,
                        messageBody: holdText,
                        direction: "outbound",
                        sentAt: holdSentAt,
                        threadType: "escalation_hold",
                        messageHandle: send.messageSid,
                    });
                    if (inboundSmsId)
                        (0, smsStore_js_1.markRepliedAt)(inboundSmsId, holdSentAt);
                }
            }
            res.status(200).send("");
            return;
        }
        if (activeLead.automationPaused) {
            console.log("[ConvEscalation] Lead", activeLead.id, "has paused automation (", activeLead.automationPausedReason, ") — message logged but no auto-reply");
            res.status(200).send("");
            return;
        }
        const payload = {
            platform: activeLead.platform,
            userId: activeLead.userId,
            username: activeLead.username,
            displayName: activeLead.name,
            message,
            commentOrDm: "dm",
            marcoPreviousOutbound: null,
        };
        const requestId = (0, marcoLog_js_1.newMarcoRequestId)();
        const correlationId = (0, marcoLog_js_1.marcoCorrelationId)(payload.platform, payload.userId);
        const result = await (0, webhook_js_1.handleIncomingPayload)(payload, { requestId, correlationId });
        if (result.reply?.trim() && (0, index_js_18.isTwilioConfigured)()) {
            const replyText = result.reply.trim();
            const send = await (0, index_js_18.sendTwilioMessage)({ to: activeLead.phone, content: replyText });
            if (!send.success) {
                console.error("[Twilio] outbound after pipeline failed:", send.error);
            }
            else {
                const replySentAt = new Date().toISOString();
                (0, smsStore_js_1.logSmsMessage)({
                    leadId: activeLead.id,
                    messageBody: replyText,
                    direction: "outbound",
                    sentAt: replySentAt,
                    threadType: "general",
                    messageHandle: send.messageSid,
                });
                if (inboundSmsId)
                    (0, smsStore_js_1.markRepliedAt)(inboundSmsId, replySentAt);
            }
        }
        const latencyMs = Date.now() - inboundReceivedAt;
        console.log("[InboundSMS] Reply latency:", latencyMs, "ms for lead", activeLead.id);
        if (latencyMs > 60000) {
            console.warn("[InboundSMS] ⚠️ Reply exceeded 60s target:", latencyMs, "ms");
        }
        res.status(200).send("");
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[Twilio] /webhook/twilio error:", err);
        res.status(500).send(message);
    }
});
/** CRM / VA: outbound text via Twilio — pick a saved lead or send to a custom number. */
app.post("/api/sms/send", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    if (!(0, index_js_18.isTwilioConfigured)()) {
        res.status(503).json({
            error: "Twilio not configured",
            hint: "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER on the server",
        });
        return;
    }
    const leadId = typeof req.body?.leadId === "string" ? req.body.leadId.trim() : "";
    const toRaw = typeof req.body?.to === "string" ? req.body.to.trim() : "";
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) {
        res.status(400).json({ error: "Missing content" });
        return;
    }
    if (!leadId && !toRaw) {
        res.status(400).json({ error: "Provide leadId or to (phone number)" });
        return;
    }
    try {
        let to = "";
        let threadLeadId = null;
        if (leadId) {
            const lead = await (0, db_js_1.getLeadById)(leadId);
            if (!lead) {
                res.status(404).json({ error: "Lead not found" });
                return;
            }
            if (!lead.phone?.trim()) {
                res.status(400).json({ error: "Lead has no phone number" });
                return;
            }
            to = (0, index_js_18.normalizeToUsE164)(lead.phone);
            threadLeadId = lead.id;
        }
        else {
            to = (0, index_js_18.normalizeToUsE164)(toRaw);
            const digits = to.replace(/\D/g, "");
            if (digits.length < 10) {
                res.status(400).json({ error: "Invalid phone number" });
                return;
            }
            const matched = await (0, db_js_1.findLeadByPhoneDigits)(to);
            if (matched)
                threadLeadId = matched.id;
        }
        const send = await (0, index_js_18.sendTwilioMessage)({ to, content });
        if (!send.success) {
            res.status(502).json({ error: send.error });
            return;
        }
        if (threadLeadId) {
            await (0, db_js_1.appendMessage)(threadLeadId, "assistant", content);
            (0, smsStore_js_1.logSmsMessage)({
                leadId: threadLeadId,
                messageBody: content,
                direction: "outbound",
                sentAt: new Date().toISOString(),
                threadType: "manual",
                messageHandle: send.messageSid,
            });
        }
        res.status(200).json({ success: true, messageSid: send.messageSid, threadAttached: Boolean(threadLeadId) });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
function leadFirstName(lead) {
    const raw = (lead.name || lead.username || "").trim();
    const first = raw.split(/\s+/)[0];
    return first || "there";
}
async function sendLeadText(leadId, content, threadType = "general") {
    const lead = await (0, db_js_1.getLeadById)(leadId);
    if (!lead?.phone?.trim())
        return { ok: false, error: "Lead has no phone number" };
    if (!(0, index_js_18.isTwilioConfigured)())
        return { ok: false, error: "Twilio not configured" };
    const to = (0, index_js_18.normalizeToUsE164)(lead.phone);
    const send = await (0, index_js_18.sendTwilioMessage)({ to, content });
    if (!send.success)
        return { ok: false, error: send.error };
    await (0, db_js_1.appendMessage)(leadId, "assistant", content);
    (0, smsStore_js_1.logSmsMessage)({
        leadId,
        messageBody: content,
        direction: "outbound",
        sentAt: new Date().toISOString(),
        threadType,
        messageHandle: send.messageSid,
    });
    return { ok: true };
}
/** Website visit — re-engagement when lead is ghosted (30+ days no inbound SMS). */
app.post("/api/leads/:id/website-visit", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leadId = String(req.params.id || "").trim();
    if (!leadId) {
        res.status(400).json({ error: "Missing lead id" });
        return;
    }
    try {
        const result = await (0, index_js_10.handleWebsiteVisit)(leadId);
        res.status(200).json(result);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message, triggered: false });
    }
});
/** Legacy website visit intake (body: leadId or phone) — delegates to re-engagement agent. */
app.post("/api/activity/website-visit", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leadIdRaw = typeof req.body?.leadId === "string" ? req.body.leadId.trim() : "";
    const phoneRaw = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
    let lead = leadIdRaw ? await (0, db_js_1.getLeadById)(leadIdRaw) : null;
    if (!lead && phoneRaw)
        lead = await (0, db_js_1.findLeadByPhoneDigits)(phoneRaw);
    if (!lead) {
        res.status(404).json({ error: "Lead not found", triggered: false });
        return;
    }
    try {
        const result = await (0, index_js_10.handleWebsiteVisit)(lead.id);
        res.status(200).json({ ...result, leadId: lead.id });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message, triggered: false });
    }
});
/** Listing status intake — transition detection; manual today, MLS feed later. */
app.post("/api/leads/:id/listing-status", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leadId = String(req.params.id || "").trim();
    const address = typeof req.body?.address === "string" ? req.body.address.trim() : "";
    const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    const sourceRaw = req.body?.source;
    const source = sourceRaw === "mls_feed" ? "mls_feed" : "manual";
    if (!address || !status) {
        res.status(400).json({ error: "address and status required" });
        return;
    }
    const allowed = new Set(["active", "pending", "off_market", "expired", "sold"]);
    if (!allowed.has(status)) {
        res.status(400).json({ error: "Invalid status" });
        return;
    }
    try {
        const result = await (0, index_js_11.handleListingStatusUpdate)(leadId, address, status, source);
        res.status(200).json(result);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message, triggered: false });
    }
});
/** CRM automation notifications (re-engagement, listing status). */
app.get("/api/crm/notifications", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const unreadOnly = req.query.unreadOnly === "true";
    res.json({ notifications: unreadOnly ? (0, crmNotificationStore_js_1.getUnreadNotifications)() : (0, crmNotificationStore_js_1.getAllNotifications)() });
});
app.post("/api/crm/notifications/:id/read", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    (0, crmNotificationStore_js_1.markNotificationRead)(String(req.params.id || ""));
    res.json({ success: true });
});
/** Content Manager — ingest, repurpose, compliance, publish, analytics. */
app.post("/api/content/ingest", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const type = req.body?.type;
    if (!["video", "listing_url", "market_stat", "calendar"].includes(type)) {
        res.status(400).json({ error: "type must be video, listing_url, market_stat, or calendar" });
        return;
    }
    try {
        const session = await (0, index_js_12.ingestContent)({
            type,
            path: typeof req.body?.path === "string" ? req.body.path : undefined,
            url: typeof req.body?.url === "string" ? req.body.url : undefined,
            meta: req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : undefined,
        });
        res.json(session);
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.post("/api/content/repurpose/:sessionId", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    try {
        const clips = await (0, index_js_12.repurposeSession)(String(req.params.sessionId || ""));
        res.json({ clips });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.post("/api/content/compliance/:videoId", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    try {
        const result = await (0, index_js_12.runComplianceCheck)(String(req.params.videoId || ""));
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.post("/api/content/publish/:videoId", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const platform = typeof req.body?.platform === "string" ? req.body.platform.trim() : "";
    if (!platform) {
        res.status(400).json({ error: "platform required" });
        return;
    }
    const scheduledFor = typeof req.body?.scheduled_for === "string" ? req.body.scheduled_for.trim() : null;
    try {
        if (scheduledFor) {
            (0, contentDb_js_1.updateContentVideo)(String(req.params.videoId || ""), {
                status: "scheduled",
                scheduledFor,
            });
        }
        const log = await (0, index_js_12.publishVideo)(String(req.params.videoId || ""), platform, { scheduledFor });
        res.json(log);
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.post("/api/content/triage-dm", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const platform = typeof req.body?.platform === "string" ? req.body.platform.trim() : "";
    const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!platform || !userId || !message) {
        res.status(400).json({ error: "platform, userId, and message required" });
        return;
    }
    try {
        const result = await (0, index_js_12.triageDm)({
            platform,
            userId,
            message,
            username: typeof req.body?.username === "string" ? req.body.username : undefined,
        });
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.get("/api/content/queue", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const batchId = typeof req.query.batch_id === "string" ? req.query.batch_id.trim() : "";
    const limit = Number(req.query.limit) || 200;
    const validStatuses = new Set([
        "processing",
        "pending_review",
        "approved",
        "scheduled",
        "published",
        "rejected",
    ]);
    const videos = (0, contentDb_js_1.listContentVideosWithEnhancements)({
        status: validStatuses.has(status)
            ? status
            : undefined,
        batchSessionId: batchId || undefined,
        limit,
    });
    res.json({ videos });
});
app.get("/api/content/stats", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json((0, contentDb_js_1.getContentManagerStats)());
});
app.get("/api/content/lead-captures", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const capturedFrom = req.query.captured_from === "dm" || req.query.captured_from === "comment"
        ? req.query.captured_from
        : undefined;
    const limit = Number(req.query.limit) || 100;
    res.json({ captures: (0, contentDb_js_1.listLeadCaptures)({ capturedFrom, limit }) });
});
app.post("/api/content/comments/log", (_req, res) => {
    if (!dashboardTokenOk(_req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    (0, index_js_12.trackCommentManaged)();
    res.json({ ok: true });
});
app.post("/api/content/compliance/:videoId/decision", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const decision = req.body?.decision;
    if (decision !== "approved" && decision !== "rejected") {
        res.status(400).json({ error: "decision must be approved or rejected" });
        return;
    }
    try {
        const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
        const result = (0, index_js_12.applyComplianceDecision)(String(req.params.videoId || ""), decision, reason);
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.get("/api/content/analytics", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json({
        rows: (0, contentDb_js_1.getAnalyticsDataset)(),
        pillarSummary: (0, contentDb_js_1.getPillarPerformanceSummary)(),
        weekly: (0, index_js_12.getWeeklyReport)(),
    });
});
function resolveContentVideoUploadDir() {
    const base = fs_1.default.existsSync("/data") ? "/data" : path_1.default.join(process.cwd(), "data");
    const dir = path_1.default.join(base, "uploads", "videos");
    fs_1.default.mkdirSync(dir, { recursive: true });
    return dir;
}
const contentVideoUpload = (0, multer_1.default)({
    storage: multer_1.default.diskStorage({
        destination: (_req, _file, cb) => cb(null, resolveContentVideoUploadDir()),
        filename: (_req, file, cb) => {
            const ext = path_1.default.extname(file.originalname) || ".mp4";
            cb(null, `${Date.now()}-${(0, crypto_1.randomUUID)()}${ext}`);
        },
    }),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
        const ext = path_1.default.extname(file.originalname).toLowerCase();
        cb(null, allowed.includes(ext));
    },
});
const batchVideoUpload = (0, multer_1.default)({
    storage: multer_1.default.diskStorage({
        destination: (_req, _file, cb) => cb(null, resolveContentVideoUploadDir()),
        filename: (_req, file, cb) => {
            const ext = path_1.default.extname(file.originalname) || ".mp4";
            cb(null, `${Date.now()}-${(0, crypto_1.randomUUID)()}${ext}`);
        },
    }),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
        const ext = path_1.default.extname(file.originalname).toLowerCase();
        cb(null, allowed.includes(ext));
    },
});
app.post("/api/content/upload", contentVideoUpload.single("video"), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    if (!req.file) {
        res.status(400).json({ error: "No video file uploaded (field name: video)" });
        return;
    }
    const pillar = typeof req.body?.pillar === "string" ? req.body.pillar.trim() : "";
    if (!["education", "listings", "brand"].includes(pillar)) {
        res.status(400).json({ error: "pillar required: education, listings, or brand" });
        return;
    }
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : "";
    const savedPath = req.file.path;
    try {
        const session = await (0, index_js_12.ingestContent)({
            type: "video",
            path: savedPath,
            meta: { pillar, notes, originalName: req.file.originalname },
        });
        const clips = await (0, index_js_12.repurposeSession)(session.id);
        res.json({ session, clips, savedPath });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.post("/api/content/batch-upload", batchVideoUpload.array("videos", 20), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const files = req.files;
    if (!files?.length) {
        res.status(400).json({ error: "At least one video file required (field name: videos)" });
        return;
    }
    const pillar = typeof req.body?.pillar === "string" ? req.body.pillar.trim() : "";
    if (!["education", "listings", "brand", "mixed"].includes(pillar)) {
        res.status(400).json({ error: "pillar required: education, listings, brand, or mixed" });
        return;
    }
    const sessionName = typeof req.body?.session_name === "string" ? req.body.session_name.trim() : "";
    const filmedBy = typeof req.body?.filmed_by === "string" && req.body.filmed_by.trim()
        ? req.body.filmed_by.trim()
        : "marco";
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : "";
    const batch = (0, contentDb_js_1.createBatchSession)({
        sessionName: sessionName || null,
        pillar,
        filmedBy,
        status: "uploading",
        sourceFileCount: files.length,
        notes: notes || null,
    });
    for (const file of files) {
        (0, contentDb_js_1.createBatchSourceFile)({
            batchSessionId: batch.id,
            originalFilename: file.originalname,
            fileSizeBytes: file.size,
            filePath: file.path,
        });
    }
    (0, contentDb_js_1.updateBatchSession)(batch.id, { status: "analyzing_trends" });
    setImmediate(() => {
        (0, batchProcessor_js_1.processBatch)(batch.id).catch((err) => {
            console.error(`[batch-upload] processBatch failed for ${batch.id}:`, err);
            (0, contentDb_js_1.updateBatchSession)(batch.id, { status: "failed" });
        });
    });
    res.json({
        ok: true,
        batchSessionId: batch.id,
        fileCount: files.length,
        status: "processing",
        message: `${files.length} video(s) queued for processing`,
    });
});
app.get("/api/content/batch/:batchId/status", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const batchId = String(req.params.batchId || "");
    const batch = (0, contentDb_js_1.getBatchSession)(batchId);
    if (!batch) {
        res.status(404).json({ error: "Batch not found" });
        return;
    }
    const sourceFiles = (0, contentDb_js_1.listBatchSourceFiles)(batchId);
    const clipsReady = (0, contentDb_js_1.countVideosByBatchAndStatus)(batchId, "pending_review");
    let trendBrief = null;
    if (batch.trendBriefId) {
        const trends = (0, contentDb_js_1.getCompetitorTrendsById)(batch.trendBriefId);
        trendBrief = trends?.trendBrief ?? null;
    }
    const progressMap = {
        uploading: 5,
        analyzing_trends: 15,
        processing_opus: 30,
        transcribing: 40,
        analyzing: 55,
        reframing: 70,
        enhancing: 85,
        complete: 100,
        failed: 0,
    };
    const stageLabelMap = {
        uploading: "Uploading files...",
        analyzing_trends: "Analyzing competitor trends...",
        processing_opus: "Sending to OpenShorts...",
        transcribing: "Transcribing audio...",
        analyzing: "Gemini AI finding viral moments...",
        reframing: "Reframing to vertical 9:16...",
        enhancing: "Generating hooks and captions...",
        complete: "Complete",
        failed: "Processing failed",
    };
    const files = sourceFiles.map((f) => ({
        id: f.id,
        filename: f.originalFilename,
        fileSize: f.fileSizeBytes,
        opusStatus: f.opusStatus,
        clipsGenerated: f.clipsGeneratedCount,
        errorMessage: f.errorMessage,
        uploadedAt: f.uploadedAt,
        completedAt: f.opusCompletedAt,
    }));
    const progressPct = progressMap[batch.status] ?? 10;
    const failedFiles = sourceFiles.filter((f) => f.opusStatus === "failed");
    const errorMessages = failedFiles.map((f) => ({
        filename: f.originalFilename,
        error: f.errorMessage,
    }));
    res.json({
        ok: true,
        batchSessionId: batch.id,
        sessionName: batch.sessionName,
        status: batch.status,
        stageLabel: stageLabelMap[batch.status] || "Processing...",
        progressPct,
        sourceFileCount: batch.sourceFileCount,
        clipsGenerated: batch.clipsGenerated,
        clipsReady,
        trendBriefId: batch.trendBriefId,
        createdAt: batch.createdAt,
        completedAt: batch.completedAt,
        trendBrief,
        batch,
        sourceFiles,
        files,
        errorMessages,
        failedFileCount: failedFiles.length,
    });
});
app.get("/api/content/batch/:batchId/clips", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const batchId = String(req.params.batchId || "");
    const clips = (0, contentDb_js_1.listContentVideosWithEnhancements)({ batchSessionId: batchId, limit: 200 });
    res.json({ clips });
});
app.get("/api/content/batches", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const days = Number(req.query.days) || 7;
    res.json({ batches: (0, contentDb_js_1.listBatchSessions)(days) });
});
app.get("/api/content/competitor-trends/latest", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const trends = (0, contentDb_js_1.getLatestCompetitorTrends)();
    res.json({ trends });
});
app.post("/api/content/competitor-trends/refresh", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    try {
        const trends = await (0, competitorIntel_js_1.runCompetitorScrape)();
        res.json({ trends });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.patch("/api/content/clip/:clipId/metadata", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const clipId = String(req.params.clipId || "");
    const video = (0, contentDb_js_1.getContentVideo)(clipId);
    if (!video) {
        res.status(404).json({ error: "Clip not found" });
        return;
    }
    const enhancement = (0, contentDb_js_1.getClipEnhancementByVideoId)(clipId);
    const body = req.body;
    const videoPatch = {};
    if (typeof body.hook === "string")
        videoPatch.hook = body.hook;
    if (typeof body.caption === "string")
        videoPatch.caption = body.caption;
    if (typeof body.title === "string")
        videoPatch.title = body.title;
    if (Array.isArray(body.hashtags)) {
        videoPatch.hashtags = body.hashtags.map(String);
    }
    if (Array.isArray(body.platform_targets)) {
        videoPatch.platformTargets = body.platform_targets.map(String);
        const first = body.platform_targets[0];
        if (typeof first === "string") {
            videoPatch.platformTarget = first;
        }
    }
    (0, contentDb_js_1.updateContentVideo)(clipId, videoPatch);
    if (enhancement) {
        (0, contentDb_js_1.updateClipEnhancement)(enhancement.id, {
            hookPrimary: typeof body.hook === "string" ? body.hook : undefined,
            captionFinal: typeof body.caption === "string" ? body.caption : undefined,
            titleFinal: typeof body.title === "string" ? body.title : undefined,
            hashtagsFinal: Array.isArray(body.hashtags) ? body.hashtags.map(String) : undefined,
            platformTargets: Array.isArray(body.platform_targets)
                ? body.platform_targets.map(String)
                : undefined,
            editedBy: "human",
        });
    }
    const updated = (0, contentDb_js_1.getContentVideo)(clipId);
    const updatedEnhancement = (0, contentDb_js_1.getClipEnhancementByVideoId)(clipId);
    res.json({ video: updated, enhancement: updatedEnhancement });
});
function getNextOptimalPostTimeCst() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(19, 0, 0, 0);
    if (now >= target)
        target.setDate(target.getDate() + 1);
    return target.toISOString();
}
app.get("/api/content/publishing-queue", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const limit = Number(req.query.limit) || 50;
    const clips = (0, contentDb_js_1.listPublishingQueue)(limit);
    res.json({ clips });
});
app.post("/api/content/clip/:clipId/send-to-publisher", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    try {
        const clipId = String(req.params.clipId || "");
        const video = (0, contentDb_js_1.getContentVideo)(clipId);
        if (!video) {
            res.status(404).json({ error: "Clip not found" });
            return;
        }
        if (video.status !== "pending_review" && video.status !== "approved") {
            res.status(400).json({ error: "Clip must be pending_review or approved" });
            return;
        }
        const body = req.body;
        const overrideCompliance = Boolean(body.override_compliance);
        if (video.complianceFlagged && !overrideCompliance) {
            res.status(400).json({
                error: "Clip has compliance flags. Review before sending.",
                flags: video.complianceNotes,
            });
            return;
        }
        const enhancement = (0, contentDb_js_1.getClipEnhancementByVideoId)(clipId);
        const scheduledFor = typeof body.scheduled_for === "string" && body.scheduled_for.trim()
            ? body.scheduled_for.trim()
            : enhancement?.optimalPostTimeTiktok ?? getNextOptimalPostTimeCst();
        const platforms = Array.isArray(body.platforms)
            ? body.platforms.map(String)
            : enhancement?.platformTargets?.length
                ? enhancement.platformTargets
                : [video.platformTarget];
        const now = new Date().toISOString();
        (0, contentDb_js_1.updateContentVideo)(clipId, {
            status: "approved",
            approvedAt: now,
            scheduledFor,
            platformTargets: platforms,
        });
        const publishEntries = [];
        for (const platform of platforms) {
            (0, contentDb_js_1.insertPublishLog)({
                videoId: clipId,
                platform,
                platformPostId: null,
                publishedAt: scheduledFor,
                publishStatus: "scheduled",
                errorMessage: null,
            });
            publishEntries.push({ platform, scheduledFor });
        }
        const scheduleDate = scheduledFor.slice(0, 10);
        (0, contentDb_js_1.ensureDailyTargets)(scheduleDate);
        (0, contentDb_js_1.incrementDailyTarget)(scheduleDate, "videos_published", 1);
        res.json({
            ok: true,
            clipId,
            status: "approved",
            scheduledFor,
            platforms,
            publishEntries,
        });
    }
    catch (err) {
        console.error("[send-to-publisher] Error:", err);
        res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
    }
});
app.get("/api/content/competitor-profiles", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json({ profiles: (0, contentDb_js_1.listAllCompetitorProfiles)() });
});
app.post("/api/content/competitor-profiles", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const tiktokHandle = typeof req.body?.tiktok_handle === "string" ? req.body.tiktok_handle.trim() : "";
    const displayName = typeof req.body?.display_name === "string" ? req.body.display_name.trim() : "";
    const profileType = typeof req.body?.profile_type === "string" ? req.body.profile_type.trim() : "";
    if (!tiktokHandle || !displayName || !profileType) {
        res.status(400).json({ error: "tiktok_handle, display_name, and profile_type required" });
        return;
    }
    const profile = (0, contentDb_js_1.insertCompetitorProfile)({ tiktokHandle, displayName, profileType });
    res.json({ profile });
});
app.patch("/api/content/competitor-profiles/:id", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "");
    const active = req.body?.active;
    const profile = (0, contentDb_js_1.updateCompetitorProfile)(id, {
        active: active === 0 || active === false ? false : active === 1 || active === true ? true : undefined,
    });
    if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
    }
    res.json({ profile });
});
app.get("/api/content/youtube-analysis/latest", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const a = (0, contentDb_js_1.getLatestYoutubeAnalysis)();
    if (!a) {
        res.json({
            analysis: null,
            message: "No YouTube analysis yet. It runs automatically on Sunday nights or you can trigger it manually.",
        });
        return;
    }
    res.json({
        analysis: {
            id: a.id,
            analyzed_at: a.analyzedAt,
            videos_analyzed: a.videosAnalyzed,
            channels_analyzed: a.channelsAnalyzed,
            top_hook_structures: a.topHookStructures,
            top_opening_phrases: a.topOpeningPhrases,
            top_topics: a.topTopics,
            top_data_points: a.topDataPoints,
            top_cta_patterns: a.topCtaPatterns,
            content_gaps: a.contentGaps,
            full_analysis_markdown: a.keyInsights,
            trend_signals: a.topRecommendedVideoIdea,
            week_start: a.weekStart,
        },
    });
});
app.post("/api/content/youtube-analysis/run", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    void (0, youtubeIntel_js_1.runYouTubeCompetitorAnalysis)(index_js_13.contentManagerBrain).catch((err) => {
        console.error("[youtube-intel] manual run failed:", err);
    });
    res.json({
        ok: true,
        message: "YouTube transcript analysis started. Check back in 2-3 minutes.",
    });
});
app.get("/api/content/youtube-profiles", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json({ profiles: (0, contentDb_js_1.listAllYoutubeProfiles)() });
});
app.post("/api/content/youtube-profiles", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const youtubeChannelUrl = typeof req.body?.youtube_channel_url === "string" ? req.body.youtube_channel_url.trim() : "";
    const channelName = typeof req.body?.channel_name === "string" ? req.body.channel_name.trim() : "";
    const profileType = typeof req.body?.profile_type === "string" ? req.body.profile_type.trim() : "competitor";
    if (!youtubeChannelUrl) {
        res.status(400).json({ error: "youtube_channel_url required" });
        return;
    }
    const profile = (0, contentDb_js_1.insertYoutubeProfile)({
        youtubeChannelUrl,
        channelName: channelName || undefined,
        profileType,
    });
    res.json({ profile });
});
app.patch("/api/content/youtube-profiles/:id", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "");
    const active = req.body?.active;
    const profile = (0, contentDb_js_1.updateYoutubeProfile)(id, {
        active: active === 0 || active === false ? false : active === 1 || active === true ? true : undefined,
    });
    if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
    }
    res.json({ profile });
});
app.get("/api/content/youtube-transcripts", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const channelName = typeof req.query.channel_name === "string" ? req.query.channel_name : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    res.json({ transcripts: (0, contentDb_js_1.listYoutubeTranscripts)({ channelName, limit }) });
});
app.get("/api/content/youtube-transcripts/:videoId", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const transcript = (0, contentDb_js_1.getYoutubeTranscript)(String(req.params.videoId || ""));
    if (!transcript) {
        res.status(404).json({ error: "Transcript not found" });
        return;
    }
    res.json({ transcript });
});
app.get("/api/content/compliance-queue", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json({ pending: (0, contentDb_js_1.listPendingComplianceQueue)() });
});
app.get("/api/content/report/daily", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const date = typeof req.query.date === "string" ? req.query.date : undefined;
    res.json((0, index_js_12.getDailyReport)(date));
});
app.get("/api/content/report/weekly", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json((0, index_js_12.getWeeklyReport)());
});
app.post("/api/content/sync", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    try {
        const summary = await (0, index_js_12.runPerformanceSync)();
        res.json(summary);
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.get("/api/content-brain/status", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const today = (0, contentDb_js_1.todayDateCst)();
    res.json({
        latestBriefing: (0, contentDb_js_1.getLatestBriefing)(),
        todayStrategy: (0, contentDb_js_1.getDailyStrategy)(today),
        dailyTargets: (0, contentDb_js_1.ensureDailyTargets)(today),
        performanceModel: (0, contentDb_js_1.getPerformanceModel)(),
    });
});
app.get("/api/content-brain/strategy", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const strategy = (0, contentDb_js_1.getDailyStrategy)((0, contentDb_js_1.todayDateCst)());
    if (!strategy) {
        res.status(404).json({ error: "Morning cycle has not run yet today." });
        return;
    }
    res.json(strategy);
});
app.get("/api/content-brain/learning", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const days = Number(req.query.days) || 7;
    res.json({ entries: (0, contentDb_js_1.listLearningLogs)({ limit: days * 4, days }) });
});
app.get("/api/content-brain/performance-model", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const model = (0, contentDb_js_1.getPerformanceModel)();
    if (!model) {
        res.json({ model: null, message: "Performance model not yet built — evening cycle will populate." });
        return;
    }
    res.json(model);
});
app.get("/api/content-brain/briefings", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const limit = Number(req.query.limit) || 10;
    res.json({ briefings: (0, contentDb_js_1.listBriefings)({ briefingType: type, limit }) });
});
app.get("/api/content-brain/benchmark-trajectory", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json((0, tools_js_1.computeBenchmarkTrajectory)());
});
app.post("/api/content-brain/ask", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question) {
        res.status(400).json({ error: "question required" });
        return;
    }
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : undefined;
    try {
        const { response, sessionId: sid } = await index_js_13.contentManagerBrain.chatWithSession(question, sessionId);
        res.json({ response, sessionId: sid, answer: response, timestamp: new Date().toISOString() });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.get("/api/content-brain/sessions", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json({ sessions: (0, contentDb_js_1.listActiveChatSessions)(10) });
});
app.get("/api/content-brain/sessions/:sessionId/messages", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const sessionId = String(req.params.sessionId || "");
    res.json({ messages: (0, contentDb_js_1.listChatMessages)(sessionId) });
});
app.post("/api/content-brain/sessions/new", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json({ sessionId: (0, index_js_13.getOrCreateSession)() });
});
app.get("/api/content-brain/self-evaluation", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json({ evaluations: (0, contentDb_js_1.listSelfEvaluations)(4) });
});
app.get("/api/content-brain/accuracy", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const rows = (0, contentDb_js_1.listStrategyAccuracy)(14).map((r) => ({
        strategy_date: r.strategyDate,
        confidence_score_given: r.confidenceScoreGiven,
        outcome_score: r.outcomeScore,
        overall_grade: r.overallGrade,
        pillar_prediction_correct: r.pillarPredictionCorrect,
        hooks_hit_rate: r.hooksHitRate,
    }));
    res.json({ accuracy: rows });
});
app.get("/api/content-brain/experiments", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json({ experiments: (0, contentDb_js_1.listExperiments)(50) });
});
app.get("/api/content-brain/combination-patterns", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const pillar = typeof req.query.pillar === "string" ? req.query.pillar : undefined;
    const minSamples = Number(req.query.min_samples) || 2;
    const limit = Number(req.query.limit) || 20;
    res.json({
        patterns: (0, contentDb_js_1.listCombinationPatterns)({ pillar, minSamples, limit, order: "desc" }),
    });
});
app.get("/api/content-brain/momentum", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const model = (0, contentDb_js_1.getPerformanceModel)();
    const seasonal = (0, contentDb_js_1.getSeasonalWeek)((0, stats_js_1.getCurrentWeekNumber)());
    res.json({
        current_streak_type: model.currentStreakType,
        hot_streak_count: model.hotStreakCount,
        cold_streak_count: model.coldStreakCount,
        streak_started_at: model.streakStartedAt,
        decay_weighted_avg_views: model.decayWeightedAvgViews,
        season_multiplier: model.seasonMultiplier,
        season_label: seasonal?.seasonLabel ?? null,
        self_grade_last_week: model.selfGradeLastWeek,
    });
});
app.post("/api/content-brain/run-cycle", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const cycle = req.body?.cycle;
    const valid = new Set(["morning", "midday", "evening", "night", "monday_recording_plan"]);
    if (!valid.has(cycle)) {
        res.status(400).json({ error: "cycle must be morning|midday|evening|night|monday_recording_plan" });
        return;
    }
    try {
        if (cycle === "morning")
            await index_js_13.contentManagerBrain.runMorningCycle();
        else if (cycle === "midday")
            await index_js_13.contentManagerBrain.runMiddayCycle();
        else if (cycle === "evening")
            await index_js_13.contentManagerBrain.runEveningCycle();
        else if (cycle === "monday_recording_plan") {
            const tasks = await (0, calendar_js_1.generateWeeklyRecordingPlan)((0, stats_js_2.getWeekStart)(), index_js_13.contentManagerBrain);
            res.json({ ok: true, log: `[cm-brain] Recording plan: ${tasks.length} tasks created`, tasks });
            return;
        }
        else
            await index_js_13.contentManagerBrain.runNightCycle();
        res.json({ ok: true, log: `[cm-brain] ${cycle} cycle completed manually` });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.get("/api/content-brain/cut-list", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json({ items: (0, contentDb_js_1.listCutList)(true) });
});
app.get("/api/content-brain/hook-library", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const minUses = Number(req.query.min_uses) || 3;
    const limit = Number(req.query.limit) || 20;
    res.json({ hooks: (0, contentDb_js_1.listHookLibrary)({ minUses, limit, order: "desc" }) });
});
app.get("/api/content/competitive-analysis/latest", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const analysis = (0, competitiveAnalysis_js_1.getLatestCompetitiveAnalysis)();
    if (!analysis) {
        res.json({
            analysis: null,
            recommendations: [],
            message: "No analysis yet. Run refresh to generate.",
        });
        return;
    }
    res.json({
        analysis,
        recommendations: (0, contentDb_js_1.getActiveStrategyRecommendations)(),
    });
});
app.post("/api/content/competitive-analysis/run", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    (0, competitiveAnalysis_js_1.runFullCompetitiveAnalysis)(index_js_13.contentManagerBrain)
        .then((analysis) => {
        console.log("[competitive-analysis] Async run complete", analysis.id);
    })
        .catch((err) => {
        console.error("[competitive-analysis] Async run failed:", err);
    });
    res.json({ ok: true, message: "Analysis running. Check back in 60 seconds." });
});
app.get("/api/content/strategy-recommendations", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = Number(req.query.limit) || 10;
    const recommendations = status
        ? (0, contentDb_js_1.listStrategyRecommendations)({ status, limit })
        : (0, contentDb_js_1.getActiveStrategyRecommendations)().slice(0, limit);
    res.json({ recommendations });
});
app.patch("/api/content/strategy-recommendations/:id", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "");
    const body = req.body;
    const updated = (0, contentDb_js_1.updateStrategyRecommendation)(id, {
        status: body.status ? String(body.status) : undefined,
        dismissedReason: body.dismissed_reason ? String(body.dismissed_reason) : undefined,
    });
    if (!updated) {
        res.status(404).json({ error: "Recommendation not found" });
        return;
    }
    res.json({ recommendation: updated });
});
app.post("/api/content/strategy-recommendations/:id/create-recording-task", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "");
    const rec = (0, contentDb_js_1.getStrategyRecommendationById)(id);
    if (!rec) {
        res.status(404).json({ error: "Recommendation not found" });
        return;
    }
    try {
        const task = await (0, competitiveAnalysis_js_1.generateRecordingTask)(rec, index_js_13.contentManagerBrain);
        res.json({ task });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.get("/api/content/recording-tasks", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    const days = Number(req.query.days) || 30;
    const today = (0, contentDb_js_1.todayDateCst)();
    const end = new Date(`${today}T12:00:00`);
    end.setDate(end.getDate() + days);
    const endStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(end);
    const tasks = (0, contentDb_js_1.listRecordingTasks)({
        status,
        dueAfter: today,
        dueBefore: endStr,
        limit: 100,
    });
    res.json({ tasks });
});
app.post("/api/content/recording-tasks", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = req.body;
    const hooks = Array.isArray(body.suggested_hooks) ? body.suggested_hooks.map(String) : [];
    const task = (0, contentDb_js_1.insertRecordingTask)({
        dueDate: String(body.due_date || (0, contentDb_js_1.todayDateCst)()),
        pillar: body.pillar ? String(body.pillar) : null,
        hookType: null,
        topic: String(body.topic || ""),
        suggestedHooks: hooks,
        suggestedDurationMin: 35,
        suggestedDurationMax: 55,
        filmingNotes: body.filming_notes ? String(body.filming_notes) : null,
        reason: body.reason ? String(body.reason) : null,
        source: "manual",
        priority: body.priority ? String(body.priority) : "normal",
        strategyRecommendationId: null,
    });
    res.json({ task });
});
app.patch("/api/content/recording-tasks/:id", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "");
    const body = req.body;
    const status = body.status ? String(body.status) : undefined;
    if (status === "filmed" || status === "uploaded") {
        (0, calendar_js_1.markRecordingTaskFiled)(id, body.upload_batch_session_id ? String(body.upload_batch_session_id) : undefined);
        res.json({ ok: true });
        return;
    }
    const updated = (0, contentDb_js_1.updateRecordingTask)(id, { status });
    if (!updated) {
        res.status(404).json({ error: "Task not found" });
        return;
    }
    res.json({ task: updated });
});
app.get("/api/content/calendar/day/:date", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const date = String(req.params.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ error: "Date must be YYYY-MM-DD" });
        return;
    }
    res.json((0, calendar_js_1.getCalendarDayData)(date));
});
app.get("/api/content/calendar/month/:year/:month", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const year = Number(req.params.year);
    const month = Number(req.params.month);
    if (!year || !month || month < 1 || month > 12) {
        res.status(400).json({ error: "Invalid year or month" });
        return;
    }
    res.json((0, calendar_js_1.getCalendarMonthData)(year, month));
});
app.get("/api/content/sprint-progress", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json((0, calendar_js_1.getSprintProgress)());
});
/** Legacy listing status change — maps active/off_market to new intake (uses propertyInquired as address). */
app.post("/api/activity/listing-status-change", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leadId = typeof req.body?.leadId === "string" ? req.body.leadId.trim() : "";
    const statusRaw = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    if (!leadId) {
        res.status(400).json({ error: "Missing leadId" });
        return;
    }
    if (statusRaw !== "active" && statusRaw !== "off_market") {
        res.status(400).json({ error: "status must be active or off_market" });
        return;
    }
    const lead = await (0, db_js_1.getLeadById)(leadId);
    if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
    }
    const address = (typeof req.body?.address === "string" && req.body.address.trim()) ||
        lead.propertyInquired?.trim() ||
        "Unknown address";
    try {
        const mapped = statusRaw === "off_market" ? "off_market" : "active";
        const result = await (0, index_js_11.handleListingStatusUpdate)(leadId, address, mapped, "manual");
        res.status(200).json({ success: true, ...result });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
function parseLeadFilterBody(body) {
    const filter = {};
    if (body.intent === "buyer" || body.intent === "seller" || body.intent === "buyer_seller") {
        filter.intent = body.intent;
    }
    const arr = (key) => {
        const v = body[key];
        if (!Array.isArray(v))
            return undefined;
        const out = v.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim());
        return out.length ? out : undefined;
    };
    filter.status = arr("status");
    filter.source = arr("source");
    filter.stage = arr("stage");
    filter.tags = arr("tags");
    if (typeof body.dateAddedFrom === "string" && body.dateAddedFrom.trim())
        filter.dateAddedFrom = body.dateAddedFrom.trim();
    if (typeof body.dateAddedTo === "string" && body.dateAddedTo.trim())
        filter.dateAddedTo = body.dateAddedTo.trim();
    if (typeof body.lastContactFrom === "string" && body.lastContactFrom.trim()) {
        filter.lastContactFrom = body.lastContactFrom.trim();
    }
    if (typeof body.lastContactTo === "string" && body.lastContactTo.trim())
        filter.lastContactTo = body.lastContactTo.trim();
    if (typeof body.assignedUser === "string" && body.assignedUser.trim())
        filter.assignedUser = body.assignedUser.trim();
    return filter;
}
app.post("/api/leads/filter", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    try {
        const filter = parseLeadFilterBody(body);
        const leads = await (0, leadFilter_js_1.filterDashboardLeads)(filter);
        res.status(200).json({ leads, filter });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
/* ===================== Tag templates API ===================== */
app.get("/api/tag-templates", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.status(200).json({ tagTemplates: (0, tagTemplates_js_1.getTagTemplates)() });
});
app.post("/api/tag-templates", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const color = typeof body.color === "string" ? body.color.trim() : "";
    if (!name) {
        res.status(400).json({ error: "Missing tag name" });
        return;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        res.status(400).json({ error: "Invalid color (use hex, e.g. #f59e0b)" });
        return;
    }
    const created = (0, tagTemplates_js_1.createTagTemplate)(name, color);
    res.status(201).json({ ok: true, tagTemplate: created });
});
app.delete("/api/tag-templates/:id", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    if (!id) {
        res.status(400).json({ error: "Missing tag template id" });
        return;
    }
    const ok = (0, tagTemplates_js_1.deleteTagTemplate)(id);
    if (!ok) {
        res.status(404).json({ error: "Tag template not found" });
        return;
    }
    res.status(200).json({ ok: true });
});
/* ===================== Users API ===================== */
app.get("/api/users", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.status(200).json({ users: (0, users_js_1.getUsers)() });
});
app.post("/api/users", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!name || !email) {
        res.status(400).json({ error: "Missing name or email" });
        return;
    }
    const role = body.role === "admin" || body.role === "agent" || body.role === "isa" || body.role === "custom"
        ? body.role
        : "agent";
    const permissions = body.permissions && typeof body.permissions === "object"
        ? { ...types_js_1.ROLE_PERMISSIONS.custom, ...body.permissions }
        : { ...types_js_1.ROLE_PERMISSIONS[role] };
    const assignedLeadIds = Array.isArray(body.assignedLeadIds)
        ? body.assignedLeadIds.filter((id) => typeof id === "string")
        : undefined;
    const created = (0, users_js_1.createUser)({
        name,
        email,
        role,
        permissions,
        assignedLeadIds,
        active: body.active !== false,
        avatarInitials: typeof body.avatarInitials === "string" ? body.avatarInitials : undefined,
        avatarColor: typeof body.avatarColor === "string" ? body.avatarColor : "#64748b",
    });
    res.status(201).json({ ok: true, user: created });
});
app.patch("/api/users/:id", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const updates = {};
    if (typeof body.name === "string")
        updates.name = body.name;
    if (typeof body.email === "string")
        updates.email = body.email;
    if (body.role === "admin" || body.role === "agent" || body.role === "isa" || body.role === "custom") {
        updates.role = body.role;
    }
    if (body.permissions && typeof body.permissions === "object") {
        updates.permissions = body.permissions;
    }
    if (Array.isArray(body.assignedLeadIds)) {
        updates.assignedLeadIds = body.assignedLeadIds.filter((x) => typeof x === "string");
    }
    if (body.active !== undefined)
        updates.active = Boolean(body.active);
    if (typeof body.avatarColor === "string")
        updates.avatarColor = body.avatarColor;
    const updated = (0, users_js_1.updateUser)(id, updates);
    if (!updated) {
        res.status(404).json({ error: "User not found" });
        return;
    }
    res.status(200).json({ ok: true, user: updated });
});
app.delete("/api/users/:id", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const ok = (0, users_js_1.deleteUser)(id);
    if (!ok) {
        res.status(404).json({ error: "User not found" });
        return;
    }
    res.status(200).json({ ok: true });
});
/* ===================== Auto Plans API ===================== */
app.get("/api/auto-plans", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.status(200).json({ plans: (0, autoPlans_js_1.getAutoPlans)() });
});
app.post("/api/auto-plans", express_1.default.json({ limit: "2mb" }), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const name = typeof body.name === "string" ? body.name : "";
    if (!name.trim()) {
        res.status(400).json({ error: "Missing plan name" });
        return;
    }
    const plan = (0, autoPlans_js_1.createAutoPlan)({
        name,
        tag: typeof body.tag === "string" ? body.tag : "",
        steps: Array.isArray(body.steps) ? body.steps : [],
        active: body.active !== false,
    });
    res.status(201).json({ plan });
});
app.patch("/api/auto-plans/:id", express_1.default.json({ limit: "2mb" }), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const updates = {};
    if (typeof body.name === "string")
        updates.name = body.name;
    if (typeof body.tag === "string")
        updates.tag = body.tag;
    if (Array.isArray(body.steps))
        updates.steps = body.steps;
    if (typeof body.active === "boolean")
        updates.active = body.active;
    const plan = (0, autoPlans_js_1.updateAutoPlan)(id, updates);
    if (!plan) {
        res.status(404).json({ error: "Plan not found" });
        return;
    }
    res.status(200).json({ plan });
});
app.delete("/api/auto-plans/:id", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const ok = (0, autoPlans_js_1.deleteAutoPlan)(id);
    if (!ok) {
        res.status(404).json({ error: "Plan not found" });
        return;
    }
    res.status(200).json({ success: true });
});
app.post("/api/auto-plans/:id/enroll/:leadId", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const planId = String(req.params.id || "").trim();
    const leadId = String(req.params.leadId || "").trim();
    const plan = (0, autoPlans_js_1.getAutoPlanById)(planId);
    if (!plan) {
        res.status(404).json({ error: "Plan not found" });
        return;
    }
    const lead = await (0, db_js_1.getLeadById)(leadId);
    if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
    }
    const existing = (lead.autoPlanEnrollments || []).filter((e) => e.planId !== planId);
    const enrollment = {
        planId: plan.id,
        planName: plan.name,
        enrolledAt: new Date().toISOString(),
        currentStepIndex: 0,
        completedSteps: [],
        status: "active",
    };
    await (0, db_js_1.updateLeadCrmFields)({ leadId, autoPlanEnrollments: [...existing, enrollment] });
    res.status(200).json({ success: true, enrollment });
});
app.post("/api/auto-plans/unenroll/:leadId/:planId", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leadId = String(req.params.leadId || "").trim();
    const planId = String(req.params.planId || "").trim();
    const lead = await (0, db_js_1.getLeadById)(leadId);
    if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
    }
    const next = (lead.autoPlanEnrollments || []).filter((e) => e.planId !== planId);
    await (0, db_js_1.updateLeadCrmFields)({ leadId, autoPlanEnrollments: next });
    res.status(200).json({ success: true });
});
async function mutateAutoPlanEnrollment(leadId, planId, mutator) {
    const lead = await (0, db_js_1.getLeadById)(leadId);
    if (!lead)
        return null;
    let found = null;
    const next = (lead.autoPlanEnrollments || []).flatMap((enr) => {
        if (enr.planId !== planId)
            return [enr];
        const updated = mutator(enr);
        if (updated) {
            found = updated;
            return [updated];
        }
        return [];
    });
    if (!found)
        return null;
    await (0, db_js_1.updateLeadCrmFields)({ leadId, autoPlanEnrollments: next });
    return found;
}
app.post("/api/auto-plans/enrollment/:leadId/:planId/pause", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leadId = String(req.params.leadId || "").trim();
    const planId = String(req.params.planId || "").trim();
    const enr = await mutateAutoPlanEnrollment(leadId, planId, (e) => e.status === "completed" ? e : { ...e, status: "paused" });
    if (!enr) {
        res.status(404).json({ error: "Enrollment not found" });
        return;
    }
    res.status(200).json({ success: true, enrollment: enr });
});
app.post("/api/auto-plans/enrollment/:leadId/:planId/resume", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leadId = String(req.params.leadId || "").trim();
    const planId = String(req.params.planId || "").trim();
    const enr = await mutateAutoPlanEnrollment(leadId, planId, (e) => e.status === "completed" ? e : { ...e, status: "active" });
    if (!enr) {
        res.status(404).json({ error: "Enrollment not found" });
        return;
    }
    res.status(200).json({ success: true, enrollment: enr });
});
app.post("/api/auto-plans/enrollment/:leadId/:planId/skip-step", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leadId = String(req.params.leadId || "").trim();
    const planId = String(req.params.planId || "").trim();
    const plan = (0, autoPlans_js_1.getAutoPlanById)(planId);
    if (!plan) {
        res.status(404).json({ error: "Plan not found" });
        return;
    }
    const enr = await mutateAutoPlanEnrollment(leadId, planId, (e) => {
        const completed = new Set(e.completedSteps);
        const nextStep = plan.steps.find((s) => !completed.has(s.id));
        if (!nextStep)
            return e;
        completed.add(nextStep.id);
        const allDone = plan.steps.every((s) => completed.has(s.id));
        return {
            ...e,
            completedSteps: [...completed],
            currentStepIndex: completed.size,
            status: allDone ? "completed" : e.status,
        };
    });
    if (!enr) {
        res.status(404).json({ error: "Enrollment not found" });
        return;
    }
    res.status(200).json({ success: true, enrollment: enr });
});
/** Execution engine — run due Auto Plan steps across all leads. */
async function executeDueAutoPlanSteps() {
    const plans = (0, autoPlans_js_1.getAutoPlans)();
    const planById = new Map(plans.map((p) => [p.id, p]));
    const leads = await (0, db_js_1.listAllLeads)();
    const now = Date.now();
    let processed = 0;
    let stepsExecuted = 0;
    for (const lead of leads) {
        const enrollments = lead.autoPlanEnrollments || [];
        if (!enrollments.length)
            continue;
        let changed = false;
        const newActivity = [];
        const nextEnrollments = [];
        for (const enr of enrollments) {
            if (enr.status !== "active") {
                nextEnrollments.push(enr);
                continue;
            }
            const plan = planById.get(enr.planId);
            if (!plan || !plan.active) {
                nextEnrollments.push(enr);
                continue;
            }
            processed++;
            const enrolledMs = new Date(enr.enrolledAt).getTime();
            const completed = new Set(enr.completedSteps);
            const first = leadFirstName(lead);
            for (const step of plan.steps) {
                if (completed.has(step.id))
                    continue;
                const dueMs = enrolledMs + step.dayOffset * 24 * 60 * 60 * 1000;
                if (dueMs > now)
                    continue;
                const content = (step.content || "").replace(/\[name\]/g, first);
                const stamp = new Date().toISOString();
                if (step.type === "text") {
                    await sendLeadText(lead.id, content);
                    newActivity.push({ type: "text_sent", description: `Auto Plan text: ${content}`, timestamp: stamp });
                }
                else if (step.type === "email") {
                    const subj = step.subject ? `${step.subject} — ` : "";
                    newActivity.push({
                        type: "email_pending",
                        description: `Auto Plan email (pending): ${subj}${content}`,
                        timestamp: stamp,
                    });
                }
                else {
                    const who = step.assignedTo || "Marco Puga";
                    const dueDate = stamp.slice(0, 10);
                    (0, tasks_js_1.createTask)({
                        title: content.length > 120 ? content.slice(0, 117) + "…" : content,
                        description: `Auto Plan (${plan.name}): ${content}`,
                        type: "follow_up",
                        priority: "normal",
                        status: "pending",
                        dueDate,
                        leadId: lead.id,
                        leadName: lead.name || lead.username || lead.phone || undefined,
                        assignedUserName: who,
                        source: "auto_plan",
                    });
                    newActivity.push({
                        type: "task",
                        description: `Auto Plan task for ${who}: ${content}`,
                        timestamp: stamp,
                    });
                }
                completed.add(step.id);
                stepsExecuted++;
                changed = true;
            }
            const allDone = plan.steps.every((s) => completed.has(s.id));
            nextEnrollments.push({
                ...enr,
                completedSteps: [...completed],
                currentStepIndex: completed.size,
                status: allDone ? "completed" : enr.status,
            });
        }
        if (changed) {
            const mergedActivity = [...(lead.activity || []), ...newActivity];
            await (0, db_js_1.updateLeadCrmFields)({
                leadId: lead.id,
                autoPlanEnrollments: nextEnrollments,
                activity: mergedActivity,
                lastActivity: new Date().toISOString(),
            });
        }
    }
    return { processed, stepsExecuted };
}
app.post("/api/auto-plans/execute-due-steps", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    try {
        const result = await executeDueAutoPlanSteps();
        res.status(200).json(result);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
/* ===================== Tasks ===================== */
const TASK_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const TASK_STATUSES = new Set(types_js_2.CRM_TASK_STATUSES);
const COMMAND_STATUS_SET = new Set(types_js_2.COMMAND_TASK_STATUSES);
const TASK_TYPES = new Set(["call", "text", "email", "appointment", "follow_up", "other"]);
const TASK_SOURCES = new Set(["manual", "auto_plan", "dial_session", "automation"]);
function taskUserCanDelete(req) {
    const userId = String(req.query.userId || req.body?.userId || "").trim();
    if (!userId)
        return true;
    const u = (0, users_js_1.getUserById)(userId);
    return !!u?.permissions?.canDeleteTasks;
}
function normalizeTaskInput(body) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const dueDate = typeof body.dueDate === "string" ? body.dueDate.slice(0, 10) : "";
    if (!title || !dueDate)
        return null;
    const priority = TASK_PRIORITIES.has(body.priority)
        ? body.priority
        : "normal";
    const status = TASK_STATUSES.has(body.status) ? body.status : "pending";
    const type = TASK_TYPES.has(body.type) ? body.type : "other";
    const source = TASK_SOURCES.has(body.source) ? body.source : "manual";
    return {
        title,
        description: typeof body.description === "string" ? body.description : undefined,
        type,
        priority,
        status,
        dueDate,
        dueTime: typeof body.dueTime === "string" ? body.dueTime : undefined,
        leadId: typeof body.leadId === "string" && body.leadId.trim() ? body.leadId.trim() : undefined,
        leadName: typeof body.leadName === "string" ? body.leadName : undefined,
        assignedUserId: typeof body.assignedUserId === "string" ? body.assignedUserId : undefined,
        assignedUserName: typeof body.assignedUserName === "string" ? body.assignedUserName : undefined,
        source,
        reminderMinutes: typeof body.reminderMinutes === "number" ? body.reminderMinutes : undefined,
    };
}
const COMMAND_COLUMNS = new Set([
    "urgent",
    "today",
    "tomorrow",
    "this_week",
    "this_month",
]);
const COMMAND_COLORS = new Set([
    "red",
    "amber",
    "green",
    "blue",
    "purple",
    "gray",
]);
const COMMAND_INTERVALS = new Set([
    "daily",
    "every_3_days",
    "every_5_days",
    "weekly",
    "monthly",
]);
function parseRecurringInterval(raw) {
    return typeof raw === "string" && COMMAND_INTERVALS.has(raw)
        ? raw
        : undefined;
}
function commandTaskCounts() {
    const all = (0, db_js_1.getCommandTasks)();
    const active = all.filter((t) => t.status !== "done");
    return {
        urgent: active.filter((t) => t.column === "urgent").length,
        today: active.filter((t) => t.column === "today").length,
        tomorrow: active.filter((t) => t.column === "tomorrow").length,
        this_week: active.filter((t) => t.column === "this_week").length,
        this_month: active.filter((t) => t.column === "this_month").length,
        total_pending: active.length,
        total_done: all.filter((t) => t.status === "done").length,
    };
}
const COMMAND_STATUS_SORT = {
    overdue: 0,
    due_soon: 1,
    pending: 2,
    on_hold: 3,
    done: 4,
};
/** Carlos command-center task board (db.json). */
app.get("/api/tasks", (req, res) => {
    (0, db_js_1.seedCommandTasksIfEmpty)();
    let tasks = (0, db_js_1.getCommandTasks)();
    const column = typeof req.query.column === "string" ? req.query.column : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const assignedTo = typeof req.query.assignedTo === "string" ? req.query.assignedTo : undefined;
    if (column && COMMAND_COLUMNS.has(column)) {
        tasks = tasks.filter((t) => t.column === column);
    }
    if (status && status !== "both") {
        tasks = tasks.filter((t) => t.status === status);
    }
    if (assignedTo) {
        tasks = tasks.filter((t) => t.assignedTo === assignedTo);
    }
    tasks.sort((a, b) => {
        const sa = COMMAND_STATUS_SORT[a.status] ?? 2;
        const sb = COMMAND_STATUS_SORT[b.status] ?? 2;
        if (sa !== sb)
            return sa - sb;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    res.json({ tasks, counts: commandTaskCounts() });
});
app.post("/api/tasks", express_1.default.json({ limit: "1mb" }), (req, res) => {
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const column = typeof body.column === "string" ? body.column : "";
    if (!title || !column) {
        res.status(400).json({ error: "title and column are required" });
        return;
    }
    if (!COMMAND_COLUMNS.has(column)) {
        res.status(400).json({ error: "Invalid column" });
        return;
    }
    const color = COMMAND_COLORS.has(body.color)
        ? body.color
        : "blue";
    const task = (0, db_js_1.createCommandTask)({
        title,
        description: typeof body.description === "string" ? body.description : undefined,
        column: column,
        status: "pending",
        color,
        recurring: body.recurring === true,
        recurringInterval: parseRecurringInterval(body.recurringInterval),
        assignedTo: typeof body.assignedTo === "string" ? body.assignedTo : "carlos",
        dueDate: typeof body.dueDate === "string" ? body.dueDate.slice(0, 10) : undefined,
        tags: Array.isArray(body.tags)
            ? body.tags.filter((t) => typeof t === "string")
            : undefined,
        createdBy: typeof body.createdBy === "string" ? body.createdBy : "carlos",
    });
    console.log("[Tasks] Created:", task.title, "column:", task.column);
    res.json({ task });
});
app.patch("/api/tasks/:id", express_1.default.json({ limit: "1mb" }), (req, res) => {
    const id = String(req.params.id || "").trim();
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const updates = {};
    if (typeof body.title === "string")
        updates.title = body.title.trim();
    if (typeof body.description === "string")
        updates.description = body.description;
    if (body.column && COMMAND_COLUMNS.has(body.column))
        updates.column = body.column;
    if (body.status && COMMAND_STATUS_SET.has(body.status)) {
        updates.status = body.status;
        updates.previousStatus = undefined;
    }
    if (body.color && COMMAND_COLORS.has(body.color))
        updates.color = body.color;
    if (typeof body.recurring === "boolean")
        updates.recurring = body.recurring;
    const recurringInterval = parseRecurringInterval(body.recurringInterval);
    if (recurringInterval) {
        updates.recurringInterval = recurringInterval;
    }
    if (typeof body.assignedTo === "string")
        updates.assignedTo = body.assignedTo;
    if (typeof body.dueDate === "string")
        updates.dueDate = body.dueDate.slice(0, 10);
    if (Array.isArray(body.tags)) {
        updates.tags = body.tags.filter((t) => typeof t === "string");
    }
    const task = (0, db_js_1.updateCommandTask)(id, updates);
    if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
    }
    console.log("[Tasks] Updated:", task.title, "status:", task.status, "column:", task.column);
    res.json({ task });
});
app.delete("/api/tasks/:id", (req, res) => {
    const id = String(req.params.id || "").trim();
    const deleted = (0, db_js_1.deleteCommandTask)(id);
    if (!deleted) {
        res.status(404).json({ error: "Task not found" });
        return;
    }
    console.log("[Tasks] Deleted:", id);
    res.json({ success: true });
});
/** CRM lead follow-up tasks (tasks.json) — separate from command-center board. */
app.get("/api/crm-tasks", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const assignedUserId = typeof req.query.assignedUserId === "string" ? req.query.assignedUserId : undefined;
    const leadId = typeof req.query.leadId === "string" ? req.query.leadId : undefined;
    const dueDate = typeof req.query.dueDate === "string" ? req.query.dueDate : undefined;
    res.status(200).json({
        tasks: (0, tasks_js_1.filterTasks)({ status, assignedUserId, leadId, dueDate }),
        summary: (0, tasks_js_1.buildTasksSummary)(),
    });
});
app.post("/api/crm-tasks", express_1.default.json({ limit: "1mb" }), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const data = normalizeTaskInput(body);
    if (!data) {
        res.status(400).json({ error: "Missing title or dueDate" });
        return;
    }
    const task = (0, tasks_js_1.createTask)(data);
    res.status(201).json({ task });
});
app.patch("/api/crm-tasks/:id", express_1.default.json({ limit: "1mb" }), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const updates = {};
    if (typeof body.title === "string")
        updates.title = body.title.trim();
    if (typeof body.description === "string")
        updates.description = body.description;
    if (typeof body.dueDate === "string")
        updates.dueDate = body.dueDate.slice(0, 10);
    if (typeof body.dueTime === "string")
        updates.dueTime = body.dueTime;
    if (TASK_PRIORITIES.has(body.priority))
        updates.priority = body.priority;
    if (TASK_STATUSES.has(body.status)) {
        updates.status = body.status;
        updates.previousStatus = undefined;
    }
    if (TASK_TYPES.has(body.type))
        updates.type = body.type;
    if (typeof body.leadId === "string")
        updates.leadId = body.leadId.trim() || undefined;
    if (typeof body.leadName === "string")
        updates.leadName = body.leadName;
    if (typeof body.assignedUserId === "string")
        updates.assignedUserId = body.assignedUserId;
    if (typeof body.assignedUserName === "string")
        updates.assignedUserName = body.assignedUserName;
    if (typeof body.reminderMinutes === "number")
        updates.reminderMinutes = body.reminderMinutes;
    const task = (0, tasks_js_1.updateTask)(id, updates);
    if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
    }
    res.status(200).json({ task });
});
app.delete("/api/crm-tasks/:id", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const existing = (0, tasks_js_1.getTaskById)(id);
    if (!existing) {
        res.status(404).json({ error: "Task not found" });
        return;
    }
    if (!taskUserCanDelete(req)) {
        res.status(403).json({ error: "You do not have permission to delete tasks" });
        return;
    }
    const ok = (0, tasks_js_1.deleteTask)(id);
    res.status(ok ? 200 : 404).json({ success: ok });
});
app.post("/api/crm-tasks/:id/complete", express_1.default.json({ limit: "256kb" }), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const completedBy = typeof body.completedBy === "string" ? body.completedBy : "CRM";
    const task = (0, tasks_js_1.updateTask)(id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        completedBy,
    });
    if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
    }
    res.status(200).json({ task });
});
/* ===================== Deals ===================== */
const DEAL_STATUSES_SET = new Set([
    "prospect",
    "active",
    "under_contract",
    "closed",
    "fallen_through",
]);
const DEAL_TYPES_SET = new Set(["buyer", "seller", "referral", "investor"]);
function parseDealBody(body) {
    const out = {};
    if (typeof body.leadId === "string")
        out.leadId = body.leadId.trim() || undefined;
    if (typeof body.leadName === "string")
        out.leadName = body.leadName.trim();
    if (typeof body.phone === "string")
        out.phone = body.phone;
    if (typeof body.email === "string")
        out.email = body.email;
    if (typeof body.propertyAddress === "string")
        out.propertyAddress = body.propertyAddress.trim();
    if (typeof body.dealType === "string" && DEAL_TYPES_SET.has(body.dealType))
        out.dealType = body.dealType;
    if (typeof body.status === "string" && DEAL_STATUSES_SET.has(body.status))
        out.status = body.status;
    if (typeof body.salePrice === "number")
        out.salePrice = body.salePrice;
    else if (typeof body.salePrice === "string" && body.salePrice.trim()) {
        const n = Number(String(body.salePrice).replace(/,/g, ""));
        if (Number.isFinite(n))
            out.salePrice = n;
    }
    if (typeof body.commissionPercent === "number")
        out.commissionPercent = body.commissionPercent;
    if (typeof body.closeDate === "string")
        out.closeDate = body.closeDate;
    if (typeof body.openedDate === "string")
        out.openedDate = body.openedDate;
    if (typeof body.closedDate === "string")
        out.closedDate = body.closedDate;
    if (typeof body.assignedTo === "string")
        out.assignedTo = body.assignedTo;
    if (typeof body.notes === "string")
        out.notes = body.notes;
    if (body.documents !== undefined)
        out.documents = body.documents;
    return out;
}
app.get("/api/deals", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.status(200).json({ deals: (0, deals_js_1.getDeals)() });
});
app.get("/api/deals/by-lead/:leadId", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leadId = String(req.params.leadId || "").trim();
    res.status(200).json({ deals: (0, deals_js_1.getDealsByLeadId)(leadId) });
});
app.get("/api/deals/:id", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const deal = (0, deals_js_1.getDealById)(String(req.params.id || "").trim());
    if (!deal) {
        res.status(404).json({ error: "Deal not found" });
        return;
    }
    res.status(200).json({ deal });
});
app.post("/api/deals", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const parsed = parseDealBody(body);
    if (!parsed.leadName || !parsed.propertyAddress) {
        res.status(400).json({ error: "leadName and propertyAddress required" });
        return;
    }
    const commissionPercent = parsed.commissionPercent ?? 3;
    const salePrice = parsed.salePrice;
    const deal = (0, deals_js_1.createDeal)({
        leadId: parsed.leadId,
        leadName: parsed.leadName,
        phone: parsed.phone,
        email: parsed.email,
        propertyAddress: parsed.propertyAddress,
        dealType: parsed.dealType ?? "buyer",
        status: parsed.status ?? "prospect",
        salePrice,
        commissionPercent,
        estimatedGCI: salePrice !== undefined ? (0, deals_js_1.calculateGCI)(salePrice, commissionPercent) : undefined,
        closeDate: parsed.closeDate,
        openedDate: parsed.openedDate ?? new Date().toISOString(),
        closedDate: parsed.closedDate,
        assignedTo: parsed.assignedTo,
        notes: parsed.notes,
        documents: parsed.documents,
    });
    res.status(201).json({ deal });
});
app.patch("/api/deals/:id", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const updated = (0, deals_js_1.updateDeal)(id, parseDealBody(body));
    if (!updated) {
        res.status(404).json({ error: "Deal not found" });
        return;
    }
    res.status(200).json({ deal: updated });
});
app.delete("/api/deals/:id", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const ok = (0, deals_js_1.deleteDeal)(String(req.params.id || "").trim());
    if (!ok) {
        res.status(404).json({ error: "Deal not found" });
        return;
    }
    res.status(200).json({ ok: true });
});
/* ===================== Transactions (SQLite) ===================== */
function parseTransactionBody(body) {
    const out = {};
    if (typeof body.address === "string")
        out.address = body.address.trim();
    if (typeof body.dealType === "string")
        out.dealType = body.dealType;
    if (body.parties && typeof body.parties === "object" && !Array.isArray(body.parties)) {
        out.parties = body.parties;
    }
    if (typeof body.price === "number")
        out.price = body.price;
    if (typeof body.status === "string")
        out.status = body.status;
    if (typeof body.contractDate === "string")
        out.contractDate = body.contractDate;
    if (typeof body.inspectionDate === "string")
        out.inspectionDate = body.inspectionDate;
    if (typeof body.appraisalDate === "string")
        out.appraisalDate = body.appraisalDate;
    if (typeof body.loanCommitmentDate === "string")
        out.loanCommitmentDate = body.loanCommitmentDate;
    if (typeof body.titleDate === "string")
        out.titleDate = body.titleDate;
    if (typeof body.closingDate === "string")
        out.closingDate = body.closingDate;
    if (typeof body.possessionDate === "string")
        out.possessionDate = body.possessionDate;
    if (typeof body.leadId === "string")
        out.leadId = body.leadId.trim() || undefined;
    if (typeof body.dealFileUrl === "string")
        out.dealFileUrl = body.dealFileUrl;
    if (typeof body.notes === "string")
        out.notes = body.notes;
    return out;
}
app.get("/api/transactions", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.json({ transactions: (0, transactionsStore_js_1.getAllTransactions)(status) });
});
app.post("/api/transactions", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const parsed = parseTransactionBody(body);
    const address = parsed.address || "";
    const dealType = parsed.dealType || "buyer";
    const status = parsed.status || "active";
    if (!address) {
        res.status(400).json({ error: "address required" });
        return;
    }
    const tx = (0, transactionsStore_js_1.createTransaction)({
        address,
        dealType,
        parties: parsed.parties || {},
        price: parsed.price,
        status,
        contractDate: parsed.contractDate,
        inspectionDate: parsed.inspectionDate,
        appraisalDate: parsed.appraisalDate,
        loanCommitmentDate: parsed.loanCommitmentDate,
        titleDate: parsed.titleDate,
        closingDate: parsed.closingDate,
        possessionDate: parsed.possessionDate,
        leadId: parsed.leadId,
        dealFileUrl: parsed.dealFileUrl,
        notes: parsed.notes,
    });
    res.status(201).json({ transaction: tx });
});
app.get("/api/transactions/:id", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const tx = (0, transactionsStore_js_1.getTransaction)(id);
    if (!tx) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    res.json({
        transaction: tx,
        deadlines: (0, transactionsStore_js_1.getDeadlinesForDeal)(id),
        documents: (0, transactionsStore_js_1.getDocumentsForDeal)(id),
    });
});
app.patch("/api/transactions/:id", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const tx = (0, transactionsStore_js_1.updateTransaction)(id, parseTransactionBody(body));
    if (!tx) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    if (body.status === "closed" || tx.status === "closed") {
        void (0, index_js_16.tryRecordCommissionForClosedDeal)(tx);
    }
    res.json({ transaction: tx });
});
app.delete("/api/transactions/:id", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const success = (0, transactionsStore_js_1.deleteTransaction)(String(req.params.id || "").trim());
    res.json({ success });
});
app.post("/api/transactions/migrate-from-deals", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const deals = (0, deals_js_1.readLegacyDealsJson)();
    if (!deals.length) {
        res.json({ migrated: 0, skipped: 0, message: "No deals.json found or empty" });
        return;
    }
    const result = (0, transactionsStore_js_1.migrateFromDealsJson)(deals);
    res.json(result);
});
app.post("/api/transactions/:id/open-deal", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const tx = (0, transactionsStore_js_1.getTransaction)(id);
    if (!tx) {
        res.status(404).json({ error: "Transaction not found" });
        return;
    }
    const updated = (0, transactionsStore_js_1.updateTransaction)(id, {
        status: tx.status === "active" ? "under_contract" : tx.status,
    }) ?? tx;
    const deadlines = (0, transactionsStore_js_1.generateFullDeadlineTimeline)(updated);
    const standardDocTypes = updated.dealType === "seller" || updated.dealType === "dual"
        ? ["listing_agreement", "disclosure", "offer"]
        : ["buyer_rep", "offer", "disclosure"];
    const existingDocs = (0, transactionsStore_js_1.getDocumentsForDeal)(id);
    const existingDocTypes = new Set(existingDocs.map((d) => d.documentType));
    const documentsCreated = [];
    for (const docType of standardDocTypes) {
        if (existingDocTypes.has(docType))
            continue;
        const doc = (0, transactionsStore_js_1.createDocument)({ dealId: id, documentType: docType, status: "pending", parties: [] });
        documentsCreated.push(doc);
    }
    console.log("[Transactions] Deal opened:", updated.address, "-", deadlines.length, "new deadlines,", documentsCreated.length, "documents");
    res.json({
        transaction: updated,
        timeline: (0, transactionsStore_js_1.getDeadlinesForDeal)(id),
        documents: (0, transactionsStore_js_1.getDocumentsForDeal)(id),
    });
});
app.post("/api/transactions/:id/inspection/schedule", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const tx = (0, transactionsStore_js_1.getTransaction)(id);
    if (!tx) {
        res.status(404).json({ error: "Transaction not found" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const inspectorName = typeof body.inspectorName === "string" ? body.inspectorName.trim() : undefined;
    const inspectorPhone = typeof body.inspectorPhone === "string" ? body.inspectorPhone.trim() : undefined;
    const scheduledAt = typeof body.scheduledAt === "string" ? body.scheduledAt.trim() : "";
    if (!scheduledAt) {
        res.status(400).json({ error: "scheduledAt required" });
        return;
    }
    const inspectionFlow = {
        ...tx.inspectionFlow,
        inspectorName,
        inspectorPhone,
        scheduledAt,
        scheduleConfirmedParties: [],
    };
    (0, transactionsStore_js_1.updateTransaction)(id, { inspectionFlow });
    const scheduledTimeStr = new Date(scheduledAt).toLocaleString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Chicago",
    });
    const contacts = [
        { role: "buyer", phone: tx.parties.buyerPhone },
        { role: "seller", phone: tx.parties.sellerPhone },
        { role: "buyer_agent", phone: tx.parties.buyerAgentPhone },
        { role: "seller_agent", phone: tx.parties.sellerAgentPhone },
        { role: "inspector", phone: inspectorPhone },
    ];
    let notified = 0;
    for (const contact of contacts) {
        if (!contact.phone?.trim())
            continue;
        const message = `Inspection scheduled for ${tx.address} on ${scheduledTimeStr}. Reply YES to confirm.`;
        const result = await (0, index_js_18.sendTwilioMessage)(contact.phone, message);
        if (result.success)
            notified++;
    }
    console.log("[InspectionFlow] Scheduled for", tx.address, "- notified", notified, "parties");
    res.json({ transaction: (0, transactionsStore_js_1.getTransaction)(id), notified });
});
app.post("/api/transactions/:id/inspection/report-received", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const tx = (0, transactionsStore_js_1.getTransaction)(id);
    if (!tx) {
        res.status(404).json({ error: "Transaction not found" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const reportSummary = typeof body.reportSummary === "string" ? body.reportSummary : undefined;
    const requestedRepairs = Array.isArray(body.requestedRepairs)
        ? body.requestedRepairs
        : undefined;
    const now = new Date().toISOString();
    const optionDeadline = (0, transactionsStore_js_1.getDeadlinesForDeal)(id).find((d) => d.deadlineType === "option_period");
    const sellerResponseDeadline = optionDeadline?.dueDate || new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const inspectionFlow = {
        ...tx.inspectionFlow,
        reportReceivedAt: now,
        repairRequestDraftedAt: now,
        sellerResponseDeadline,
        sellerResponseStatus: "pending",
    };
    (0, transactionsStore_js_1.updateTransaction)(id, { inspectionFlow });
    (0, transactionsStore_js_1.createDeadline)({
        dealId: id,
        deadlineType: "custom",
        label: "Seller Response to Repair Request",
        dueDate: sellerResponseDeadline,
    });
    console.log("[InspectionFlow] Report received, repair request drafted for", tx.address, "- seller response due", sellerResponseDeadline);
    res.json({
        transaction: (0, transactionsStore_js_1.getTransaction)(id),
        draftedRepairRequest: {
            summary: reportSummary,
            requestedRepairs: requestedRepairs || [],
            sellerResponseDeadline,
            note: "Repair request DRAFTED — Marco must review and send manually. This system does not auto-send repair requests.",
        },
    });
});
app.post("/api/transactions/:id/inspection/repair-request-sent", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const tx = (0, transactionsStore_js_1.getTransaction)(id);
    if (!tx) {
        res.status(404).json({ error: "Transaction not found" });
        return;
    }
    (0, transactionsStore_js_1.updateTransaction)(id, {
        inspectionFlow: { ...tx.inspectionFlow, repairRequestSentAt: new Date().toISOString() },
    });
    res.json({ transaction: (0, transactionsStore_js_1.getTransaction)(id) });
});
app.post("/api/transactions/:id/final-week/walkthrough", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const tx = (0, transactionsStore_js_1.getTransaction)(id);
    if (!tx) {
        res.status(404).json({ error: "Transaction not found" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const scheduledAt = typeof body.scheduledAt === "string" ? body.scheduledAt.trim() : "";
    if (!scheduledAt) {
        res.status(400).json({ error: "scheduledAt required" });
        return;
    }
    const finalWeekFlow = {
        ...tx.finalWeekFlow,
        walkthroughScheduledAt: scheduledAt,
    };
    (0, transactionsStore_js_1.updateTransaction)(id, { finalWeekFlow });
    const timeStr = new Date(scheduledAt).toLocaleString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Chicago",
    });
    if (tx.parties.buyerPhone) {
        await (0, index_js_18.sendTwilioMessage)(tx.parties.buyerPhone, `Final walkthrough for ${tx.address} scheduled for ${timeStr}. Reply YES to confirm.`);
    }
    res.json({ transaction: (0, transactionsStore_js_1.getTransaction)(id) });
});
app.post("/api/transactions/:id/final-week/wire-confirmed", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = String(req.params.id || "").trim();
    const tx = (0, transactionsStore_js_1.getTransaction)(id);
    if (!tx) {
        res.status(404).json({ error: "Transaction not found" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const confirmedBy = typeof body.confirmedBy === "string" ? body.confirmedBy : "manual";
    const finalWeekFlow = {
        ...tx.finalWeekFlow,
        wireInstructionsConfirmedAt: new Date().toISOString(),
        wireInstructionsConfirmedBy: confirmedBy,
    };
    (0, transactionsStore_js_1.updateTransaction)(id, { finalWeekFlow });
    res.json({ transaction: (0, transactionsStore_js_1.getTransaction)(id) });
});
const templateUpload = (0, multer_1.default)({
    dest: (0, transactionsStore_js_1.resolveTemplatesDir)(),
    limits: { fileSize: 20 * 1024 * 1024 },
});
app.post("/api/templates/upload", templateUpload.single("file"), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const templateType = typeof body.templateType === "string" ? body.templateType.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
    }
    if (!templateType || !name) {
        res.status(400).json({ error: "templateType and name required" });
        return;
    }
    let fieldMapping = {};
    if (typeof body.fieldMapping === "string" && body.fieldMapping.trim()) {
        try {
            fieldMapping = JSON.parse(body.fieldMapping);
        }
        catch {
            res.status(400).json({ error: "fieldMapping must be valid JSON" });
            return;
        }
    }
    const finalPath = path_1.default.join((0, transactionsStore_js_1.resolveTemplatesDir)(), `${req.file.filename}-${req.file.originalname}`);
    fs_1.default.renameSync(req.file.path, finalPath);
    const template = (0, transactionsStore_js_1.createDocumentTemplate)({
        templateType: templateType,
        name,
        filePath: finalPath,
        fieldMapping,
    });
    console.log("[Templates] Uploaded:", template.name, "(", template.templateType, ")");
    res.json({ template });
});
app.get("/api/templates", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    res.json({ templates: (0, transactionsStore_js_1.getAllTemplates)(type) });
});
app.get("/api/templates/:id/fields", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const template = (0, transactionsStore_js_1.getTemplate)(String(req.params.id || "").trim());
    if (!template) {
        res.status(404).json({ error: "Template not found" });
        return;
    }
    try {
        const fields = await (0, documentFill_js_1.inspectTemplatePdfFields)(template.filePath);
        res.json({ fields });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({
            error: `Could not read PDF fields: ${msg}`,
            note: "Form may not have fillable AcroForm fields (scanned/flattened PDF) — manual mapping may not be possible.",
        });
    }
});
app.post("/api/transactions/:id/deadlines", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const dealId = String(req.params.id || "").trim();
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const deadlineType = typeof body.deadlineType === "string" ? body.deadlineType : "";
    const dueDate = typeof body.dueDate === "string" ? body.dueDate : "";
    if (!deadlineType || !dueDate) {
        res.status(400).json({ error: "deadlineType and dueDate required" });
        return;
    }
    const deadline = (0, transactionsStore_js_1.createDeadline)({
        dealId,
        deadlineType: deadlineType,
        label: typeof body.label === "string" ? body.label : undefined,
        dueDate,
    });
    res.json({ deadline });
});
app.post("/api/deadlines/:id/complete", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    (0, transactionsStore_js_1.markDeadlineCompleted)(String(req.params.id || "").trim());
    res.json({ success: true });
});
app.get("/api/deadlines/upcoming", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const days = parseInt(String(req.query.days || "7"), 10) || 7;
    res.json({ deadlines: (0, transactionsStore_js_1.getUpcomingDeadlines)(days) });
});
app.get("/api/deadlines/overdue", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json({ deadlines: (0, transactionsStore_js_1.getOverdueDeadlines)() });
});
app.post("/api/deadlines/check-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, index_js_14.checkTransactionDeadlines)();
    res.json(result);
});
app.post("/api/deadlines/daily-check-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, index_js_14.runDailyTransactionWorkflowChecks)();
    res.json(result);
});
app.post("/api/deadlines/close-day-check-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, postCloseFlow_js_1.checkCloseDayTriggers)();
    res.json(result);
});
app.post("/api/deadlines/check-ins-check-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, postCloseFlow_js_1.checkScheduledClientCheckIns)();
    res.json(result);
});
app.post("/api/deadlines/missed-check-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, index_js_14.checkMissedSameDayDeadlines)();
    res.json(result);
});
/* ===================== Lead scoring & nurture ===================== */
app.post("/api/lead-scoring/score-all", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, index_js_15.scoreAllLeads)();
    res.json(result);
});
app.post("/api/lead-scoring/score/:leadId", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const lead = await (0, db_js_1.getLeadById)(String(req.params.leadId || "").trim());
    if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
    }
    const result = (0, index_js_15.scoreAndRecordLead)(lead);
    res.json(result);
});
app.get("/api/lead-scoring/:leadId", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leadId = String(req.params.leadId || "").trim();
    res.json({
        latest: (0, leadScoreStore_js_1.getLatestScore)(leadId),
        history: (0, leadScoreStore_js_1.getScoreHistory)(leadId),
    });
});
app.get("/api/lead-scoring/tier/:tier", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const tier = String(req.params.tier || "").trim();
    if (tier !== "hot" && tier !== "warm" && tier !== "cold") {
        res.status(400).json({ error: "tier must be hot, warm, or cold" });
        return;
    }
    res.json({ leads: (0, leadScoreStore_js_1.getLeadsByTier)(tier) });
});
app.post("/api/lead-scoring/rescore-cold-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, index_js_15.scoreColdLeads)();
    res.json(result);
});
app.post("/api/lead-nurture/warm-touch-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, warmLeadFlow_js_1.runWarmLeadWeeklyTouch)();
    res.json(result);
});
app.post("/api/lead-nurture/cold-touch-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, coldLeadFlow_js_1.runColdLeadMonthlyTouch)();
    res.json(result);
});
app.post("/api/lead-nurture/route/:leadId", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const lead = await (0, db_js_1.getLeadById)(String(req.params.leadId || "").trim());
    if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
    }
    await (0, sourceRouting_js_1.routeNewLead)(lead);
    res.json({ success: true });
});
app.get("/api/lead-nurture/summary", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const hot = (0, leadScoreStore_js_1.getLeadsByTier)("hot").sort((a, b) => b.score - a.score);
    const warm = (0, leadScoreStore_js_1.getLeadsByTier)("warm");
    const cold = (0, leadScoreStore_js_1.getLeadsByTier)("cold");
    const all = await (0, db_js_1.listAllLeads)();
    const leadMap = new Map(all.map((l) => [l.id, l]));
    const scoredIds = new Set([...hot, ...warm, ...cold].map((s) => s.leadId));
    const unscored = all.length - scoredIds.size;
    const sinceIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const recentScoreChanges = (0, leadScoreStore_js_1.getScoreEntriesSince)(sinceIso)
        .filter((s) => s.previousScore != null && s.score !== s.previousScore)
        .sort((a, b) => new Date(b.scoreDate).getTime() - new Date(a.scoreDate).getTime())
        .slice(0, 12)
        .map((s) => {
        const lead = leadMap.get(s.leadId);
        return {
            leadId: s.leadId,
            name: lead?.name || lead?.username || "Unknown",
            score: s.score,
            previousScore: s.previousScore,
            delta: s.score - (s.previousScore ?? 0),
            tier: s.tier,
            scoreDate: s.scoreDate,
        };
    });
    const top = hot[0];
    const topLead = top ? leadMap.get(top.leadId) : undefined;
    const topHotLead = top
        ? {
            ...top,
            name: topLead?.name || topLead?.username || "Unknown",
            phone: topLead?.phone || null,
        }
        : null;
    res.json({
        hotCount: hot.length,
        warmCount: warm.length,
        coldCount: cold.length,
        unscoredCount: Math.max(0, unscored),
        totalLeads: all.length,
        topHotLead,
        recentScoreChanges,
    });
});
app.get("/api/lead-nurture/tier-detail/:tier", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const tier = req.params.tier;
    if (!["hot", "warm", "cold"].includes(tier)) {
        res.status(400).json({ error: "Invalid tier — must be hot, warm, or cold" });
        return;
    }
    const scoreEntries = (0, leadScoreStore_js_1.getLeadsByTier)(tier);
    const leads = await (0, db_js_1.listAllLeads)();
    const leadMap = new Map(leads.map((l) => [l.id, l]));
    const enriched = scoreEntries
        .map((s) => {
        const lead = leadMap.get(s.leadId);
        const inboundReplyCount = (0, smsStore_js_1.getInboundMessageCount)(s.leadId);
        const propertyViewsCount = typeof lead?.propertyViewsCount === "number" && lead.propertyViewsCount > 0
            ? lead.propertyViewsCount
            : (lead?.activity ?? []).filter((a) => ["home_clicked", "home_hearted", "web_visit"].includes(a.type)).length;
        return {
            leadId: s.leadId,
            score: s.score,
            previousScore: s.previousScore,
            scoreDate: s.scoreDate,
            scoringFactors: s.scoringFactors,
            factorMax: { timeline: 25, preApproval: 25, responseCount: 20, propertyViews: 15, showingRequests: 15 },
            tier: s.tier,
            name: lead?.name || lead?.username || "Unknown",
            phone: lead?.phone || null,
            email: lead?.email || null,
            source: lead?.source || null,
            crmIntent: lead?.crmIntent || null,
            preApprovalStatus: lead?.preApprovalStatus || null,
            timeline: lead?.criteria?.timeline || null,
            inboundReplyCount,
            propertyViewsCount,
            automationPaused: lead?.automationPaused || false,
            sourceRoutingCompletedAt: lead?.sourceRoutingCompletedAt || null,
            showingAppointment: lead?.showingAppointment || null,
        };
    })
        .sort((a, b) => b.score - a.score);
    res.json({ tier, count: enriched.length, leads: enriched });
});
app.get("/api/lead-nurture/recently-routed", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leads = await (0, db_js_1.listAllLeads)();
    const norm = (s) => (s ?? "").trim().toLowerCase();
    const sourceActivity = {
        mojo: leads.some((l) => norm(l.source) === "mojo"),
        social: leads.some((l) => ["instagram", "tiktok"].includes(norm(l.source))),
        web_form: leads.some((l) => norm(l.source) === "web_form"),
        referral: leads.some((l) => norm(l.source) === "referral"),
    };
    const routed = leads
        .filter((l) => l.sourceRoutingCompletedAt)
        .sort((a, b) => new Date(b.sourceRoutingCompletedAt).getTime() -
        new Date(a.sourceRoutingCompletedAt).getTime())
        .slice(0, 20)
        .map((l) => ({
        leadId: l.id,
        name: l.name || l.username || "Unknown",
        source: l.source,
        phone: l.phone,
        routedAt: l.sourceRoutingCompletedAt,
    }));
    res.json({ routed, sourceActivity });
});
/* ===================== Reporting (Harvey digest / KPI) ===================== */
app.post("/api/reporting/digest-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, dailyDigest_js_1.runDailyDigest)();
    await (0, dailyDigest_js_1.deliverDigest)(result.snapshotId);
    res.json(result);
});
app.post("/api/reporting/weekly-kpi-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, weeklyKPI_js_1.runWeeklyKPI)();
    res.json(result);
});
app.get("/api/reporting/latest-digest", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json({ snapshot: (0, reportingStore_js_1.getLatestSnapshot)("daily_digest") });
});
app.get("/api/reporting/latest-kpi", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json({ snapshot: (0, reportingStore_js_1.getLatestSnapshot)("weekly_kpi") });
});
app.get("/api/reporting/anomalies", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const snapshot = (0, reportingStore_js_1.getLatestSnapshot)("daily_digest");
    res.json({ anomalies: snapshot?.anomalies || [], generatedAt: snapshot?.generatedAt || null });
});
app.get("/api/reporting/digest-history", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const limit = parseInt(String(req.query.limit || "14"), 10) || 14;
    const snapshots = (0, reportingStore_js_1.getSnapshotsByType)("daily_digest", limit);
    res.json({
        snapshots: snapshots.map((s) => ({
            snapshotDate: s.snapshotDate,
            generatedAt: s.generatedAt,
            data: s.data,
            anomalyCount: (s.anomalies || []).length,
            deliveredSms: s.deliveredSms,
            deliveredHarvey: s.deliveredHarvey,
        })),
    });
});
app.get("/api/reporting/kpi-history", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const limit = parseInt(String(req.query.limit || "8"), 10) || 8;
    const snapshots = (0, reportingStore_js_1.getSnapshotsByType)("weekly_kpi", limit);
    res.json({
        snapshots: snapshots.map((s) => ({
            snapshotDate: s.snapshotDate,
            generatedAt: s.generatedAt,
            data: s.data,
        })),
    });
});
/* ===================== Finance (GCI / expenses / pace) ===================== */
app.get("/api/finance/commissions", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    res.json({ commissions: (0, financeStore_js_1.getAllCommissions)(since) });
});
app.post("/api/finance/commissions", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const salePrice = Number(body.salePrice);
    const address = typeof body.address === "string" ? body.address.trim() : "";
    if (!address || !Number.isFinite(salePrice) || salePrice <= 0) {
        res.status(400).json({ error: "address and salePrice are required" });
        return;
    }
    const commission = (0, financeStore_js_1.createCommission)({
        dealId: typeof body.dealId === "string" ? body.dealId : undefined,
        address,
        salePrice,
        grossCommissionPct: body.grossCommissionPct != null ? Number(body.grossCommissionPct) : undefined,
        dealType: (body.dealType === "seller" ? "seller" : "buyer"),
        leadSource: typeof body.leadSource === "string" ? body.leadSource : undefined,
        leadId: typeof body.leadId === "string" ? body.leadId : undefined,
        closedAt: typeof body.closedAt === "string"
            ? body.closedAt
            : new Date().toISOString().split("T")[0],
        brokerageSplitPct: body.brokerageSplitPct != null ? Number(body.brokerageSplitPct) : undefined,
    });
    res.json({ commission });
});
app.get("/api/finance/expenses", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    res.json({ expenses: (0, financeStore_js_1.getAllExpenses)(since) });
});
app.post("/api/finance/expenses", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const amount = Number(body.amount);
    const category = typeof body.category === "string" ? body.category : "";
    const validCategories = [
        "marketing",
        "lead_gen",
        "tools_subscriptions",
        "transaction_costs",
        "other",
    ];
    if (!validCategories.includes(category) || !Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: "category and positive amount are required" });
        return;
    }
    const expense = (0, financeStore_js_1.createExpense)({
        category: category,
        subcategory: typeof body.subcategory === "string" ? body.subcategory : undefined,
        vendor: typeof body.vendor === "string" ? body.vendor : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        amount,
        dealId: typeof body.dealId === "string" ? body.dealId : undefined,
        leadSource: typeof body.leadSource === "string" ? body.leadSource : undefined,
        expenseDate: typeof body.expenseDate === "string"
            ? body.expenseDate
            : new Date().toISOString().split("T")[0],
    });
    res.json({ expense });
});
app.get("/api/finance/gci", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json((0, financeStore_js_1.getGCISummary)());
});
app.get("/api/finance/expense-summary", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json(await (0, financeStore_js_1.getExpenseSummary)());
});
app.get("/api/finance/projection", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json((0, financeStore_js_1.generatePipelineProjection)());
});
app.get("/api/finance/pace-status", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json((0, index_js_16.getCurrentPaceStatus)());
});
app.get("/api/voice-clone/health", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const health = await (0, index_js_26.checkVoxCpmHealth)();
    res.json({
        configured: !!process.env.VOXCPM_API_URL?.trim(),
        apiUrl: process.env.VOXCPM_API_URL?.trim() || null,
        service: health,
    });
});
app.get("/api/voice-clone/stats", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const all = (0, voiceCloneStore_js_1.getAllRequests)(500);
    res.json({
        total: all.length,
        pendingApproval: (0, voiceCloneStore_js_1.countPendingApprovalRequests)(),
        generating: all.filter((r) => r.generationStatus === "generating").length,
        complete: all.filter((r) => r.generationStatus === "complete").length,
    });
});
app.post("/api/voice-clone/requests", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const { script, deliveryStyle, formatType, hookVariationCount, customStyleDescription, voxcpmMode } = req.body ?? {};
    if (!script || !deliveryStyle || !formatType) {
        res.status(400).json({ error: "script, deliveryStyle, and formatType required" });
        return;
    }
    const safetyCheck = (0, safetyLock_js_1.checkScriptSafety)(script, "pre-check", "manual");
    if (!safetyCheck.allowed) {
        res.status(400).json({ error: `Script blocked: ${safetyCheck.reason}` });
        return;
    }
    const request = (0, voiceCloneStore_js_1.createVoiceoverRequest)({
        script,
        deliveryStyle,
        formatType,
        hookVariationCount: hookVariationCount || 1,
        customStyleDescription,
        voxcpmMode,
        requestedBy: "manual",
    });
    res.json({ request: enrichVoiceoverRequest(request) });
});
app.get("/api/voice-clone/requests", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const limit = parseInt(String(req.query.limit || "50"), 10) || 50;
    const requests = (0, voiceCloneStore_js_1.getAllRequests)(limit).map((r) => enrichVoiceoverRequest(r));
    res.json({ requests });
});
app.get("/api/voice-clone/requests/pending", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const requests = (0, voiceCloneStore_js_1.getPendingApprovalRequests)().map((r) => enrichVoiceoverRequest(r));
    res.json({ requests });
});
app.get("/api/voice-clone/requests/:id", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const request = enrichVoiceoverRequest((0, voiceCloneStore_js_1.getVoiceoverRequest)(req.params.id));
    if (!request) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    res.json({ request });
});
app.post("/api/voice-clone/requests/:id/approve", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const request = (0, voiceCloneStore_js_1.getVoiceoverRequest)(req.params.id);
    if (!request) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    if (request.approvalStatus !== "pending") {
        res.status(400).json({ error: "Request is not in pending state" });
        return;
    }
    const safetyCheck = (0, safetyLock_js_1.checkScriptSafety)(request.script, request.id, "approval");
    if (!safetyCheck.allowed) {
        (0, voiceCloneStore_js_1.updateVoiceoverRequest)(request.id, {
            approvalStatus: "blocked",
            generationStatus: "failed",
            error: safetyCheck.reason,
        });
        res.status(400).json({ error: `Blocked at approval: ${safetyCheck.reason}` });
        return;
    }
    (0, voiceCloneStore_js_1.updateVoiceoverRequest)(request.id, {
        approvalStatus: "approved",
        approvedBy: "marco",
        approvedAt: new Date().toISOString(),
        generationStatus: "queued",
    });
    res.json({ success: true });
});
app.post("/api/voice-clone/requests/:id/reject", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const { reason } = req.body ?? {};
    (0, voiceCloneStore_js_1.updateVoiceoverRequest)(req.params.id, {
        approvalStatus: "rejected",
        rejectionReason: reason || "Rejected",
        generationStatus: "failed",
    });
    res.json({ success: true });
});
app.get("/api/voice-clone/reference-clips", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    res.json({ clips: (0, voiceCloneStore_js_1.getAllReferenceClips)(), primary: (0, voiceCloneStore_js_1.getPrimaryReferenceClip)() });
});
app.post("/api/voice-clone/reference-clips", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const { sourceUrl, localAudioPath, qualityRating, transcript } = req.body ?? {};
    if (!sourceUrl) {
        res.status(400).json({ error: "sourceUrl required" });
        return;
    }
    const clip = (0, voiceCloneStore_js_1.createReferenceClip)({
        sourceUrl,
        localAudioPath,
        qualityRating,
        transcript,
        isPrimary: false,
    });
    res.json({ clip });
});
app.post("/api/voice-clone/reference-clips/:id/set-primary", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    (0, voiceCloneStore_js_1.setPrimaryReferenceClip)(req.params.id);
    res.json({ success: true });
});
app.get("/api/voice-clone/safety-log", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const limit = parseInt(String(req.query.limit || "100"), 10) || 100;
    res.json({ entries: (0, voiceCloneStore_js_1.getSafetyLogEntries)(limit) });
});
app.post("/api/finance/sync", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const commissions = await (0, index_js_16.syncCommissionsFromClosedTransactions)();
    const projection = (0, financeStore_js_1.generatePipelineProjection)();
    res.json({
        commissions,
        pipelineDeals: projection.dealCount,
        projectionWeightedGCI: projection.totalWeightedGCI,
        syncedAt: new Date().toISOString(),
    });
});
app.get("/api/finance/alerts", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const limit = parseInt(String(req.query.limit || "30"), 10) || 30;
    res.json({ alerts: (0, financeStore_js_1.getFinanceAlerts)(limit) });
});
app.post("/api/finance/alerts/:id/acknowledge", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const id = parseInt(String(req.params.id), 10);
    if (!id) {
        res.status(400).json({ error: "Invalid alert id" });
        return;
    }
    (0, financeStore_js_1.acknowledgeFinanceAlert)(id);
    res.json({ success: true });
});
app.get("/api/finance/weekly-summary-preview", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json(await (0, index_js_16.buildWeeklyFinanceSummaryData)());
});
app.get("/api/finance/monthly-report-preview", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json(await (0, index_js_16.buildMonthlyCloseReportData)());
});
app.post("/api/finance/weekly-summary-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, index_js_16.runWeeklyFinanceSummary)();
    res.json(result);
});
app.post("/api/finance/monthly-report-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, index_js_16.runMonthlyCloseReport)();
    res.json(result);
});
app.post("/api/finance/pace-check-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, index_js_16.runPaceCheck)();
    res.json(result);
});
app.post("/api/finance/expense-spike-check-now", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const result = await (0, index_js_16.runExpenseSpikeCheck)();
    res.json(result);
});
app.post("/api/transactions/:id/documents", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const dealId = String(req.params.id || "").trim();
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const documentType = typeof body.documentType === "string" ? body.documentType : "other";
    const status = typeof body.status === "string" ? body.status : "pending";
    const doc = (0, transactionsStore_js_1.createDocument)({
        dealId,
        documentType: documentType,
        status: status,
        parties: Array.isArray(body.parties) ? body.parties : undefined,
        signedAt: typeof body.signedAt === "string" ? body.signedAt : undefined,
        sentAt: typeof body.sentAt === "string" ? body.sentAt : undefined,
        documentUrl: typeof body.documentUrl === "string" ? body.documentUrl : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
    });
    res.json({ document: doc });
});
app.patch("/api/documents/:id", express_1.default.json(), (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const status = typeof body.status === "string" ? body.status : "pending";
    (0, transactionsStore_js_1.updateDocumentStatus)(String(req.params.id || "").trim(), status, typeof body.signedAt === "string" ? body.signedAt : undefined);
    res.json({ success: true });
});
app.get("/api/documents/unsigned", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json({ documents: (0, transactionsStore_js_1.getUnsignedDocuments)() });
});
app.get("/api/documents/needs-review", (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.json({ documents: (0, transactionsStore_js_1.getDocumentsNeedingReview)() });
});
app.post("/api/transactions/:id/documents/:docId/auto-fill", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const txId = String(req.params.id || "").trim();
    const docId = String(req.params.docId || "").trim();
    const tx = (0, transactionsStore_js_1.getTransaction)(txId);
    if (!tx) {
        res.status(404).json({ error: "Transaction not found" });
        return;
    }
    const doc = (0, transactionsStore_js_1.getDocument)(docId);
    if (!doc || doc.dealId !== txId) {
        res.status(404).json({ error: "Document not found" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const templateId = typeof body.templateId === "string" ? body.templateId.trim() : "";
    const template = (0, transactionsStore_js_1.getTemplate)(templateId);
    if (!template) {
        res.status(404).json({ error: "Template not found" });
        return;
    }
    const result = await (0, documentFill_js_1.fillDocumentTemplate)(template, tx);
    if (!result.success) {
        res.status(500).json({ error: result.error });
        return;
    }
    const needsReview = result.missingFields.length > 0;
    (0, transactionsStore_js_1.flagDocumentForReview)(docId, result.outputPath, result.missingFields);
    res.json({
        documentUrl: result.outputPath,
        filledFields: result.filledFields,
        missingFields: result.missingFields,
        needsReview,
        message: needsReview
            ? `Document generated with ${result.missingFields.length} field(s) needing manual review before sending.`
            : "Document fully auto-filled — review recommended before sending.",
    });
});
/* ===================== Power dialer ===================== */
function dialOutcomeLabel(status) {
    switch (status) {
        case "completed":
            return "Answered";
        case "no_answer":
            return "No Answer";
        case "voicemail":
            return "Voicemail";
        case "skipped":
            return "Skipped";
        default:
            return status;
    }
}
async function logDialLeadActivity(dialLead, agentNotes) {
    if (!dialLead.leadId)
        return;
    const outcome = dialOutcomeLabel(dialLead.status);
    const secs = typeof dialLead.duration === "number" ? dialLead.duration : 0;
    const desc = `Call made · ${outcome} · ${secs}s`;
    const entry = {
        type: "call_made",
        description: desc,
        timestamp: dialLead.callEnded || new Date().toISOString(),
    };
    if (agentNotes?.trim())
        entry.notes = agentNotes.trim();
    const existing = await (0, db_js_1.getLeadById)(dialLead.leadId);
    if (!existing)
        return;
    const bumpAlert = dialLead.status === "no_answer" || dialLead.status === "voicemail";
    const nextAlerts = bumpAlert ? (existing.alerts || 0) + 1 : existing.alerts;
    await (0, db_js_1.appendLeadActivity)(dialLead.leadId, [entry]);
    if (bumpAlert && nextAlerts !== undefined) {
        await (0, db_js_1.updateLeadCrmFields)({ leadId: dialLead.leadId, alerts: nextAlerts });
    }
}
app.post("/api/dial/start", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const leadIds = Array.isArray(body.leadIds)
        ? body.leadIds.map((id) => String(id).trim()).filter(Boolean)
        : [];
    if (!leadIds.length) {
        res.status(400).json({ error: "leadIds required" });
        return;
    }
    (0, dialSession_js_1.clearDialSession)();
    const dialLeads = [];
    for (const id of leadIds) {
        const lead = await (0, db_js_1.getLeadById)(id);
        if (!lead || !lead.phone?.trim())
            continue;
        dialLeads.push({
            leadId: lead.id,
            name: lead.name || lead.username || lead.phone || "Lead",
            phone: lead.phone.trim(),
            status: "pending",
        });
    }
    if (!dialLeads.length) {
        res.status(400).json({ error: "No leads with phone numbers found" });
        return;
    }
    const session = (0, dialSession_js_1.createDialSession)(dialLeads);
    res.status(201).json({ session });
});
app.get("/api/dial/session", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const session = (0, dialSession_js_1.getActiveDialSession)();
    res.status(200).json({ session });
});
app.get("/api/dial/history", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    res.status(200).json({ sessions: (0, dialSession_js_1.getDialSessionHistory)(5) });
});
app.post("/api/dial/next", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const session = (0, dialSession_js_1.getActiveDialSession)();
    if (!session) {
        res.status(404).json({ error: "No active dial session" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const outcome = typeof body.outcome === "string" ? body.outcome : "answered";
    const notes = typeof body.notes === "string" ? body.notes : "";
    const duration = typeof body.duration === "number" && body.duration >= 0 ? Math.round(body.duration) : undefined;
    const prevIndex = session.currentIndex;
    const updated = (0, dialSession_js_1.advanceDialSession)(outcome, { notes, duration });
    if (updated && prevIndex >= 0 && prevIndex < updated.leads.length) {
        await logDialLeadActivity(updated.leads[prevIndex], notes);
    }
    res.status(200).json({ session: updated });
});
app.post("/api/dial/skip", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const session = (0, dialSession_js_1.getActiveDialSession)();
    if (!session) {
        res.status(404).json({ error: "No active dial session" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const notes = typeof body.notes === "string" ? body.notes : "";
    const prevIndex = session.currentIndex;
    const updated = (0, dialSession_js_1.advanceDialSession)("skip", { notes });
    if (updated && prevIndex >= 0 && prevIndex < updated.leads.length) {
        await logDialLeadActivity(updated.leads[prevIndex], notes);
    }
    res.status(200).json({ session: updated });
});
app.post("/api/dial/pause", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const session = (0, dialSession_js_1.pauseDialSession)();
    if (!session) {
        res.status(404).json({ error: "No active dial session to pause" });
        return;
    }
    res.status(200).json({ session });
});
app.post("/api/dial/resume", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const session = (0, dialSession_js_1.resumeDialSession)();
    if (!session) {
        res.status(404).json({ error: "No paused dial session" });
        return;
    }
    res.status(200).json({ session });
});
app.post("/api/dial/end", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const session = (0, dialSession_js_1.getActiveDialSession)();
    if (session) {
        const current = (0, dialSession_js_1.getCurrentDialLead)(session);
        if (current && current.status === "calling") {
            const skipped = {
                ...current,
                status: "skipped",
                callEnded: new Date().toISOString(),
                outcome: "Session ended",
                duration: 0,
            };
            await logDialLeadActivity(skipped);
        }
        (0, dialSession_js_1.completeDialSession)();
    }
    (0, dialSession_js_1.clearDialSession)();
    res.status(200).json({ ok: true });
});
/* ===================== Call assistant ===================== */
app.post("/api/call-assistant/suggest", express_1.default.json(), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const leadId = typeof body.leadId === "string" ? body.leadId.trim() : "";
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const context = typeof body.context === "string" ? body.context : "";
    if (!leadId || !question) {
        res.status(400).json({ error: "leadId and question required" });
        return;
    }
    try {
        const result = await (0, callAssistant_js_1.runCallAssistantSuggest)({ leadId, question, context });
        res.status(200).json(result);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
app.get("/api/call-assistant/stream/:leadId", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leadId = String(req.params.leadId || "").trim();
    const question = typeof req.query.question === "string" ? req.query.question : "";
    const context = typeof req.query.context === "string" ? req.query.context : "";
    if (!leadId || !question) {
        res.status(400).json({ error: "leadId and question required" });
        return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    try {
        for await (const word of (0, callAssistant_js_1.streamCallAssistantWords)({ leadId, question, context })) {
            res.write(`data: ${JSON.stringify({ word })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    }
    res.end();
});
/* ===================== Digital signing documents ===================== */
function genDocId() {
    return "doc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
app.post("/api/leads/:id/skip-trace", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leadId = String(req.params.id || "").trim();
    const lead = await (0, db_js_1.getLeadById)(leadId);
    if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
    }
    if (!lead.phone?.trim()) {
        res.status(400).json({ error: "Lead has no phone number" });
        return;
    }
    const result = await (0, forewarn_js_1.runSkipTrace)(lead.phone.trim());
    const history = [...(lead.skipTraceResults || []), result];
    const updates = {
        leadId,
        skipTraceResults: history,
        lastActivity: new Date().toISOString(),
    };
    const nameBlank = !lead.name?.trim();
    const nameIsHandle = lead.name?.trim().startsWith("@") || lead.username?.trim().startsWith("@");
    if (result.foundName && (nameBlank || nameIsHandle)) {
        updates.name = result.foundName;
    }
    if (result.foundEmail && !lead.email?.trim()) {
        updates.email = result.foundEmail;
    }
    const activityEntry = {
        type: "skip_trace",
        description: `Skip trace run via ${result.source} — confidence: ${result.confidence || "unknown"}`,
        timestamp: result.runAt,
    };
    await (0, db_js_1.appendLeadActivity)(leadId, [activityEntry]);
    const updated = await (0, db_js_1.updateLeadCrmFields)(updates);
    res.status(200).json({ result, lead: updated });
});
app.get("/api/leads/:id/documents", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const lead = await (0, db_js_1.getLeadById)(String(req.params.id || "").trim());
    if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
    }
    res.status(200).json({ documents: lead.documents || [] });
});
app.post("/api/leads/:id/documents/send", express_1.default.json({ limit: "20mb" }), async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leadId = String(req.params.id || "").trim();
    const lead = await (0, db_js_1.getLeadById)(leadId);
    if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {});
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "";
    if (!name) {
        res.status(400).json({ error: "Missing document name" });
        return;
    }
    const now = new Date().toISOString();
    const doc = {
        id: genDocId(),
        name,
        fileData: typeof body.fileData === "string" ? body.fileData : "",
        status: "sent",
        sentAt: now,
        signerEmail: typeof body.signerEmail === "string" ? body.signerEmail : undefined,
        signerName: typeof body.signerName === "string" ? body.signerName : undefined,
    };
    const documents = [...(lead.documents || []), doc];
    await (0, db_js_1.updateLeadCrmFields)({ leadId, documents });
    res.status(201).json({ document: doc });
});
app.post("/api/leads/:id/documents/:docId/sign", async (req, res) => {
    if (!dashboardTokenOk(req)) {
        res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
        return;
    }
    const leadId = String(req.params.id || "").trim();
    const docId = String(req.params.docId || "").trim();
    const lead = await (0, db_js_1.getLeadById)(leadId);
    if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
    }
    const documents = (lead.documents || []).map((d) => d.id === docId ? { ...d, status: "signed", signedAt: new Date().toISOString() } : d);
    if (!documents.some((d) => d.id === docId)) {
        res.status(404).json({ error: "Document not found" });
        return;
    }
    await (0, db_js_1.updateLeadCrmFields)({ leadId, documents });
    res.status(200).json({ document: documents.find((d) => d.id === docId) });
});
/** Serve other public assets (CRM modules, etc.) after explicit routes. */
app.use(express_1.default.static(publicDir, { index: false }));
const httpServer = http_1.default.createServer(app);
const hullWss = new ws_1.WebSocketServer({ noServer: true });
hullWss.on("connection", (ws) => {
    (0, index_js_21.registerHullWs)(ws);
});
httpServer.on("upgrade", (request, socket, head) => {
    if ((0, deepgramProxy_js_1.handleDeepgramUpgrade)(request, socket, head, dashboardTokenOkIncoming))
        return;
    const url = request.url || "";
    if (url.startsWith("/ws")) {
        if (!dashboardTokenOkIncoming(request)) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }
        hullWss.handleUpgrade(request, socket, head, (ws) => {
            hullWss.emit("connection", ws, request);
        });
        return;
    }
    socket.destroy();
});
// Scheduled Auto Plan execution — every 24 hours.
const AUTO_PLAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
    executeDueAutoPlanSteps()
        .then((r) => {
        if (r.stepsExecuted > 0) {
            console.log(`[autoPlans] scheduled run: ${r.stepsExecuted} step(s) across ${r.processed} enrollment(s)`);
        }
    })
        .catch((err) => console.error("[autoPlans] scheduled run failed:", err));
}, AUTO_PLAN_INTERVAL_MS);
async function ensureSocialDataExists() {
    try {
        if (!(0, socialStore_js_1.socialDataAvailable)()) {
            console.log("[Social] No data found on startup — running initial agent pull");
            await (0, index_js_1.runSocialMediaAgent)();
        }
        else {
            const summary = (0, socialStore_js_1.getSocialSummaryForHarvey)();
            const pulledAt = summary.pulledAt ?? summary.fetchedAt;
            console.log("[Social] Social data exists — last pull:", pulledAt);
        }
    }
    catch (err) {
        console.error("[Social] Startup check failed:", err);
    }
}
httpServer.on("error", (err) => {
    console.error("[Server] HTTP listen error:", err);
    process.exit(1);
});
httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] Listening on 0.0.0.0:${PORT}`);
    try {
        (0, contentDb_js_1.getContentDb)();
        (0, jobs_js_1.scheduleContentJobs)();
    }
    catch (err) {
        console.error("[Server] content DB / jobs init failed:", err);
    }
    try {
        (0, index_js_21.initHull)();
    }
    catch (err) {
        console.error("[hull] init failed:", err);
    }
    if (!process.env.DEEPGRAM_API_KEY?.trim()) {
        console.warn("[Harvey] DEEPGRAM_API_KEY not set — Flux voice STT will not work");
    }
    else {
        console.log("[Harvey] DEEPGRAM_API_KEY configured — Flux STT ready");
    }
    if (!geminiApiKey()) {
        console.warn("[Harvey] GEMINI_API_KEY not set — Gemini TTS will not work");
    }
    else {
        console.log("[Harvey] GEMINI_API_KEY configured — Gemini TTS ready");
    }
    if ((0, index_js_19.isAnthropicApiKeyConfigured)()) {
        console.log(`[Anthropic] API key present — model ${(0, index_js_19.getAnthropicModel)()} (set ANTHROPIC_MODEL to override).`);
    }
    else {
        console.warn("[Anthropic] ANTHROPIC_API_KEY missing — preflight/opening/pipeline skip Haiku and use template fallbacks only.");
    }
    void Promise.resolve().then(() => __importStar(require("./integrations/email/index.js"))).then(async (m) => {
        const ok = await m.verifyEmailConnection();
        if (ok) {
            void Promise.resolve().then(() => __importStar(require("./agents/emailMarketing/gmailSync.js"))).then((g) => g.syncGmailInbox({ maxResults: 25 }).catch((err) => console.warn("[GmailSync] startup sync failed:", err instanceof Error ? err.message : err)));
        }
    });
    void Promise.resolve().then(() => __importStar(require("./agents/finance/index.js"))).then((m) => m.syncCommissionsFromClosedTransactions().catch((err) => console.warn("[Finance] startup commission sync failed:", err instanceof Error ? err.message : err)));
    console.log(`Health:  GET  http://localhost:${PORT}/health`);
    console.log(`Dashboard: GET http://localhost:${PORT}/ (also /dashboard)`);
    console.log(`Social:    GET http://localhost:${PORT}/social`);
    console.log(`Email Mkt: GET http://localhost:${PORT}/email-marketing`);
    console.log(`Lead Nurture: GET http://localhost:${PORT}/lead-nurture`);
    console.log(`Reporting:  GET http://localhost:${PORT}/reporting`);
    console.log(`Finance:    GET http://localhost:${PORT}/finance`);
    console.log(`Chat demo: GET http://localhost:${PORT}/chat`);
    console.log(`Harvey:  GET  http://localhost:${PORT}/jarvis`);
    console.log(`Harvey ops: GET http://localhost:${PORT}/api/jarvis/ops`);
    console.log(`Harvey chat: POST http://localhost:${PORT}/api/jarvis/chat (model ${(0, index_js_20.getHarveyModel)()})`);
    console.log(`Harvey voice STT: WS   http://localhost:${PORT}/api/jarvis/deepgram/listen`);
    console.log(`Harvey voice TTS: POST http://localhost:${PORT}/api/jarvis/voice`);
    console.log(`Neural Map: GET http://localhost:${PORT}/memory`);
    console.log(`Harvey market intel: POST http://localhost:${PORT}/api/jarvis/market-intel`);
    console.log(`Harvey world intel: POST http://localhost:${PORT}/api/jarvis/world-intel`);
    console.log(`Simulate: POST http://localhost:${PORT}/simulate`);
    console.log(`Webhook: POST http://localhost:${PORT}/webhook`);
    console.log(`Reset:   POST http://localhost:${PORT}/reset`);
    console.log(`Sinch:   POST http://localhost:${PORT}/sinch/inbound`);
    console.log(`Twilio receive: POST http://localhost:${PORT}/webhook/twilio`);
    console.log(`Twilio CRM send: POST http://localhost:${PORT}/api/sms/send (auth: DASHBOARD_TOKEN)`);
    console.log(`Ads proxy: GET http://localhost:${PORT}/api/ads/summary (needs AD_DASHBOARD_BASE_URL)`);
    if (AD_DASHBOARD_BASE_URL) {
        console.log(`  → upstream: ${AD_DASHBOARD_BASE_URL}/api/latest`);
    }
    void ensureSocialDataExists();
});
