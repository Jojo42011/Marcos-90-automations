/**
 * HTTP server: GET / lead dashboard, POST /webhook & /simulate → pipeline (CORS on simulate/webhook).
 */
import "dotenv/config";
import http from "http";
import type { IncomingMessage } from "http";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import multer from "multer";
import { handleWebhook, handleIncomingPayload } from "./app/webhook.js";
import { getSocialTikTokData, refreshSocialTikTokData } from "./app/socialRefresh.js";
import {
  runSocialMediaAgent,
} from "./agents/socialMedia/index.js";
import { scheduleContentJobs } from "./app/jobs.js";
import {
  getSocialSummaryForHarvey,
  getSocialVideos,
  socialDataAvailable,
  getPendingCommentReplies,
  updateCommentReplyStatus,
  getLatestSocialDashboardData,
  saveVideoImprovements,
  getVideoImprovements,
  setSocialRefreshTime,
  getSocialRefreshTime,
  getRecentAgentPulls,
  getTodaysAgentPulls,
} from "./core/socialStore.js";
import { runMorningScan, getLatestMorningScan } from "./agents/morningScan/index.js";
import { generateCommentReply } from "./agents/commentReply/index.js";
import { generateVideoImprovements } from "./agents/videoFeedback/index.js";
import { runEveningPull } from "./agents/eveningPull/index.js";
import {
  getLatestReportingSnapshot,
  getRecentReportingSnapshots,
} from "./agents/reporting/index.js";
import {
  generateWeeklyContentSuggestions,
  getLatestContentSuggestions,
} from "./agents/contentSuggestions/index.js";
import {
  getRecentEscalations,
  runAllEscalationChecks,
} from "./agents/escalations/index.js";
import { getLatestContentDigest } from "./agents/harveyContentDigest/index.js";
import {
  createCommandTask,
  deleteCommandTask,
  getCommandTasks,
  getDashboardSnapshot,
  normalizeCrmIntent,
  resetMemoryStore,
  seedCommandTasksIfEmpty,
  updateCommandTask,
  updateLeadCrmFields,
  getLeadById,
  appendMessage,
  findLeadByPhoneDigits,
  createLead,
  appendLeadActivity,
  isLeadInactive30Days,
  listAllLeads,
  deleteLeads,
} from "./core/db.js";
import {
  getAutoPlans,
  getAutoPlanById,
  createAutoPlan,
  updateAutoPlan,
  deleteAutoPlan,
} from "./core/autoPlans.js";
import {
  createTagTemplate,
  deleteTagTemplate,
  getTagTemplates,
} from "./core/tagTemplates.js";
import { filterDashboardLeads } from "./core/leadFilter.js";
import type { LeadFilter } from "./core/types.js";
import {
  createUser,
  deleteUser,
  getUserById,
  getUsers,
  updateUser,
} from "./core/users.js";
import type { CRMUser, UserPermissions, UserRole } from "./core/types.js";
import { ROLE_PERMISSIONS } from "./core/types.js";
import type {
  AutoPlan,
  Deal,
  DealStatus,
  DealType,
  LeadAutoPlanEnrollment,
  SigningDocument,
  Task,
  TaskPriority,
  TaskSource,
  TaskStatus,
  TaskType,
} from "./core/types.js";
import {
  buildTasksSummary,
  createTask,
  deleteTask,
  filterTasks,
  getTaskById,
  getTasks,
  updateTask,
} from "./core/tasks.js";
import {
  buildMarcoTasksSummary,
  createMarcoTask,
  deleteMarcoTask,
  getMarcoTasks,
  seedMarcoTasksIfEmpty,
  sortMarcoTasks,
  updateMarcoTask,
} from "./core/marcoTasks.js";
import {
  createNote,
  deleteNote,
  filterNotes,
  getNotes,
  searchNotes,
  updateNote,
} from "./core/harveyNotes.js";
import type {
  CommandTask,
  CommandTaskColor,
  CommandTaskColumn,
  CommandTaskRecurringInterval,
  HarveyNoteCategory,
  MarcoTaskPriority,
  MarcoTaskStatus,
} from "./core/types.js";
import {
  calculateGCI,
  createDeal,
  deleteDeal,
  getDealById,
  getDeals,
  getDealsByLeadId,
  readLegacyDealsJson,
  updateDeal,
} from "./core/deals.js";
import {
  createDeadline,
  createDocument,
  createDocumentTemplate,
  createTransaction,
  deleteTransaction,
  flagDocumentForReview,
  generateFullDeadlineTimeline,
  getAllTemplates,
  getAllTransactions,
  getDeadlinesForDeal,
  getDocument,
  getDocumentsForDeal,
  getDocumentsNeedingReview,
  getOverdueDeadlines,
  getTemplate,
  getTransaction,
  getUnsignedDocuments,
  getUpcomingDeadlines,
  markDeadlineCompleted,
  migrateFromDealsJson,
  resolveTemplatesDir,
  updateDocumentStatus,
  updateTransaction,
  type DocumentType,
  type TemplateType,
  type Transaction,
  type TransactionDeadline,
  type TransactionDocument,
} from "./core/transactionsStore.js";
import { fillDocumentTemplate, inspectTemplatePdfFields } from "./core/documentFill.js";
import {
  checkTransactionDeadlines,
  checkMissedSameDayDeadlines,
  runDailyTransactionWorkflowChecks,
} from "./agents/transactionDeadlines/index.js";
import { checkInspectionConfirmation } from "./agents/transactionFlows/inspectionFlow.js";
import {
  checkCloseDayTriggers,
  checkScheduledClientCheckIns,
} from "./agents/transactionFlows/postCloseFlow.js";
import { scoreAllLeads, scoreAndRecordLead, scoreColdLeads } from "./agents/leadScoring/index.js";
import { runWarmLeadWeeklyTouch } from "./agents/leadNurture/warmLeadFlow.js";
import { runColdLeadMonthlyTouch } from "./agents/leadNurture/coldLeadFlow.js";
import { routeNewLead } from "./agents/leadNurture/sourceRouting.js";
import {
  getLatestScore,
  getScoreHistory,
  getLeadsByTier,
} from "./core/leadScoreStore.js";
import type {
  InspectionFlow,
  FinalWeekFlow,
} from "./core/transactionsStore.js";
import { FunnelStage } from "./core/state.js";
import type {
  CrmIntent,
  CrmStage,
  CrmStatus,
  DialSessionLead,
  DialSessionLeadStatus,
  LeadActivity,
} from "./core/types.js";
import {
  advanceDialSession,
  clearDialSession,
  completeDialSession,
  createDialSession,
  getActiveDialSession,
  getCurrentDialLead,
  getDialSessionHistory,
  pauseDialSession,
  resumeDialSession,
} from "./core/dialSession.js";
import { runCallAssistantSuggest, streamCallAssistantWords } from "./core/callAssistant.js";
import { runSkipTrace } from "./integrations/forewarn.js";
import { normalizeCrmStatus, normalizeCrmTags } from "./core/db.js";
import type { IncomingWebhookPayload } from "./core/types.js";
import { receiveInbound } from "./integrations/sinch/index.js";
import {
  isTwilioConfigured,
  normalizeToUsE164,
  sendTwilioMessage,
  validateTwilioSignature,
  claimTwilioInboundSid,
} from "./integrations/twilio/index.js";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicModel, isAnthropicApiKeyConfigured } from "./integrations/llm/index.js";
import { fetchAdsSummaryFromUpstream } from "./harvey/adsUpstream.js";
import { randomUUID } from "crypto";
import { runHarveyChat, runHarveyOps, getHarveyModel } from "./harvey/index.js";
import { executeHarveyTool, HARVEY_GEMINI_TOOLS } from "./harvey/tools.js";
import {
  logSmsIfNew,
  logSmsMessage,
  markRepliedAt,
  getThreadForLead,
  isMessageHandleSeen,
} from "./core/smsStore.js";
import { getLeadFirstName } from "./app/inboundReplyHelper.js";
import {
  checkAndSendShowingReminders,
  checkShowingConfirmation,
  checkPostShowingFeedback,
  scheduleShowingReminders,
  getUpcomingShowings,
} from "./agents/showingReminders/index.js";
import { runMojoOutreachSequence, scheduleMojoOutreach, isMojoLead } from "./agents/mojoOutreach/index.js";
import {
  detectConversationEscalation,
  notifyMarcoOfConversationEscalation,
} from "./agents/conversationEscalations/index.js";
import { checkTextingAllowed, isWithinTextingHours } from "./core/textingRules.js";
import { bootstrapMemory } from "./harvey/memory/bootstrap.js";
import { retrieveMemories } from "./harvey/memory/retrieval.js";
import { getMemoryDb } from "./harvey/memory/store.js";
import { newMarcoRequestId, marcoCorrelationId } from "./app/marcoLog.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

/** Base URL of the Flask ad dashboard (no trailing slash), e.g. http://127.0.0.1:5050 or https://your-ad-app.fly.dev */
const AD_DASHBOARD_BASE_URL = process.env.AD_DASHBOARD_BASE_URL?.trim().replace(/\/$/, "") || "";
/** Optional Bearer token sent to the ad app if you add auth there later */
const AD_DASHBOARD_API_KEY = process.env.AD_DASHBOARD_API_KEY?.trim() || "";

// Serve static HTML from project root ./public (run server via `npm run dev:mock` from repo root)
const publicDir = path.join(process.cwd(), "public");

const GEMINI_LIVE_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

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

function geminiApiKey(): string {
  return process.env.GEMINI_API_KEY?.trim() || "";
}

function geminiLiveModel(): string {
  return process.env.GEMINI_LIVE_MODEL?.trim() || "gemini-3.1-flash-live-preview";
}

const GEMINI_LIVE_SYSTEM_PROMPT_MAX = 4000;

function trimGeminiSystemPrompt(prompt: string): string {
  if (prompt.length <= GEMINI_LIVE_SYSTEM_PROMPT_MAX) return prompt;
  const trimmed = prompt.slice(0, GEMINI_LIVE_SYSTEM_PROMPT_MAX - 32).trimEnd();
  console.warn(
    `[GeminiLive] System prompt truncated from ${prompt.length} to ${trimmed.length} chars (max ${GEMINI_LIVE_SYSTEM_PROMPT_MAX})`,
  );
  return `${trimmed}\n\n[Context truncated for Live API limit]`;
}

app.get("/health", (_req, res) => {
  const apiKeyConfigured = isAnthropicApiKeyConfigured();
  res.status(200).json({
    ok: true,
    anthropic: {
      api_key_configured: apiKeyConfigured,
      model: getAnthropicModel(),
      hint: apiKeyConfigured
        ? "Haiku runs for preflight, opening, and pipeline when those paths call the API (billing and valid JSON still required)."
        : "Set ANTHROPIC_API_KEY on the host. Without it, DMs use hardcoded fallbacks only.",
    },
    twilio: {
      configured: isTwilioConfigured(),
      hint: isTwilioConfigured()
        ? "Outbound SMS available; inbound webhook should point to POST /webhook/twilio"
        : "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER for SMS handoff from CRM.",
    },
    harvey: {
      model: getHarveyModel(),
      api_key_configured: isAnthropicApiKeyConfigured(),
      voice: {
        engine: geminiApiKey() ? "gemini-live" : "none",
        gemini_configured: Boolean(geminiApiKey()),
        tts: geminiApiKey() ? "gemini" : "none",
      },
    },
  });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "dashboard.html"));
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(publicDir, "dashboard.html"));
});

/** Legacy DM simulator */
app.get("/chat", (_req, res) => {
  res.sendFile(path.join(publicDir, "chat.html"));
});

app.get("/jarvis", (_req, res) => {
  res.sendFile(path.join(publicDir, "jarvis.html"));
});

app.get("/tasks", (_req, res) => {
  res.sendFile(path.join(publicDir, "tasks.html"));
});

app.get("/social", (_req, res) => {
  res.sendFile(path.join(publicDir, "social.html"));
});

app.get("/crm-followup-tasks.js", (_req, res) => {
  res.sendFile(path.join(publicDir, "crm-followup-tasks.js"));
});

function dashboardTokenOk(req: express.Request): boolean {
  return dashboardTokenOkIncoming(req);
}

function dashboardTokenOkIncoming(req: IncomingMessage | express.Request): boolean {
  const expected = process.env.DASHBOARD_TOKEN?.trim();
  if (!expected) return true;
  let q = "";
  if ("query" in req && req.query && typeof req.query.token === "string") {
    q = req.query.token;
  } else {
    try {
      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "/", `http://${host}`);
      q = url.searchParams.get("token") || "";
    } catch {
      q = "";
    }
  }
  const auth = req.headers.authorization;
  const bearer =
    typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
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
    const data = await getDashboardSnapshot();
    res.status(200).json(data);
  } catch (err) {
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
    res.status(200).json(getSocialTikTokData());
  } catch (err) {
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
    const data = await refreshSocialTikTokData();
    res.status(200).json(data);
  } catch (err) {
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
    const summary = getSocialSummaryForHarvey();
    const sampleVideos = getSocialVideos({ limit: 3 });
    const stats = summary.stats as Record<string, unknown> | undefined;
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
  } catch (err) {
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

    const data = getLatestSocialDashboardData();
    let videos = (data.videos || []).map((v) => ({
      ...v,
      improvements: getVideoImprovements(v.id) ?? null,
    }));

    if (tier && tier !== "all") {
      videos = videos.filter((v) => {
        const t = v.scoreBreakdown?.tier ?? v.tier;
        return t === tier || (tier === "warm" && t === "average");
      });
    }

    if (sort === "score_asc") {
      videos.sort(
        (a, b) =>
          (a.scoreBreakdown?.score ?? a.score ?? 0) - (b.scoreBreakdown?.score ?? b.score ?? 0),
      );
    } else if (sort === "recent") {
      videos.sort(
        (a, b) => new Date(b.postedAt || 0).getTime() - new Date(a.postedAt || 0).getTime(),
      );
    } else if (sort === "views") {
      videos.sort((a, b) => (b.views || 0) - (a.views || 0));
    } else {
      videos.sort(
        (a, b) =>
          (b.scoreBreakdown?.score ?? b.score ?? 0) - (a.scoreBreakdown?.score ?? a.score ?? 0),
      );
    }

    res.json({ videos });
  } catch (err) {
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
    const data = getLatestSocialDashboardData();
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

    const improvements = await generateVideoImprovements({
      description: video.caption || "",
      views: video.views || 0,
      likes: video.likes || 0,
      comments: video.comments || 0,
      shares: video.shares || 0,
      saves: video.saves || 0,
      scoreBreakdown: breakdown,
    });

    saveVideoImprovements(postId, improvements);
    res.json({ improvements });
  } catch (err) {
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
    const data = getLatestSocialDashboardData();
    const videos = data.videos || [];
    let generated = 0;

    for (const video of videos) {
      const postId = video.id;
      const existing = getVideoImprovements(postId);
      if (existing) continue;

      const breakdown = video.scoreBreakdown ?? {
        score: video.score ?? 0,
        viewsScore: 0,
        retentionScore: 0,
        savesScore: 0,
        sharesScore: 0,
        tier: video.tier ?? "cold",
      };

      const improvements = await generateVideoImprovements({
        description: video.caption || "",
        views: video.views || 0,
        likes: video.likes || 0,
        comments: video.comments || 0,
        shares: video.shares || 0,
        saves: video.saves || 0,
        scoreBreakdown: breakdown,
      });

      saveVideoImprovements(postId, improvements);
      generated++;
      await new Promise((r) => setTimeout(r, 500));
    }

    res.json({ generated, total: videos.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.get("/api/social/refresh-schedule", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const time = getSocialRefreshTime();
  res.json({ time });
});

app.post("/api/social/refresh-schedule", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const time = typeof body.time === "string" ? body.time : "";
  if (!time || !/^\d{2}:\d{2}$/.test(time)) {
    res.status(400).json({ error: "time must be HH:MM format" });
    return;
  }
  setSocialRefreshTime(time);
  res.json({ success: true, time });
});

app.get("/api/evening-pull/latest", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({ result: getLatestReportingSnapshot("evening") });
});

app.post("/api/evening-pull/run", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const result = await runEveningPull();
    res.json({ result });
  } catch (err) {
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
  const limit =
    typeof limitRaw === "string" && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : 14;
  res.json({ snapshots: getRecentReportingSnapshots(limit) });
});

app.get("/api/content-suggestions/latest", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({ result: getLatestContentSuggestions() });
});

app.post("/api/content-suggestions/generate", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const result = await generateWeeklyContentSuggestions();
    res.json({ result });
  } catch (err) {
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
  const limit =
    typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
      ? parseInt(limitRaw, 10)
      : 20;
  res.json({ pulls: getRecentAgentPulls(limit) });
});

app.get("/api/agent/pull-log/today", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({ pulls: getTodaysAgentPulls() });
});

app.get("/api/agent/status", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const digest = getLatestContentDigest();
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

  let lastRunAt: string | null = null;
  let nextRunAt: string | null = null;
  let msUntilNext: number | null = null;

  if (digest) {
    lastRunAt = digest.generatedAt;
    const nextRunMs = new Date(digest.generatedAt).getTime() + THREE_DAYS_MS;
    nextRunAt = new Date(nextRunMs).toISOString();
    msUntilNext = Math.max(0, nextRunMs - Date.now());
  } else {
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
  const limit =
    typeof limitRaw === "string" && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : 20;
  res.json({ escalations: getRecentEscalations(limit) });
});

app.post("/api/escalations/check-now", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    await runAllEscalationChecks();
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.get("/api/morning-scan/latest", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const result = getLatestMorningScan();
  res.json({ result });
});

app.post("/api/morning-scan/run", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const result = await runMorningScan();
    res.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.get("/api/comment-replies/pending", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const replies = getPendingCommentReplies();
  res.json({ replies });
});

app.post("/api/comment-replies/:id/approve", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  updateCommentReplyStatus(parseInt(String(req.params.id), 10), "approved");
  res.json({ success: true });
});

app.post("/api/comment-replies/:id/reject", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  updateCommentReplyStatus(parseInt(String(req.params.id), 10), "rejected");
  res.json({ success: true });
});

app.post("/api/comment-replies/generate", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const commentText = typeof body.commentText === "string" ? body.commentText : "";
  const authorUsername = typeof body.authorUsername === "string" ? body.authorUsername : "";
  const postId = typeof body.postId === "string" ? body.postId : undefined;
  if (!commentText || !authorUsername) {
    res.status(400).json({ error: "commentText and authorUsername required" });
    return;
  }
  try {
    const reply = await generateCommentReply(commentText, authorUsername, postId);
    res.json({ reply });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.patch("/api/crm/lead/:id", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  if (!id) {
    res.status(400).json({ error: "Missing lead id" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const crmStatusRaw = typeof body.crmStatus === "string" ? body.crmStatus : undefined;
  const crmStatus = crmStatusRaw !== undefined ? normalizeCrmStatus(crmStatusRaw) : undefined;
  const crmStage = typeof body.crmStage === "string" ? body.crmStage : undefined;
  const crmPriority = typeof body.crmPriority === "string" ? body.crmPriority : undefined;
  const crmIntent = typeof body.crmIntent === "string" ? body.crmIntent : undefined;
  const crmCallQueueRaw = typeof body.crmCallQueue === "string" ? body.crmCallQueue : undefined;
  const crmCallQueue =
    crmCallQueueRaw === "urgent" || crmCallQueueRaw === "routine" || crmCallQueueRaw === "none"
      ? crmCallQueueRaw
      : undefined;
  const crmNotes =
    body.crmNotes === null ? null : typeof body.crmNotes === "string" ? body.crmNotes : undefined;
  const name = body.name === null ? null : typeof body.name === "string" ? body.name : undefined;
  const email = body.email === null ? null : typeof body.email === "string" ? body.email : undefined;
  const phone = body.phone === null ? null : typeof body.phone === "string" ? body.phone : undefined;
  const source = body.source === null ? null : typeof body.source === "string" ? body.source : undefined;
  const propertyInquired =
    body.propertyInquired === null
      ? null
      : typeof body.propertyInquired === "string"
        ? body.propertyInquired
        : undefined;
  const brivityId =
    body.brivityId === null ? null : typeof body.brivityId === "string" ? body.brivityId : undefined;
  const tags = body.tags !== undefined ? normalizeCrmTags(body.tags) : undefined;
  const assignedUserId =
    body.assignedUserId === null
      ? null
      : typeof body.assignedUserId === "string"
        ? body.assignedUserId.trim() || null
        : undefined;
  const assignedUserName =
    body.assignedUserName === null
      ? null
      : typeof body.assignedUserName === "string"
        ? body.assignedUserName.trim() || null
        : undefined;
  const deal = body.deal !== undefined ? body.deal : undefined;
  const activity = body.activity !== undefined ? body.activity : undefined;
  const skipTraceResults = body.skipTraceResults !== undefined ? body.skipTraceResults : undefined;
  const phoneNumberSeen = body.phoneNumberSeen === true ? true : body.phoneNumberSeen === false ? false : undefined;
  const preApprovalStatus =
    body.preApprovalStatus === null
      ? null
      : typeof body.preApprovalStatus === "string"
        ? body.preApprovalStatus
        : undefined;
  const propertyViewsCount =
    typeof body.propertyViewsCount === "number" ? body.propertyViewsCount : undefined;

  let criteria: Record<string, unknown> | null | undefined = undefined;
  if (body.criteria === null) criteria = null;
  else if (body.criteria && typeof body.criteria === "object") {
    const c = body.criteria as Record<string, unknown>;
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
    const updated = await updateLeadCrmFields({
      leadId: id,
      crmStatus: crmStatus as any,
      crmStage: crmStage as any,
      crmPriority: crmPriority as any,
      crmIntent: crmIntent !== undefined ? normalizeCrmIntent(crmIntent) : undefined,
      crmCallQueue,
      crmNotes,
      name,
      email,
      phone,
      source,
      propertyInquired,
      brivityId,
      criteria: criteria as any,
      tags,
      assignedUserId,
      assignedUserName,
      deal,
      activity,
      skipTraceResults,
      phoneNumberSeen,
      preApprovalStatus: preApprovalStatus as import("./core/types.js").PreApprovalStatus | null | undefined,
      propertyViewsCount,
    });
    if (!updated) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

async function handleMassDeleteLeads(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const leadIds = req.body?.leadIds;
  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    res.status(400).json({ error: "leadIds array required" });
    return;
  }
  const ids = leadIds.map((id: unknown) => String(id || "").trim()).filter(Boolean);
  if (!ids.length) {
    res.status(400).json({ error: "leadIds array required" });
    return;
  }
  try {
    const deleted = await deleteLeads(ids);
    console.log("[MassDelete] Deleted", deleted, "of", ids.length, "requested leads");
    res.json({ deleted, requested: ids.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
}

app.post("/api/leads/mass-delete", express.json(), handleMassDeleteLeads);
console.log("[Routes] POST /api/leads/mass-delete registered");
app.post("/api/crm/leads/mass-delete", express.json(), handleMassDeleteLeads);
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
    const updated = await updateLeadCrmFields({ leadId: id, phoneNumberSeen: true });
    if (!updated) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
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
  const thread = getThreadForLead(leadId);
  res.json({ thread });
});

app.post("/api/crm/lead/:id/showing", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const address = typeof body.address === "string" ? body.address.trim() : "";
  const scheduledAt = typeof body.scheduledAt === "string" ? body.scheduledAt.trim() : "";
  if (!address || !scheduledAt) {
    res.status(400).json({ error: "address and scheduledAt required" });
    return;
  }
  try {
    const updated = await updateLeadCrmFields({
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
  } catch (err) {
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
    const upcoming = await getUpcomingShowings();
    res.json({ upcoming });
  } catch (err) {
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
    const result = await checkAndSendShowingReminders();
    res.json(result);
  } catch (err) {
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
    const result = await runMojoOutreachSequence();
    res.json(result);
  } catch (err) {
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
  const gate = checkTextingAllowed(leadId);
  const withinHours = isWithinTextingHours();
  res.json({ ...gate, withinHours });
});

app.post("/api/crm/lead/:id/resume-automation", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  try {
    const updated = await updateLeadCrmFields({
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
  } catch (err) {
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
    const leads = (await listAllLeads()).filter((l) => l.automationPaused);
    res.json({
      paused: leads.map((l) => ({
        leadId: l.id,
        name: l.name || l.username,
        phone: l.phone,
        reason: l.automationPausedReason,
        pausedAt: l.automationPausedAt,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/** CRM: manually add a lead from the dashboard (not from ManyChat). */
app.post("/api/crm/lead", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
  const name = [firstName, lastName].filter(Boolean).join(" ") || null;
  const phoneRaw = typeof body.phone === "string" ? body.phone.trim() : "";
  const digits = phoneRaw.replace(/\D/g, "");
  const phone =
    digits.length === 10
      ? digits
      : digits.length === 11 && digits.startsWith("1")
        ? digits.slice(1)
        : null;
  if (!phone) {
    res.status(400).json({ error: "A valid US phone number is required" });
    return;
  }
  const existing = await findLeadByPhoneDigits(phone);
  if (existing) {
    res.status(409).json({ error: "A lead with this phone already exists", leadId: existing.id });
    return;
  }
  const email = typeof body.email === "string" && body.email.trim() ? body.email.trim() : null;
  const crmStatus = normalizeCrmStatus(body.crmStatus);
  const crmStage = (
    ["new", "hot", "warm", "cold", "pending", "appointment_set", "showing_set", "under_contract", "closed"].includes(
      String(body.crmStage || ""),
    )
      ? body.crmStage
      : "new"
  ) as CrmStage;
  const crmIntent = normalizeCrmIntent(body.crmIntent);
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
    const lead = await createLead({
      platform: "manual",
      userId,
      username: null,
      name,
      phone,
      email,
      state: FunnelStage.New,
      source,
      propertyInquired: null,
      criteria: areaParts.length ? { priceCap: null, beds: null, baths: null, area: areaParts.join(", ") } : null,
      brivityId: null,
      crmStatus,
      crmStage,
      crmPriority: "normal",
      crmIntent: crmIntent as CrmIntent,
      crmCallQueue: "none",
      crmNotes: notesParts.length ? notesParts.join("\n") : null,
      adCampaign: null,
    });
    res.status(201).json({ ok: true, leadId: lead.id });
  } catch (err) {
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
    const summary = await fetchAdsSummaryFromUpstream(
      AD_DASHBOARD_BASE_URL,
      AD_DASHBOARD_API_KEY,
    );
    res.status(200).json(summary);
  } catch (err) {
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
    const ops = await runHarveyOps(harveyDeps());
    res.status(200).json(ops);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[jarvis/ops]", message);
    res.status(500).json({ error: message });
  }
});

app.post("/api/jarvis/chat", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "Missing message" });
    return;
  }
  const sessionId =
    typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : undefined;

  try {
    const result = await runHarveyChat({
      message,
      sessionId,
      deps: harveyDeps(),
    });
    res.status(200).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[jarvis/chat]", msg);
    res.status(500).json({ error: msg });
  }
});

/** Gemini Live — WebSocket URL + setup for browser voice session. */
app.post("/api/jarvis/gemini-live/token", express.json({ limit: "64kb" }), (req, res) => {
  console.log("[GeminiLive] Token endpoint hit");
  console.log("[GeminiLive] GEMINI_API_KEY present:", !!process.env.GEMINI_API_KEY);
  console.log("[GeminiLive] GEMINI_API_KEY length:", process.env.GEMINI_API_KEY?.length);

  if (!dashboardTokenOk(req)) {
    console.log("[GeminiLive] Auth failed — unauthorized");
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const key = geminiApiKey();
  if (!key) {
    console.log("[GeminiLive] GEMINI_API_KEY not configured — returning 500");
    res.status(500).json({ error: "GEMINI_API_KEY not configured" });
    return;
  }
  const model = "gemini-3.1-flash-live-preview";
  const voiceName = "Charon";
  const systemPrompt = trimGeminiSystemPrompt(HARVEY_GEMINI_LIVE_SYSTEM_PROMPT);
  const wsUrl = `${GEMINI_LIVE_WS}?key=${encodeURIComponent(key)}`;

  console.log("[GeminiLive] Model being returned:", model);
  console.log("[GeminiLive] wsUrl prefix:", wsUrl.substring(0, 80));
  console.log("[GeminiLive] System prompt length:", systemPrompt.length);
  console.log("[GeminiLive] Voice name:", voiceName);
  console.log(
    "[GeminiLive] Tools:",
    HARVEY_GEMINI_TOOLS.functionDeclarations.length,
    "functions",
  );

  res.status(200).json({
    wsUrl,
    model,
    systemPrompt,
    voiceName,
    tools: HARVEY_GEMINI_TOOLS,
  });
});

/** Execute Harvey tools for Gemini Live voice (client relays tool calls server-side). */
app.post("/api/jarvis/execute-tool", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const toolName = String(body.toolName ?? "").trim();
  const toolInput =
    body.toolInput && typeof body.toolInput === "object" && !Array.isArray(body.toolInput)
      ? (body.toolInput as Record<string, unknown>)
      : {};

  if (!toolName) {
    res.status(400).json({ error: "toolName required" });
    return;
  }

  console.log("[Harvey Voice Tool] Executing:", toolName, "input:", JSON.stringify(toolInput));

  try {
    const result = await executeHarveyTool(toolName, toolInput);
    console.log(
      "[Harvey Voice Tool] Result for",
      toolName,
      ":",
      JSON.stringify(result).substring(0, 200),
    );
    res.status(200).json({ success: true, result });
  } catch (err) {
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
  const daysRemaining = Math.ceil(
    (new Date("2026-11-30").getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
  );

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
app.post("/api/jarvis/market-intel", express.json({ limit: "64kb" }), async (req, res) => {
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
    const anthropic = new Anthropic({ apiKey });
    const lastUpdated = new Date().toISOString();

    const response = await anthropic.messages.create({
      model: getHarveyModel(),
      max_tokens: 1500,
      tools: [{
        type: "web_search_20250305" as "custom",
        name: "web_search",
      } as Anthropic.Messages.Tool],
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
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    let marketData: Record<string, unknown>;
    try {
      const jsonMatch = fullText.match(/\{[\s\S]*\}/);
      marketData = jsonMatch
        ? (JSON.parse(jsonMatch[0]) as Record<string, unknown>)
        : { error: "Could not parse market data", raw: fullText.substring(0, 500) };
    } catch {
      marketData = { error: "Parse failed", raw: fullText.substring(0, 500) };
    }

    console.log("[MarketIntel] Data fetched successfully");
    res.json({ success: true, data: marketData, fetchedAt: new Date().toISOString() });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[MarketIntel] Error:", msg);
    res.status(500).json({ error: msg });
  }
});

/** Harvey world intel — Claude + web search (business-relevant events). */
app.post("/api/jarvis/world-intel", express.json({ limit: "64kb" }), async (req, res) => {
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
    const anthropic = new Anthropic({ apiKey });
    const lastUpdated = new Date().toISOString();

    const response = await anthropic.messages.create({
      model: getHarveyModel(),
      max_tokens: 2000,
      tools: [{
        type: "web_search_20250305" as "custom",
        name: "web_search",
      } as Anthropic.Messages.Tool],
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
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    console.log("[WorldIntel] Raw response length:", fullText.length);

    let worldData: Record<string, unknown>;
    try {
      const jsonMatch = fullText.match(/\{[\s\S]*\}/);
      worldData = jsonMatch
        ? (JSON.parse(jsonMatch[0]) as Record<string, unknown>)
        : {
            events: [],
            economicSummary: "Data unavailable",
            realEstateImpact: "Data unavailable",
            error: "Could not parse response",
          };
    } catch (parseErr) {
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
  } catch (err: unknown) {
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

async function runClaudeResearchJson(prompt: string): Promise<Record<string, unknown>> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: getHarveyModel(),
    max_tokens: 2500,
    tools: [{
      type: "web_search_20250305" as "custom",
      name: "web_search",
    } as Anthropic.Messages.Tool],
    messages: [{ role: "user", content: prompt }],
  });
  const fullText = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const jsonMatch = fullText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { error: "Could not parse research response", raw: fullText.substring(0, 500) };
  }
  return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
}

/** Harvey research report — Claude + web search on arbitrary topic. */
app.post("/api/jarvis/research-report", express.json({ limit: "64kb" }), async (req, res) => {
  console.log("[Research] Route hit — method:", req.method, "auth:", dashboardTokenOk(req));
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
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
  } catch (err: unknown) {
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
  } catch (err: unknown) {
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
  seedMarcoTasksIfEmpty();
  const tasks = sortMarcoTasks(getMarcoTasks());
  res.status(200).json({ tasks, summary: buildMarcoTasksSummary(tasks) });
});

app.post("/api/marco-tasks", express.json({ limit: "64kb" }), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    res.status(400).json({ error: "Missing title" });
    return;
  }
  const priority: MarcoTaskPriority =
    body.priority === "high" || body.priority === "medium" || body.priority === "low"
      ? body.priority
      : "medium";
  const status: MarcoTaskStatus =
    body.status === "pending" || body.status === "in_progress" || body.status === "done"
      ? body.status
      : "pending";
  const task = createMarcoTask({
    title,
    description: typeof body.description === "string" ? body.description : undefined,
    dueDate: typeof body.dueDate === "string" ? body.dueDate.slice(0, 10) : undefined,
    priority,
    status,
    createdBy: typeof body.createdBy === "string" ? body.createdBy : "carlos",
  });
  res.status(201).json({ task });
});

app.patch("/api/marco-tasks/:id", express.json({ limit: "64kb" }), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const updates: Partial<import("./core/types.js").MarcoTask> = {};
  if (typeof body.title === "string") updates.title = body.title.trim();
  if (typeof body.description === "string") updates.description = body.description;
  if (typeof body.dueDate === "string") updates.dueDate = body.dueDate.slice(0, 10);
  if (body.priority === "high" || body.priority === "medium" || body.priority === "low") {
    updates.priority = body.priority;
  }
  if (body.status === "pending" || body.status === "in_progress" || body.status === "done") {
    updates.status = body.status;
  }
  if (typeof body.createdBy === "string") updates.createdBy = body.createdBy;
  const task = updateMarcoTask(id, updates);
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
  const ok = deleteMarcoTask(id);
  res.status(ok ? 200 : 404).json({ success: ok });
});

app.post("/api/marco-tasks/:id/complete", express.json({ limit: "16kb" }), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const task = updateMarcoTask(id, { status: "done", completedAt: new Date().toISOString() });
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
  const notes = filterNotes({ category, leadId });
  res.status(200).json(notes);
});

app.get("/api/notes/search", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const q = typeof req.query.q === "string" ? req.query.q : "";
  res.status(200).json(searchNotes(q));
});

app.post("/api/notes", express.json({ limit: "256kb" }), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    res.status(400).json({ error: "Missing content" });
    return;
  }
  const category: HarveyNoteCategory =
    body.category === "general" ||
    body.category === "lead" ||
    body.category === "listing" ||
    body.category === "idea" ||
    body.category === "follow_up" ||
    body.category === "meeting"
      ? body.category
      : "general";
  const source =
    body.source === "voice" || body.source === "text" || body.source === "auto"
      ? body.source
      : "text";
  const note = createNote({
    content,
    title: typeof body.title === "string" ? body.title : undefined,
    category,
    leadId: typeof body.leadId === "string" ? body.leadId : undefined,
    leadName: typeof body.leadName === "string" ? body.leadName : undefined,
    tags: Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === "string")
      : undefined,
    source,
  });
  res.status(201).json(note);
});

app.patch("/api/notes/:id", express.json({ limit: "256kb" }), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const updates: Partial<import("./core/types.js").HarveyNote> = {};
  if (typeof body.content === "string") updates.content = body.content.trim();
  if (typeof body.title === "string") updates.title = body.title;
  if (
    body.category === "general" ||
    body.category === "lead" ||
    body.category === "listing" ||
    body.category === "idea" ||
    body.category === "follow_up" ||
    body.category === "meeting"
  ) {
    updates.category = body.category;
  }
  if (typeof body.leadId === "string") updates.leadId = body.leadId;
  if (typeof body.leadName === "string") updates.leadName = body.leadName;
  const note = updateNote(id, updates);
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
  const ok = deleteNote(id);
  res.status(ok ? 200 : 404).json({ success: ok });
});

/** Harvey memory — full state snapshot. */
app.get("/api/jarvis/memory", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const db = getMemoryDb();
  const semantic = db
    .prepare("SELECT * FROM harvey_semantic WHERE superseded_by IS NULL ORDER BY weight DESC LIMIT 50")
    .all();
  const relational = db.prepare("SELECT * FROM harvey_relational ORDER BY weight DESC LIMIT 50").all();
  const procedural = db.prepare("SELECT * FROM harvey_procedural ORDER BY use_count DESC").all();
  const episodes = db.prepare("SELECT * FROM harvey_episodes ORDER BY timestamp DESC LIMIT 20").all();
  res.json({
    semantic,
    relational,
    procedural,
    episodes,
    stats: {
      semanticCount: semantic.length,
      relationalCount: relational.length,
      proceduralCount: procedural.length,
      episodeCount: episodes.length,
    },
  });
});

/** Harvey memory — semantic search. */
app.get("/api/jarvis/memory/search", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const results = retrieveMemories(q);
  res.json(results);
});

/** Harvey memory — add semantic fact. */
app.post("/api/jarvis/memory/add", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const fact = typeof req.body?.fact === "string" ? req.body.fact.trim() : "";
  const category = typeof req.body?.category === "string" ? req.body.category.trim() : "business";
  const tags = typeof req.body?.tags === "string" ? req.body.tags.trim() : "";
  const weight = typeof req.body?.weight === "number" ? req.body.weight : 1.0;
  if (!fact) {
    res.status(400).json({ error: "Missing fact" });
    return;
  }
  const db = getMemoryDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO harvey_semantic (id, fact, category, tags, confidence, access_count, last_accessed, created_at, weight)
     VALUES (?, ?, ?, ?, 1.0, 0, ?, ?, ?)`,
  ).run(id, fact, category, tags, now, now, weight);
  res.status(201).json({ id, fact, category, tags, weight });
});

/** Harvey memory — delete any memory row by id. */
app.delete("/api/jarvis/memory/:id", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const db = getMemoryDb();
  const tables = ["harvey_semantic", "harvey_relational", "harvey_procedural", "harvey_episodes"] as const;
  let deleted = false;
  for (const table of tables) {
    const result = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    if (result.changes > 0) deleted = true;
  }
  if (!deleted) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  res.status(200).json({ ok: true, id });
});

/** Gemini TTS — speak Claude text responses via REST. */
app.post("/api/jarvis/gemini-tts", express.json({ limit: "256kb" }), async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  console.log("[GeminiTTS] Request received, text length:", text.length);
  console.log("[GeminiTTS] GEMINI_API_KEY present:", !!process.env.GEMINI_API_KEY);

  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  if (!text) {
    res.status(400).json({ error: "Missing text" });
    return;
  }
  const key = geminiApiKey();
  if (!key) {
    res.status(500).json({ error: "GEMINI_API_KEY not configured" });
    return;
  }
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: "Charon" },
              },
            },
          },
        }),
      },
    );
    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
      error?: { message?: string };
    };
    console.log("[GeminiTTS] Gemini response status:", response.status);
    if (!response.ok) {
      const msg = data.error?.message || response.statusText || "Gemini TTS failed";
      console.log("[GeminiTTS] Response has audio:", false);
      res.status(502).json({ error: msg });
      return;
    }
    const audioBase64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    console.log("[GeminiTTS] Response has audio:", !!audioBase64);
    if (!audioBase64) {
      res.status(500).json({ error: "No audio returned" });
      return;
    }
    const audioBuffer = Buffer.from(audioBase64, "base64");
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(audioBuffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[jarvis/gemini-tts]", message);
    res.status(502).json({ error: message });
  }
});

const simulateCors = cors({
  origin: true,
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
});

const resetCors = cors({
  origin: true,
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
});

async function handleSimulateBody(body: unknown, res: express.Response): Promise<void> {
  try {
    const result = await handleWebhook(body);
    if (result.status === 400) {
      res.status(400).json({ error: "Invalid payload (need user_id, message, etc.)" });
      return;
    }
    res.status(200).json({ reply: result.reply ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
}

app.options("/simulate", simulateCors);
app.post("/simulate", express.json(), simulateCors, (req, res) => {
  void handleSimulateBody(req.body, res);
});

/** ManyChat External Request — same body/response as /simulate */
app.options("/webhook", simulateCors);
app.post("/webhook", express.json(), simulateCors, (req, res) => {
  void handleSimulateBody(req.body, res);
});


app.options("/reset", resetCors);
app.post("/reset", resetCors, (_req, res) => {
  resetMemoryStore();
  res.status(200).json({ ok: true, message: "In-memory store cleared." });
});

app.post("/sinch/inbound", express.json(), async (req, res) => {
  try {
    const payload = receiveInbound(req.body);
    if (!payload) {
      res.status(400).json({ error: "Invalid or unparseable Sinch inbound payload" });
      return;
    }
    const result = await handleIncomingPayload(payload);
    res.status(result.status).json({
      ok: result.status === 200,
      reply: result.reply ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Sinch] /sinch/inbound error:", err);
    res.status(500).json({ error: message });
  }
});

/** Twilio inbound SMS — configure in Twilio Console → phone number → Messaging webhook. */
app.post("/webhook/twilio", express.urlencoded({ extended: false }), async (req, res) => {
  const inboundReceivedAt = Date.now();
  try {
    const signature = req.get("x-twilio-signature") ?? "";
    const protocol = req.get("x-forwarded-proto") || req.protocol;
    const url = `${protocol}://${req.get("host")}${req.originalUrl}`;

    if (signature && !validateTwilioSignature(signature, url, req.body as Record<string, unknown>)) {
      console.warn("[Twilio Webhook] Invalid signature — rejecting");
      res.status(403).send("Invalid signature");
      return;
    }

    const messageSid = typeof req.body?.MessageSid === "string" ? req.body.MessageSid.trim() : "";
    const from = typeof req.body?.From === "string" ? req.body.From.trim() : "";
    const message = typeof req.body?.Body === "string" ? req.body.Body.trim() : "";

    console.log("[Twilio Webhook] Inbound from", from, "- body:", message.substring(0, 100));

    if (messageSid && (isMessageHandleSeen(messageSid) || !claimTwilioInboundSid(messageSid))) {
      console.log("[Twilio Webhook] Duplicate message, ignoring:", messageSid);
      res.status(200).send("");
      return;
    }

    if (!from) {
      res.status(200).send("");
      return;
    }

    const inspectionConfirmation = checkInspectionConfirmation(from, message);
    if (inspectionConfirmation.handled && inspectionConfirmation.replyMessage?.trim()) {
      const replyText = inspectionConfirmation.replyMessage.trim();
      if (isTwilioConfigured()) {
        const send = await sendTwilioMessage({ to: from, content: replyText });
        if (!send.success) {
          console.error("[Twilio] inspection confirmation reply failed:", send.error);
        } else {
          console.log(
            "[InspectionFlow] Confirmation reply sent to",
            inspectionConfirmation.role,
            "for tx",
            inspectionConfirmation.transactionId,
          );
        }
      }
      const latencyMs = Date.now() - inboundReceivedAt;
      console.log("[InboundSMS] Reply latency:", latencyMs, "ms (inspection confirmation)");
      res.status(200).send("");
      return;
    }

    const lead = await findLeadByPhoneDigits(from);
    if (!lead) {
      console.warn("[Twilio] inbound from unknown phone:", from);
      res.status(200).send("");
      return;
    }

    const inboundSentAt = new Date().toISOString();
    const inboundSmsId = logSmsIfNew({
      leadId: lead.id,
      messageBody: message,
      direction: "inbound",
      sentAt: inboundSentAt,
      messageHandle: messageSid || undefined,
      threadType: "general",
    });

    const firstName = getLeadFirstName(lead);
    if (firstName) {
      console.log("[InboundSMS] Lead", lead.id, "first name available for greeting:", firstName);
    }

    const confirmationResult = await checkShowingConfirmation(lead, message);
    if (confirmationResult.handled && confirmationResult.replyMessage.trim()) {
      const replyText = confirmationResult.replyMessage.trim();
      if (message) {
        await appendMessage(lead.id, "user", message);
      }
      if (isTwilioConfigured() && lead.phone) {
        const send = await sendTwilioMessage({ to: lead.phone, content: replyText });
        if (!send.success) {
          console.error("[Twilio] showing confirmation reply failed:", send.error);
        } else {
          const replySentAt = new Date().toISOString();
          logSmsMessage({
            leadId: lead.id,
            messageBody: replyText,
            direction: "outbound",
            sentAt: replySentAt,
            threadType: "showing_reminder",
            messageHandle: send.messageSid,
          });
          if (inboundSmsId) markRepliedAt(inboundSmsId, replySentAt);
          await appendMessage(lead.id, "assistant", replyText);
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

    await checkPostShowingFeedback(lead, message);

    let activeLead = (await getLeadById(lead.id)) ?? lead;

    if (
      isMojoLead(activeLead) &&
      activeLead.mojoOutreach &&
      (activeLead.mojoOutreach.status === "active" || activeLead.mojoOutreach.status === "paused")
    ) {
      await updateLeadCrmFields({
        leadId: activeLead.id,
        mojoOutreach: { ...activeLead.mojoOutreach, status: "replied" },
      });
      activeLead = (await getLeadById(activeLead.id)) ?? activeLead;
    }

    const escalation = detectConversationEscalation(message);
    if (escalation.triggered && escalation.type) {
      await updateLeadCrmFields({
        leadId: activeLead.id,
        automationPaused: true,
        automationPausedReason: escalation.type,
        automationPausedAt: new Date().toISOString(),
      });

      await notifyMarcoOfConversationEscalation(activeLead, escalation.type, message);

      if (
        escalation.type === "angry_client" &&
        escalation.holdMessage &&
        isTwilioConfigured() &&
        activeLead.phone
      ) {
        const holdText = escalation.holdMessage;
        const send = await sendTwilioMessage({ to: activeLead.phone, content: holdText });
        if (!send.success) {
          console.error("[ConvEscalation] empathy hold send failed:", send.error);
        } else {
          const holdSentAt = new Date().toISOString();
          logSmsMessage({
            leadId: activeLead.id,
            messageBody: holdText,
            direction: "outbound",
            sentAt: holdSentAt,
            threadType: "escalation_hold",
            messageHandle: send.messageSid,
          });
          if (inboundSmsId) markRepliedAt(inboundSmsId, holdSentAt);
        }
      }

      res.status(200).send("");
      return;
    }

    if (activeLead.automationPaused) {
      console.log(
        "[ConvEscalation] Lead",
        activeLead.id,
        "has paused automation (",
        activeLead.automationPausedReason,
        ") — message logged but no auto-reply",
      );
      res.status(200).send("");
      return;
    }

    const payload: IncomingWebhookPayload = {
      platform: activeLead.platform,
      userId: activeLead.userId,
      username: activeLead.username,
      displayName: activeLead.name,
      message,
      commentOrDm: "dm",
      marcoPreviousOutbound: null,
    };
    const requestId = newMarcoRequestId();
    const correlationId = marcoCorrelationId(payload.platform, payload.userId);
    const result = await handleIncomingPayload(payload, { requestId, correlationId });

    if (result.reply?.trim() && isTwilioConfigured()) {
      const replyText = result.reply.trim();
      const send = await sendTwilioMessage({ to: activeLead.phone!, content: replyText });
      if (!send.success) {
        console.error("[Twilio] outbound after pipeline failed:", send.error);
      } else {
        const replySentAt = new Date().toISOString();
        logSmsMessage({
          leadId: activeLead.id,
          messageBody: replyText,
          direction: "outbound",
          sentAt: replySentAt,
          threadType: "general",
          messageHandle: send.messageSid,
        });
        if (inboundSmsId) markRepliedAt(inboundSmsId, replySentAt);
      }
    }

    const latencyMs = Date.now() - inboundReceivedAt;
    console.log("[InboundSMS] Reply latency:", latencyMs, "ms for lead", activeLead.id);
    if (latencyMs > 60000) {
      console.warn("[InboundSMS] ⚠️ Reply exceeded 60s target:", latencyMs, "ms");
    }

    res.status(200).send("");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Twilio] /webhook/twilio error:", err);
    res.status(500).send(message);
  }
});

/** CRM / VA: outbound text via Twilio — pick a saved lead or send to a custom number. */
app.post("/api/sms/send", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  if (!isTwilioConfigured()) {
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
    let threadLeadId: string | null = null;

    if (leadId) {
      const lead = await getLeadById(leadId);
      if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
      }
      if (!lead.phone?.trim()) {
        res.status(400).json({ error: "Lead has no phone number" });
        return;
      }
      to = normalizeToUsE164(lead.phone);
      threadLeadId = lead.id;
    } else {
      to = normalizeToUsE164(toRaw);
      const digits = to.replace(/\D/g, "");
      if (digits.length < 10) {
        res.status(400).json({ error: "Invalid phone number" });
        return;
      }
      const matched = await findLeadByPhoneDigits(to);
      if (matched) threadLeadId = matched.id;
    }

    const send = await sendTwilioMessage({ to, content });
    if (!send.success) {
      res.status(502).json({ error: send.error });
      return;
    }
    if (threadLeadId) {
      await appendMessage(threadLeadId, "assistant", content);
      logSmsMessage({
        leadId: threadLeadId,
        messageBody: content,
        direction: "outbound",
        sentAt: new Date().toISOString(),
        threadType: "manual",
        messageHandle: send.messageSid,
      });
    }
    res.status(200).json({ success: true, messageSid: send.messageSid, threadAttached: Boolean(threadLeadId) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

function leadFirstName(lead: { name?: string | null; username?: string | null }): string {
  const raw = (lead.name || lead.username || "").trim();
  const first = raw.split(/\s+/)[0];
  return first || "there";
}

async function sendLeadText(
  leadId: string,
  content: string,
  threadType = "general",
): Promise<{ ok: boolean; error?: string }> {
  const lead = await getLeadById(leadId);
  if (!lead?.phone?.trim()) return { ok: false, error: "Lead has no phone number" };
  if (!isTwilioConfigured()) return { ok: false, error: "Twilio not configured" };
  const to = normalizeToUsE164(lead.phone);
  const send = await sendTwilioMessage({ to, content });
  if (!send.success) return { ok: false, error: send.error };
  await appendMessage(leadId, "assistant", content);
  logSmsMessage({
    leadId,
    messageBody: content,
    direction: "outbound",
    sentAt: new Date().toISOString(),
    threadType,
    messageHandle: send.messageSid,
  });
  return { ok: true };
}

/** Website visit — re-engagement automation when lead inactive 30+ days. */
app.post("/api/activity/website-visit", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const leadIdRaw = typeof req.body?.leadId === "string" ? req.body.leadId.trim() : "";
  const phoneRaw = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  const page = typeof req.body?.page === "string" ? req.body.page.trim() : "";
  let lead = leadIdRaw ? await getLeadById(leadIdRaw) : null;
  if (!lead && phoneRaw) lead = await findLeadByPhoneDigits(phoneRaw);
  if (!lead) {
    res.status(404).json({ error: "Lead not found", triggered: false });
    return;
  }
  const stamp = new Date().toISOString();
  try {
    const inactive = await isLeadInactive30Days(lead.id);
    if (!inactive) {
      await appendLeadActivity(
        lead.id,
        [
          {
            type: "web_visit",
            description: page ? `Visited page: ${page}` : "Website visit",
            timestamp: stamp,
          },
        ],
        { lastActivity: stamp },
      );
      res.status(200).json({ triggered: false, leadId: lead.id });
      return;
    }
    const reDesc =
      "Returned to your website after 30+ days — reach out to see if they are open to buying or selling";
    await appendLeadActivity(
      lead.id,
      [{ type: "re_engagement", description: reDesc, timestamp: stamp }],
      { lastActivity: stamp },
    );
    const first = leadFirstName(lead);
    const text = `Hey ${first}, just saw you were checking out some properties — are you still thinking about buying or selling?`;
    const sendResult = await sendLeadText(lead.id, text);
    await appendLeadActivity(
      lead.id,
      [
        {
          type: "text_sent",
          description: sendResult.ok
            ? "Auto re-engagement text sent"
            : `Re-engagement text queued (send failed: ${sendResult.error || "unknown"})`,
          timestamp: new Date().toISOString(),
        },
      ],
      { lastActivity: stamp },
    );
    const updated = await getLeadById(lead.id);
    if (updated) {
      const alerts = (typeof updated.alerts === "number" ? updated.alerts : 0) + 1;
      await updateLeadCrmFields({ leadId: lead.id, alerts });
    }
    res.status(200).json({ triggered: true, leadId: lead.id, textSent: sendResult.ok });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message, triggered: false });
  }
});

/** Seller listing status change — off-market outreach or active notification. */
app.post("/api/activity/listing-status-change", express.json(), async (req, res) => {
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
  const lead = await getLeadById(leadId);
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const stamp = new Date().toISOString();
  const displayName = lead.name || lead.username || lead.phone || "Lead";
  try {
    if (statusRaw === "off_market") {
      const first = leadFirstName(lead);
      const text =
        `Hey ${first}, I noticed your home is no longer active on the market. If you're open to interviewing a qualified realtor who works specifically in your area, I'd love to connect — no pressure at all.`;
      const emailNote = `[Pending email ${stamp.slice(0, 10)}] Off-market outreach — follow up by email`;
      const mergedNotes = lead.crmNotes ? `${lead.crmNotes}\n${emailNote}` : emailNote;
      await updateLeadCrmFields({
        leadId: lead.id,
        listingStatus: "off_market",
        crmNotes: mergedNotes,
      });
      const sendResult = await sendLeadText(lead.id, text);
      const activityEntries: LeadActivity[] = [
        { type: "listing_off_market", description: "Home went off market — auto outreach sent", timestamp: stamp },
        { type: "email_sent", description: "Pending email: off-market realtor outreach", timestamp: stamp },
      ];
      if (sendResult.ok) {
        activityEntries.push({ type: "text_sent", description: "Auto off-market text sent", timestamp: stamp });
      }
      await appendLeadActivity(lead.id, activityEntries, { lastActivity: stamp });
      res.status(200).json({ success: true, action: "off_market_outreach", textSent: sendResult.ok });
      return;
    }
    await updateLeadCrmFields({ leadId: lead.id, listingStatus: "active" });
    await appendLeadActivity(
      lead.id,
      [
        {
          type: "listing_active",
          description: `${displayName}'s home just went active on the market — Marco notified`,
          timestamp: stamp,
        },
      ],
      { lastActivity: stamp },
    );
    const refreshed = await getLeadById(lead.id);
    if (refreshed) {
      const alerts = (typeof refreshed.alerts === "number" ? refreshed.alerts : 0) + 1;
      await updateLeadCrmFields({ leadId: lead.id, alerts });
    }
    res.status(200).json({ success: true, action: "active_notification" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

function parseLeadFilterBody(body: Record<string, unknown>): LeadFilter {
  const filter: LeadFilter = {};
  if (body.intent === "buyer" || body.intent === "seller" || body.intent === "buyer_seller") {
    filter.intent = body.intent;
  }
  const arr = (key: string) => {
    const v = body[key];
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim());
    return out.length ? out : undefined;
  };
  filter.status = arr("status");
  filter.source = arr("source");
  filter.stage = arr("stage");
  filter.tags = arr("tags");
  if (typeof body.dateAddedFrom === "string" && body.dateAddedFrom.trim()) filter.dateAddedFrom = body.dateAddedFrom.trim();
  if (typeof body.dateAddedTo === "string" && body.dateAddedTo.trim()) filter.dateAddedTo = body.dateAddedTo.trim();
  if (typeof body.lastContactFrom === "string" && body.lastContactFrom.trim()) {
    filter.lastContactFrom = body.lastContactFrom.trim();
  }
  if (typeof body.lastContactTo === "string" && body.lastContactTo.trim()) filter.lastContactTo = body.lastContactTo.trim();
  if (typeof body.assignedUser === "string" && body.assignedUser.trim()) filter.assignedUser = body.assignedUser.trim();
  return filter;
}

app.post("/api/leads/filter", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  try {
    const filter = parseLeadFilterBody(body);
    const leads = await filterDashboardLeads(filter);
    res.status(200).json({ leads, filter });
  } catch (err) {
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
  res.status(200).json({ tagTemplates: getTagTemplates() });
});

app.post("/api/tag-templates", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
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
  const created = createTagTemplate(name, color);
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
  const ok = deleteTagTemplate(id);
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
  res.status(200).json({ users: getUsers() });
});

app.post("/api/users", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!name || !email) {
    res.status(400).json({ error: "Missing name or email" });
    return;
  }
  const role =
    body.role === "admin" || body.role === "agent" || body.role === "isa" || body.role === "custom"
      ? (body.role as UserRole)
      : "agent";
  const permissions =
    body.permissions && typeof body.permissions === "object"
      ? ({ ...ROLE_PERMISSIONS.custom, ...(body.permissions as UserPermissions) } as UserPermissions)
      : { ...ROLE_PERMISSIONS[role] };
  const assignedLeadIds = Array.isArray(body.assignedLeadIds)
    ? body.assignedLeadIds.filter((id): id is string => typeof id === "string")
    : undefined;
  const created = createUser({
    name,
    email,
    role,
    permissions,
    assignedLeadIds,
    active: body.active !== false,
    avatarInitials: typeof body.avatarInitials === "string" ? body.avatarInitials : undefined!,
    avatarColor: typeof body.avatarColor === "string" ? body.avatarColor : "#64748b",
  });
  res.status(201).json({ ok: true, user: created });
});

app.patch("/api/users/:id", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const updates: Partial<CRMUser> = {};
  if (typeof body.name === "string") updates.name = body.name;
  if (typeof body.email === "string") updates.email = body.email;
  if (body.role === "admin" || body.role === "agent" || body.role === "isa" || body.role === "custom") {
    updates.role = body.role;
  }
  if (body.permissions && typeof body.permissions === "object") {
    updates.permissions = body.permissions as UserPermissions;
  }
  if (Array.isArray(body.assignedLeadIds)) {
    updates.assignedLeadIds = body.assignedLeadIds.filter((x): x is string => typeof x === "string");
  }
  if (body.active !== undefined) updates.active = Boolean(body.active);
  if (typeof body.avatarColor === "string") updates.avatarColor = body.avatarColor;
  const updated = updateUser(id, updates);
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
  const ok = deleteUser(id);
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
  res.status(200).json({ plans: getAutoPlans() });
});

app.post("/api/auto-plans", express.json({ limit: "2mb" }), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name : "";
  if (!name.trim()) {
    res.status(400).json({ error: "Missing plan name" });
    return;
  }
  const plan = createAutoPlan({
    name,
    tag: typeof body.tag === "string" ? body.tag : "",
    steps: Array.isArray(body.steps) ? (body.steps as AutoPlan["steps"]) : [],
    active: body.active !== false,
  });
  res.status(201).json({ plan });
});

app.patch("/api/auto-plans/:id", express.json({ limit: "2mb" }), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const updates: Partial<AutoPlan> = {};
  if (typeof body.name === "string") updates.name = body.name;
  if (typeof body.tag === "string") updates.tag = body.tag;
  if (Array.isArray(body.steps)) updates.steps = body.steps as AutoPlan["steps"];
  if (typeof body.active === "boolean") updates.active = body.active;
  const plan = updateAutoPlan(id, updates);
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
  const ok = deleteAutoPlan(id);
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
  const plan = getAutoPlanById(planId);
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }
  const lead = await getLeadById(leadId);
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const existing = (lead.autoPlanEnrollments || []).filter((e) => e.planId !== planId);
  const enrollment: LeadAutoPlanEnrollment = {
    planId: plan.id,
    planName: plan.name,
    enrolledAt: new Date().toISOString(),
    currentStepIndex: 0,
    completedSteps: [],
    status: "active",
  };
  await updateLeadCrmFields({ leadId, autoPlanEnrollments: [...existing, enrollment] });
  res.status(200).json({ success: true, enrollment });
});

app.post("/api/auto-plans/unenroll/:leadId/:planId", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const leadId = String(req.params.leadId || "").trim();
  const planId = String(req.params.planId || "").trim();
  const lead = await getLeadById(leadId);
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const next = (lead.autoPlanEnrollments || []).filter((e) => e.planId !== planId);
  await updateLeadCrmFields({ leadId, autoPlanEnrollments: next });
  res.status(200).json({ success: true });
});

async function mutateAutoPlanEnrollment(
  leadId: string,
  planId: string,
  mutator: (enr: LeadAutoPlanEnrollment) => LeadAutoPlanEnrollment | null,
): Promise<LeadAutoPlanEnrollment | null> {
  const lead = await getLeadById(leadId);
  if (!lead) return null;
  let found: LeadAutoPlanEnrollment | null = null;
  const next = (lead.autoPlanEnrollments || []).flatMap((enr) => {
    if (enr.planId !== planId) return [enr];
    const updated = mutator(enr);
    if (updated) {
      found = updated;
      return [updated];
    }
    return [];
  });
  if (!found) return null;
  await updateLeadCrmFields({ leadId, autoPlanEnrollments: next });
  return found;
}

app.post("/api/auto-plans/enrollment/:leadId/:planId/pause", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const leadId = String(req.params.leadId || "").trim();
  const planId = String(req.params.planId || "").trim();
  const enr = await mutateAutoPlanEnrollment(leadId, planId, (e) =>
    e.status === "completed" ? e : { ...e, status: "paused" },
  );
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
  const enr = await mutateAutoPlanEnrollment(leadId, planId, (e) =>
    e.status === "completed" ? e : { ...e, status: "active" },
  );
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
  const plan = getAutoPlanById(planId);
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }
  const enr = await mutateAutoPlanEnrollment(leadId, planId, (e) => {
    const completed = new Set(e.completedSteps);
    const nextStep = plan.steps.find((s) => !completed.has(s.id));
    if (!nextStep) return e;
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
export async function executeDueAutoPlanSteps(): Promise<{ processed: number; stepsExecuted: number }> {
  const plans = getAutoPlans();
  const planById = new Map(plans.map((p) => [p.id, p]));
  const leads = await listAllLeads();
  const now = Date.now();
  let processed = 0;
  let stepsExecuted = 0;

  for (const lead of leads) {
    const enrollments = lead.autoPlanEnrollments || [];
    if (!enrollments.length) continue;
    let changed = false;
    const newActivity: LeadActivity[] = [];
    const nextEnrollments: LeadAutoPlanEnrollment[] = [];

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
        if (completed.has(step.id)) continue;
        const dueMs = enrolledMs + step.dayOffset * 24 * 60 * 60 * 1000;
        if (dueMs > now) continue;
        const content = (step.content || "").replace(/\[name\]/g, first);
        const stamp = new Date().toISOString();
        if (step.type === "text") {
          await sendLeadText(lead.id, content);
          newActivity.push({ type: "text_sent", description: `Auto Plan text: ${content}`, timestamp: stamp });
        } else if (step.type === "email") {
          const subj = step.subject ? `${step.subject} — ` : "";
          newActivity.push({
            type: "email_pending",
            description: `Auto Plan email (pending): ${subj}${content}`,
            timestamp: stamp,
          });
        } else {
          const who = step.assignedTo || "Marco Puga";
          const dueDate = stamp.slice(0, 10);
          createTask({
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
      await updateLeadCrmFields({
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/* ===================== Tasks ===================== */

const TASK_PRIORITIES = new Set<TaskPriority>(["low", "normal", "high", "urgent"]);
const TASK_STATUSES = new Set<TaskStatus>(["pending", "in_progress", "completed", "cancelled"]);
const TASK_TYPES = new Set<TaskType>(["call", "text", "email", "appointment", "follow_up", "other"]);
const TASK_SOURCES = new Set<TaskSource>(["manual", "auto_plan", "dial_session", "automation"]);

function taskUserCanDelete(req: express.Request): boolean {
  const userId = String(req.query.userId || (req.body as { userId?: string })?.userId || "").trim();
  if (!userId) return true;
  const u = getUserById(userId);
  return !!u?.permissions?.canDeleteTasks;
}

function normalizeTaskInput(body: Record<string, unknown>): Omit<Task, "id" | "createdAt" | "updatedAt"> | null {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const dueDate = typeof body.dueDate === "string" ? body.dueDate.slice(0, 10) : "";
  if (!title || !dueDate) return null;
  const priority = TASK_PRIORITIES.has(body.priority as TaskPriority)
    ? (body.priority as TaskPriority)
    : "normal";
  const status = TASK_STATUSES.has(body.status as TaskStatus) ? (body.status as TaskStatus) : "pending";
  const type = TASK_TYPES.has(body.type as TaskType) ? (body.type as TaskType) : "other";
  const source = TASK_SOURCES.has(body.source as TaskSource) ? (body.source as TaskSource) : "manual";
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

const COMMAND_COLUMNS = new Set<CommandTaskColumn>([
  "urgent",
  "today",
  "tomorrow",
  "this_week",
  "this_month",
]);
const COMMAND_COLORS = new Set<CommandTaskColor>([
  "red",
  "amber",
  "green",
  "blue",
  "purple",
  "gray",
]);
const COMMAND_INTERVALS = new Set<CommandTaskRecurringInterval>([
  "daily",
  "every_3_days",
  "every_5_days",
  "weekly",
  "monthly",
]);

function parseRecurringInterval(raw: unknown): CommandTaskRecurringInterval | undefined {
  return typeof raw === "string" && COMMAND_INTERVALS.has(raw as CommandTaskRecurringInterval)
    ? (raw as CommandTaskRecurringInterval)
    : undefined;
}

function commandTaskCounts() {
  const all = getCommandTasks();
  const pending = all.filter((t) => t.status === "pending");
  return {
    urgent: pending.filter((t) => t.column === "urgent").length,
    today: pending.filter((t) => t.column === "today").length,
    tomorrow: pending.filter((t) => t.column === "tomorrow").length,
    this_week: pending.filter((t) => t.column === "this_week").length,
    this_month: pending.filter((t) => t.column === "this_month").length,
    total_pending: pending.length,
    total_done: all.filter((t) => t.status === "done").length,
  };
}

/** Carlos command-center task board (db.json). */
app.get("/api/tasks", (req, res) => {
  seedCommandTasksIfEmpty();
  let tasks = getCommandTasks();
  const column = typeof req.query.column === "string" ? req.query.column : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const assignedTo = typeof req.query.assignedTo === "string" ? req.query.assignedTo : undefined;

  if (column && COMMAND_COLUMNS.has(column as CommandTaskColumn)) {
    tasks = tasks.filter((t) => t.column === column);
  }
  if (status && status !== "both") {
    tasks = tasks.filter((t) => t.status === status);
  }
  if (assignedTo) {
    tasks = tasks.filter((t) => t.assignedTo === assignedTo);
  }

  tasks.sort((a, b) => {
    if (a.status === "pending" && b.status === "done") return -1;
    if (a.status === "done" && b.status === "pending") return 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  res.json({ tasks, counts: commandTaskCounts() });
});

app.post("/api/tasks", express.json({ limit: "1mb" }), (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const column = typeof body.column === "string" ? body.column : "";
  if (!title || !column) {
    res.status(400).json({ error: "title and column are required" });
    return;
  }
  if (!COMMAND_COLUMNS.has(column as CommandTaskColumn)) {
    res.status(400).json({ error: "Invalid column" });
    return;
  }
  const color = COMMAND_COLORS.has(body.color as CommandTaskColor)
    ? (body.color as CommandTaskColor)
    : "blue";
  const task = createCommandTask({
    title,
    description: typeof body.description === "string" ? body.description : undefined,
    column: column as CommandTaskColumn,
    status: "pending",
    color,
    recurring: body.recurring === true,
    recurringInterval: parseRecurringInterval(body.recurringInterval),
    assignedTo: typeof body.assignedTo === "string" ? body.assignedTo : "carlos",
    dueDate: typeof body.dueDate === "string" ? body.dueDate.slice(0, 10) : undefined,
    tags: Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === "string")
      : undefined,
    createdBy: typeof body.createdBy === "string" ? body.createdBy : "carlos",
  });
  console.log("[Tasks] Created:", task.title, "column:", task.column);
  res.json({ task });
});

app.patch("/api/tasks/:id", express.json({ limit: "1mb" }), (req, res) => {
  const id = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Partial<CommandTask>;
  const updates: Partial<CommandTask> = {};
  if (typeof body.title === "string") updates.title = body.title.trim();
  if (typeof body.description === "string") updates.description = body.description;
  if (body.column && COMMAND_COLUMNS.has(body.column)) updates.column = body.column;
  if (body.status === "pending" || body.status === "done") updates.status = body.status;
  if (body.color && COMMAND_COLORS.has(body.color)) updates.color = body.color;
  if (typeof body.recurring === "boolean") updates.recurring = body.recurring;
  const recurringInterval = parseRecurringInterval(body.recurringInterval);
  if (recurringInterval) {
    updates.recurringInterval = recurringInterval;
  }
  if (typeof body.assignedTo === "string") updates.assignedTo = body.assignedTo;
  if (typeof body.dueDate === "string") updates.dueDate = body.dueDate.slice(0, 10);
  if (Array.isArray(body.tags)) {
    updates.tags = body.tags.filter((t): t is string => typeof t === "string");
  }
  const task = updateCommandTask(id, updates);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  console.log("[Tasks] Updated:", task.title, "status:", task.status, "column:", task.column);
  res.json({ task });
});

app.delete("/api/tasks/:id", (req, res) => {
  const id = String(req.params.id || "").trim();
  const deleted = deleteCommandTask(id);
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
    tasks: filterTasks({ status, assignedUserId, leadId, dueDate }),
    summary: buildTasksSummary(),
  });
});

app.post("/api/crm-tasks", express.json({ limit: "1mb" }), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const data = normalizeTaskInput(body);
  if (!data) {
    res.status(400).json({ error: "Missing title or dueDate" });
    return;
  }
  const task = createTask(data);
  res.status(201).json({ task });
});

app.patch("/api/crm-tasks/:id", express.json({ limit: "1mb" }), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const updates: Partial<Task> = {};
  if (typeof body.title === "string") updates.title = body.title.trim();
  if (typeof body.description === "string") updates.description = body.description;
  if (typeof body.dueDate === "string") updates.dueDate = body.dueDate.slice(0, 10);
  if (typeof body.dueTime === "string") updates.dueTime = body.dueTime;
  if (TASK_PRIORITIES.has(body.priority as TaskPriority)) updates.priority = body.priority as TaskPriority;
  if (TASK_STATUSES.has(body.status as TaskStatus)) updates.status = body.status as TaskStatus;
  if (TASK_TYPES.has(body.type as TaskType)) updates.type = body.type as TaskType;
  if (typeof body.leadId === "string") updates.leadId = body.leadId.trim() || undefined;
  if (typeof body.leadName === "string") updates.leadName = body.leadName;
  if (typeof body.assignedUserId === "string") updates.assignedUserId = body.assignedUserId;
  if (typeof body.assignedUserName === "string") updates.assignedUserName = body.assignedUserName;
  if (typeof body.reminderMinutes === "number") updates.reminderMinutes = body.reminderMinutes;
  const task = updateTask(id, updates);
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
  const existing = getTaskById(id);
  if (!existing) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (!taskUserCanDelete(req)) {
    res.status(403).json({ error: "You do not have permission to delete tasks" });
    return;
  }
  const ok = deleteTask(id);
  res.status(ok ? 200 : 404).json({ success: ok });
});

app.post("/api/crm-tasks/:id/complete", express.json({ limit: "256kb" }), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const completedBy = typeof body.completedBy === "string" ? body.completedBy : "CRM";
  const task = updateTask(id, {
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

const DEAL_STATUSES_SET = new Set<string>([
  "prospect",
  "active",
  "under_contract",
  "closed",
  "fallen_through",
]);
const DEAL_TYPES_SET = new Set<string>(["buyer", "seller", "referral", "investor"]);

function parseDealBody(body: Record<string, unknown>): Partial<Deal> {
  const out: Partial<Deal> = {};
  if (typeof body.leadId === "string") out.leadId = body.leadId.trim() || undefined;
  if (typeof body.leadName === "string") out.leadName = body.leadName.trim();
  if (typeof body.phone === "string") out.phone = body.phone;
  if (typeof body.email === "string") out.email = body.email;
  if (typeof body.propertyAddress === "string") out.propertyAddress = body.propertyAddress.trim();
  if (typeof body.dealType === "string" && DEAL_TYPES_SET.has(body.dealType)) out.dealType = body.dealType as DealType;
  if (typeof body.status === "string" && DEAL_STATUSES_SET.has(body.status)) out.status = body.status as DealStatus;
  if (typeof body.salePrice === "number") out.salePrice = body.salePrice;
  else if (typeof body.salePrice === "string" && body.salePrice.trim()) {
    const n = Number(String(body.salePrice).replace(/,/g, ""));
    if (Number.isFinite(n)) out.salePrice = n;
  }
  if (typeof body.commissionPercent === "number") out.commissionPercent = body.commissionPercent;
  if (typeof body.closeDate === "string") out.closeDate = body.closeDate;
  if (typeof body.openedDate === "string") out.openedDate = body.openedDate;
  if (typeof body.closedDate === "string") out.closedDate = body.closedDate;
  if (typeof body.assignedTo === "string") out.assignedTo = body.assignedTo;
  if (typeof body.notes === "string") out.notes = body.notes;
  if (body.documents !== undefined) out.documents = body.documents as Deal["documents"];
  return out;
}

app.get("/api/deals", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.status(200).json({ deals: getDeals() });
});

app.get("/api/deals/by-lead/:leadId", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const leadId = String(req.params.leadId || "").trim();
  res.status(200).json({ deals: getDealsByLeadId(leadId) });
});

app.get("/api/deals/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const deal = getDealById(String(req.params.id || "").trim());
  if (!deal) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }
  res.status(200).json({ deal });
});

app.post("/api/deals", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const parsed = parseDealBody(body);
  if (!parsed.leadName || !parsed.propertyAddress) {
    res.status(400).json({ error: "leadName and propertyAddress required" });
    return;
  }
  const commissionPercent = parsed.commissionPercent ?? 3;
  const salePrice = parsed.salePrice;
  const deal = createDeal({
    leadId: parsed.leadId,
    leadName: parsed.leadName,
    phone: parsed.phone,
    email: parsed.email,
    propertyAddress: parsed.propertyAddress,
    dealType: parsed.dealType ?? "buyer",
    status: parsed.status ?? "prospect",
    salePrice,
    commissionPercent,
    estimatedGCI: salePrice !== undefined ? calculateGCI(salePrice, commissionPercent) : undefined,
    closeDate: parsed.closeDate,
    openedDate: parsed.openedDate ?? new Date().toISOString(),
    closedDate: parsed.closedDate,
    assignedTo: parsed.assignedTo,
    notes: parsed.notes,
    documents: parsed.documents,
  });
  res.status(201).json({ deal });
});

app.patch("/api/deals/:id", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const updated = updateDeal(id, parseDealBody(body));
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
  const ok = deleteDeal(String(req.params.id || "").trim());
  if (!ok) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }
  res.status(200).json({ ok: true });
});

/* ===================== Transactions (SQLite) ===================== */

function parseTransactionBody(body: Record<string, unknown>): Partial<Transaction> {
  const out: Partial<Transaction> = {};
  if (typeof body.address === "string") out.address = body.address.trim();
  if (typeof body.dealType === "string") out.dealType = body.dealType as Transaction["dealType"];
  if (body.parties && typeof body.parties === "object" && !Array.isArray(body.parties)) {
    out.parties = body.parties as Transaction["parties"];
  }
  if (typeof body.price === "number") out.price = body.price;
  if (typeof body.status === "string") out.status = body.status as Transaction["status"];
  if (typeof body.contractDate === "string") out.contractDate = body.contractDate;
  if (typeof body.inspectionDate === "string") out.inspectionDate = body.inspectionDate;
  if (typeof body.appraisalDate === "string") out.appraisalDate = body.appraisalDate;
  if (typeof body.loanCommitmentDate === "string") out.loanCommitmentDate = body.loanCommitmentDate;
  if (typeof body.titleDate === "string") out.titleDate = body.titleDate;
  if (typeof body.closingDate === "string") out.closingDate = body.closingDate;
  if (typeof body.possessionDate === "string") out.possessionDate = body.possessionDate;
  if (typeof body.leadId === "string") out.leadId = body.leadId.trim() || undefined;
  if (typeof body.dealFileUrl === "string") out.dealFileUrl = body.dealFileUrl;
  if (typeof body.notes === "string") out.notes = body.notes;
  return out;
}

app.get("/api/transactions", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json({ transactions: getAllTransactions(status) });
});

app.post("/api/transactions", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const parsed = parseTransactionBody(body);
  const address = parsed.address || "";
  const dealType = parsed.dealType || "buyer";
  const status = parsed.status || "active";
  if (!address) {
    res.status(400).json({ error: "address required" });
    return;
  }
  const tx = createTransaction({
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
  const tx = getTransaction(id);
  if (!tx) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({
    transaction: tx,
    deadlines: getDeadlinesForDeal(id),
    documents: getDocumentsForDeal(id),
  });
});

app.patch("/api/transactions/:id", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const tx = updateTransaction(id, parseTransactionBody(body));
  if (!tx) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ transaction: tx });
});

app.delete("/api/transactions/:id", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const success = deleteTransaction(String(req.params.id || "").trim());
  res.json({ success });
});

app.post("/api/transactions/migrate-from-deals", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const deals = readLegacyDealsJson();
  if (!deals.length) {
    res.json({ migrated: 0, skipped: 0, message: "No deals.json found or empty" });
    return;
  }
  const result = migrateFromDealsJson(deals);
  res.json(result);
});

app.post("/api/transactions/:id/open-deal", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const tx = getTransaction(id);
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }

  const updated =
    updateTransaction(id, {
      status: tx.status === "active" ? "under_contract" : tx.status,
    }) ?? tx;

  const deadlines = generateFullDeadlineTimeline(updated);

  const standardDocTypes: DocumentType[] =
    updated.dealType === "seller" || updated.dealType === "dual"
      ? ["listing_agreement", "disclosure", "offer"]
      : ["buyer_rep", "offer", "disclosure"];

  const existingDocs = getDocumentsForDeal(id);
  const existingDocTypes = new Set(existingDocs.map((d) => d.documentType));
  const documentsCreated: TransactionDocument[] = [];

  for (const docType of standardDocTypes) {
    if (existingDocTypes.has(docType)) continue;
    const doc = createDocument({ dealId: id, documentType: docType, status: "pending", parties: [] });
    documentsCreated.push(doc);
  }

  console.log(
    "[Transactions] Deal opened:",
    updated.address,
    "-",
    deadlines.length,
    "new deadlines,",
    documentsCreated.length,
    "documents",
  );

  res.json({
    transaction: updated,
    timeline: getDeadlinesForDeal(id),
    documents: getDocumentsForDeal(id),
  });
});

app.post("/api/transactions/:id/inspection/schedule", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const tx = getTransaction(id);
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }

  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const inspectorName = typeof body.inspectorName === "string" ? body.inspectorName.trim() : undefined;
  const inspectorPhone = typeof body.inspectorPhone === "string" ? body.inspectorPhone.trim() : undefined;
  const scheduledAt = typeof body.scheduledAt === "string" ? body.scheduledAt.trim() : "";
  if (!scheduledAt) {
    res.status(400).json({ error: "scheduledAt required" });
    return;
  }

  const inspectionFlow: InspectionFlow = {
    ...tx.inspectionFlow,
    inspectorName,
    inspectorPhone,
    scheduledAt,
    scheduleConfirmedParties: [],
  };
  updateTransaction(id, { inspectionFlow });

  const scheduledTimeStr = new Date(scheduledAt).toLocaleString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
  });

  const contacts: Array<{ role: string; phone?: string }> = [
    { role: "buyer", phone: tx.parties.buyerPhone },
    { role: "seller", phone: tx.parties.sellerPhone },
    { role: "buyer_agent", phone: tx.parties.buyerAgentPhone },
    { role: "seller_agent", phone: tx.parties.sellerAgentPhone },
    { role: "inspector", phone: inspectorPhone },
  ];

  let notified = 0;
  for (const contact of contacts) {
    if (!contact.phone?.trim()) continue;
    const message = `Inspection scheduled for ${tx.address} on ${scheduledTimeStr}. Reply YES to confirm.`;
    const result = await sendTwilioMessage(contact.phone, message);
    if (result.success) notified++;
  }

  console.log("[InspectionFlow] Scheduled for", tx.address, "- notified", notified, "parties");
  res.json({ transaction: getTransaction(id), notified });
});

app.post("/api/transactions/:id/inspection/report-received", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const tx = getTransaction(id);
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }

  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const reportSummary = typeof body.reportSummary === "string" ? body.reportSummary : undefined;
  const requestedRepairs = Array.isArray(body.requestedRepairs)
    ? (body.requestedRepairs as string[])
    : undefined;

  const now = new Date().toISOString();
  const optionDeadline = getDeadlinesForDeal(id).find((d) => d.deadlineType === "option_period");
  const sellerResponseDeadline =
    optionDeadline?.dueDate || new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

  const inspectionFlow: InspectionFlow = {
    ...tx.inspectionFlow,
    reportReceivedAt: now,
    repairRequestDraftedAt: now,
    sellerResponseDeadline,
    sellerResponseStatus: "pending",
  };
  updateTransaction(id, { inspectionFlow });

  createDeadline({
    dealId: id,
    deadlineType: "custom",
    label: "Seller Response to Repair Request",
    dueDate: sellerResponseDeadline,
  });

  console.log(
    "[InspectionFlow] Report received, repair request drafted for",
    tx.address,
    "- seller response due",
    sellerResponseDeadline,
  );

  res.json({
    transaction: getTransaction(id),
    draftedRepairRequest: {
      summary: reportSummary,
      requestedRepairs: requestedRepairs || [],
      sellerResponseDeadline,
      note: "Repair request DRAFTED — Marco must review and send manually. This system does not auto-send repair requests.",
    },
  });
});

app.post("/api/transactions/:id/inspection/repair-request-sent", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const tx = getTransaction(id);
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }

  updateTransaction(id, {
    inspectionFlow: { ...tx.inspectionFlow, repairRequestSentAt: new Date().toISOString() },
  });
  res.json({ transaction: getTransaction(id) });
});

app.post("/api/transactions/:id/final-week/walkthrough", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const tx = getTransaction(id);
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }

  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const scheduledAt = typeof body.scheduledAt === "string" ? body.scheduledAt.trim() : "";
  if (!scheduledAt) {
    res.status(400).json({ error: "scheduledAt required" });
    return;
  }

  const finalWeekFlow: FinalWeekFlow = {
    ...tx.finalWeekFlow,
    walkthroughScheduledAt: scheduledAt,
  };
  updateTransaction(id, { finalWeekFlow });

  const timeStr = new Date(scheduledAt).toLocaleString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
  });

  if (tx.parties.buyerPhone) {
    await sendTwilioMessage(
      tx.parties.buyerPhone,
      `Final walkthrough for ${tx.address} scheduled for ${timeStr}. Reply YES to confirm.`,
    );
  }

  res.json({ transaction: getTransaction(id) });
});

app.post("/api/transactions/:id/final-week/wire-confirmed", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const tx = getTransaction(id);
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }

  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const confirmedBy = typeof body.confirmedBy === "string" ? body.confirmedBy : "manual";

  const finalWeekFlow: FinalWeekFlow = {
    ...tx.finalWeekFlow,
    wireInstructionsConfirmedAt: new Date().toISOString(),
    wireInstructionsConfirmedBy: confirmedBy,
  };
  updateTransaction(id, { finalWeekFlow });
  res.json({ transaction: getTransaction(id) });
});

const templateUpload = multer({
  dest: resolveTemplatesDir(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.post("/api/templates/upload", templateUpload.single("file"), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }

  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
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

  let fieldMapping: Record<string, string> = {};
  if (typeof body.fieldMapping === "string" && body.fieldMapping.trim()) {
    try {
      fieldMapping = JSON.parse(body.fieldMapping) as Record<string, string>;
    } catch {
      res.status(400).json({ error: "fieldMapping must be valid JSON" });
      return;
    }
  }

  const finalPath = path.join(
    resolveTemplatesDir(),
    `${req.file.filename}-${req.file.originalname}`,
  );
  fs.renameSync(req.file.path, finalPath);

  const template = createDocumentTemplate({
    templateType: templateType as TemplateType,
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
  const type = typeof req.query.type === "string" ? (req.query.type as TemplateType) : undefined;
  res.json({ templates: getAllTemplates(type) });
});

app.get("/api/templates/:id/fields", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const template = getTemplate(String(req.params.id || "").trim());
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  try {
    const fields = await inspectTemplatePdfFields(template.filePath);
    res.json({ fields });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      error: `Could not read PDF fields: ${msg}`,
      note: "Form may not have fillable AcroForm fields (scanned/flattened PDF) — manual mapping may not be possible.",
    });
  }
});

app.post("/api/transactions/:id/deadlines", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const dealId = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const deadlineType = typeof body.deadlineType === "string" ? body.deadlineType : "";
  const dueDate = typeof body.dueDate === "string" ? body.dueDate : "";
  if (!deadlineType || !dueDate) {
    res.status(400).json({ error: "deadlineType and dueDate required" });
    return;
  }
  const deadline = createDeadline({
    dealId,
    deadlineType: deadlineType as TransactionDeadline["deadlineType"],
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
  markDeadlineCompleted(String(req.params.id || "").trim());
  res.json({ success: true });
});

app.get("/api/deadlines/upcoming", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const days = parseInt(String(req.query.days || "7"), 10) || 7;
  res.json({ deadlines: getUpcomingDeadlines(days) });
});

app.get("/api/deadlines/overdue", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json({ deadlines: getOverdueDeadlines() });
});

app.post("/api/deadlines/check-now", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const result = await checkTransactionDeadlines();
  res.json(result);
});

app.post("/api/deadlines/daily-check-now", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const result = await runDailyTransactionWorkflowChecks();
  res.json(result);
});

app.post("/api/deadlines/close-day-check-now", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const result = await checkCloseDayTriggers();
  res.json(result);
});

app.post("/api/deadlines/check-ins-check-now", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const result = await checkScheduledClientCheckIns();
  res.json(result);
});

app.post("/api/deadlines/missed-check-now", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const result = await checkMissedSameDayDeadlines();
  res.json(result);
});

/* ===================== Lead scoring & nurture ===================== */

app.post("/api/lead-scoring/score-all", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const result = await scoreAllLeads();
  res.json(result);
});

app.post("/api/lead-scoring/score/:leadId", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const lead = await getLeadById(String(req.params.leadId || "").trim());
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const result = scoreAndRecordLead(lead);
  res.json(result);
});

app.get("/api/lead-scoring/:leadId", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const leadId = String(req.params.leadId || "").trim();
  res.json({
    latest: getLatestScore(leadId),
    history: getScoreHistory(leadId),
  });
});

app.get("/api/lead-scoring/tier/:tier", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const tier = String(req.params.tier || "").trim() as "hot" | "warm" | "cold";
  if (tier !== "hot" && tier !== "warm" && tier !== "cold") {
    res.status(400).json({ error: "tier must be hot, warm, or cold" });
    return;
  }
  res.json({ leads: getLeadsByTier(tier) });
});

app.post("/api/lead-scoring/rescore-cold-now", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const result = await scoreColdLeads();
  res.json(result);
});

app.post("/api/lead-nurture/warm-touch-now", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const result = await runWarmLeadWeeklyTouch();
  res.json(result);
});

app.post("/api/lead-nurture/cold-touch-now", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const result = await runColdLeadMonthlyTouch();
  res.json(result);
});

app.post("/api/lead-nurture/route/:leadId", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const lead = await getLeadById(String(req.params.leadId || "").trim());
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  await routeNewLead(lead);
  res.json({ success: true });
});

app.post("/api/transactions/:id/documents", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const dealId = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const documentType = typeof body.documentType === "string" ? body.documentType : "other";
  const status = typeof body.status === "string" ? body.status : "pending";
  const doc = createDocument({
    dealId,
    documentType: documentType as TransactionDocument["documentType"],
    status: status as TransactionDocument["status"],
    parties: Array.isArray(body.parties) ? (body.parties as string[]) : undefined,
    signedAt: typeof body.signedAt === "string" ? body.signedAt : undefined,
    sentAt: typeof body.sentAt === "string" ? body.sentAt : undefined,
    documentUrl: typeof body.documentUrl === "string" ? body.documentUrl : undefined,
    notes: typeof body.notes === "string" ? body.notes : undefined,
  });
  res.json({ document: doc });
});

app.patch("/api/documents/:id", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const status = typeof body.status === "string" ? body.status : "pending";
  updateDocumentStatus(
    String(req.params.id || "").trim(),
    status as TransactionDocument["status"],
    typeof body.signedAt === "string" ? body.signedAt : undefined,
  );
  res.json({ success: true });
});

app.get("/api/documents/unsigned", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json({ documents: getUnsignedDocuments() });
});

app.get("/api/documents/needs-review", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json({ documents: getDocumentsNeedingReview() });
});

app.post("/api/transactions/:id/documents/:docId/auto-fill", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const txId = String(req.params.id || "").trim();
  const docId = String(req.params.docId || "").trim();
  const tx = getTransaction(txId);
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  const doc = getDocument(docId);
  if (!doc || doc.dealId !== txId) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const templateId = typeof body.templateId === "string" ? body.templateId.trim() : "";
  const template = getTemplate(templateId);
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const result = await fillDocumentTemplate(template, tx);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }

  const needsReview = result.missingFields.length > 0;
  flagDocumentForReview(docId, result.outputPath!, result.missingFields);

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

function dialOutcomeLabel(status: DialSessionLeadStatus): string {
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

async function logDialLeadActivity(dialLead: DialSessionLead, agentNotes?: string): Promise<void> {
  if (!dialLead.leadId) return;
  const outcome = dialOutcomeLabel(dialLead.status);
  const secs = typeof dialLead.duration === "number" ? dialLead.duration : 0;
  const desc = `Call made · ${outcome} · ${secs}s`;
  const entry: LeadActivity = {
    type: "call_made",
    description: desc,
    timestamp: dialLead.callEnded || new Date().toISOString(),
  };
  if (agentNotes?.trim()) entry.notes = agentNotes.trim();
  const existing = await getLeadById(dialLead.leadId);
  if (!existing) return;
  const bumpAlert = dialLead.status === "no_answer" || dialLead.status === "voicemail";
  const nextAlerts = bumpAlert ? (existing.alerts || 0) + 1 : existing.alerts;
  await appendLeadActivity(dialLead.leadId, [entry]);
  if (bumpAlert && nextAlerts !== undefined) {
    await updateLeadCrmFields({ leadId: dialLead.leadId, alerts: nextAlerts });
  }
}

app.post("/api/dial/start", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const leadIds = Array.isArray(body.leadIds)
    ? body.leadIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  if (!leadIds.length) {
    res.status(400).json({ error: "leadIds required" });
    return;
  }
  clearDialSession();
  const dialLeads: DialSessionLead[] = [];
  for (const id of leadIds) {
    const lead = await getLeadById(id);
    if (!lead || !lead.phone?.trim()) continue;
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
  const session = createDialSession(dialLeads);
  res.status(201).json({ session });
});

app.get("/api/dial/session", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const session = getActiveDialSession();
  res.status(200).json({ session });
});

app.get("/api/dial/history", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.status(200).json({ sessions: getDialSessionHistory(5) });
});

app.post("/api/dial/next", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const session = getActiveDialSession();
  if (!session) {
    res.status(404).json({ error: "No active dial session" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const outcome = typeof body.outcome === "string" ? body.outcome : "answered";
  const notes = typeof body.notes === "string" ? body.notes : "";
  const duration =
    typeof body.duration === "number" && body.duration >= 0 ? Math.round(body.duration) : undefined;
  const prevIndex = session.currentIndex;
  const updated = advanceDialSession(outcome, { notes, duration });
  if (updated && prevIndex >= 0 && prevIndex < updated.leads.length) {
    await logDialLeadActivity(updated.leads[prevIndex], notes);
  }
  res.status(200).json({ session: updated });
});

app.post("/api/dial/skip", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const session = getActiveDialSession();
  if (!session) {
    res.status(404).json({ error: "No active dial session" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const notes = typeof body.notes === "string" ? body.notes : "";
  const prevIndex = session.currentIndex;
  const updated = advanceDialSession("skip", { notes });
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
  const session = pauseDialSession();
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
  const session = resumeDialSession();
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
  const session = getActiveDialSession();
  if (session) {
    const current = getCurrentDialLead(session);
    if (current && current.status === "calling") {
      const skipped: DialSessionLead = {
        ...current,
        status: "skipped",
        callEnded: new Date().toISOString(),
        outcome: "Session ended",
        duration: 0,
      };
      await logDialLeadActivity(skipped);
    }
    completeDialSession();
  }
  clearDialSession();
  res.status(200).json({ ok: true });
});

/* ===================== Call assistant ===================== */

app.post("/api/call-assistant/suggest", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const leadId = typeof body.leadId === "string" ? body.leadId.trim() : "";
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const context = typeof body.context === "string" ? body.context : "";
  if (!leadId || !question) {
    res.status(400).json({ error: "leadId and question required" });
    return;
  }
  try {
    const result = await runCallAssistantSuggest({ leadId, question, context });
    res.status(200).json(result);
  } catch (err) {
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
    for await (const word of streamCallAssistantWords({ leadId, question, context })) {
      res.write(`data: ${JSON.stringify({ word })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  }
  res.end();
});

/* ===================== Digital signing documents ===================== */

function genDocId(): string {
  return "doc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

app.post("/api/leads/:id/skip-trace", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const leadId = String(req.params.id || "").trim();
  const lead = await getLeadById(leadId);
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  if (!lead.phone?.trim()) {
    res.status(400).json({ error: "Lead has no phone number" });
    return;
  }
  const result = await runSkipTrace(lead.phone.trim());
  const history = [...(lead.skipTraceResults || []), result];
  const updates: Parameters<typeof updateLeadCrmFields>[0] = {
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
  const activityEntry: LeadActivity = {
    type: "skip_trace",
    description: `Skip trace run via ${result.source} — confidence: ${result.confidence || "unknown"}`,
    timestamp: result.runAt,
  };
  await appendLeadActivity(leadId, [activityEntry]);
  const updated = await updateLeadCrmFields(updates);
  res.status(200).json({ result, lead: updated });
});

app.get("/api/leads/:id/documents", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const lead = await getLeadById(String(req.params.id || "").trim());
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  res.status(200).json({ documents: lead.documents || [] });
});

app.post("/api/leads/:id/documents/send", express.json({ limit: "20mb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const leadId = String(req.params.id || "").trim();
  const lead = await getLeadById(leadId);
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "Missing document name" });
    return;
  }
  const now = new Date().toISOString();
  const doc: SigningDocument = {
    id: genDocId(),
    name,
    fileData: typeof body.fileData === "string" ? body.fileData : "",
    status: "sent",
    sentAt: now,
    signerEmail: typeof body.signerEmail === "string" ? body.signerEmail : undefined,
    signerName: typeof body.signerName === "string" ? body.signerName : undefined,
  };
  const documents = [...(lead.documents || []), doc];
  await updateLeadCrmFields({ leadId, documents });
  res.status(201).json({ document: doc });
});

app.post("/api/leads/:id/documents/:docId/sign", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const leadId = String(req.params.id || "").trim();
  const docId = String(req.params.docId || "").trim();
  const lead = await getLeadById(leadId);
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const documents = (lead.documents || []).map((d) =>
    d.id === docId ? { ...d, status: "signed" as const, signedAt: new Date().toISOString() } : d,
  );
  if (!documents.some((d) => d.id === docId)) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  await updateLeadCrmFields({ leadId, documents });
  res.status(200).json({ document: documents.find((d) => d.id === docId) });
});

/** Serve other public assets (CRM modules, etc.) after explicit routes. */
app.use(express.static(publicDir, { index: false }));

const httpServer = http.createServer(app);

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

scheduleContentJobs();

async function ensureSocialDataExists(): Promise<void> {
  try {
    if (!socialDataAvailable()) {
      console.log("[Social] No data found on startup — running initial agent pull");
      await runSocialMediaAgent();
    } else {
      const summary = getSocialSummaryForHarvey();
      const pulledAt = summary.pulledAt ?? summary.fetchedAt;
      console.log("[Social] Social data exists — last pull:", pulledAt);
    }
  } catch (err) {
    console.error("[Social] Startup check failed:", err);
  }
}

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on 0.0.0.0:${PORT}`);
  try {
    bootstrapMemory();
  } catch (err) {
    console.error("[Harvey Memory] Bootstrap failed:", err);
  }
  if (!geminiApiKey()) {
    console.warn("[Harvey] GEMINI_API_KEY not set — Gemini Live voice will not work");
  } else {
    console.log("[Harvey] GEMINI_API_KEY configured — Gemini Live voice ready");
  }
  if (isAnthropicApiKeyConfigured()) {
    console.log(`[Anthropic] API key present — model ${getAnthropicModel()} (set ANTHROPIC_MODEL to override).`);
  } else {
    console.warn(
      "[Anthropic] ANTHROPIC_API_KEY missing — preflight/opening/pipeline skip Haiku and use template fallbacks only.",
    );
  }
  console.log(`Health:  GET  http://localhost:${PORT}/health`);
  console.log(`Dashboard: GET http://localhost:${PORT}/ (also /dashboard)`);
  console.log(`Social:    GET http://localhost:${PORT}/social`);
  console.log(`Chat demo: GET http://localhost:${PORT}/chat`);
  console.log(`Harvey:  GET  http://localhost:${PORT}/jarvis`);
  console.log(`Harvey ops: GET http://localhost:${PORT}/api/jarvis/ops`);
  console.log(`Harvey chat: POST http://localhost:${PORT}/api/jarvis/chat (model ${getHarveyModel()})`);
  console.log(`Harvey voice: POST http://localhost:${PORT}/api/jarvis/gemini-live/token`);
  console.log(`Harvey TTS:   POST http://localhost:${PORT}/api/jarvis/gemini-tts`);
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

