/**
 * HTTP server: GET / lead dashboard, POST /webhook & /simulate → pipeline (CORS on simulate/webhook).
 */
import "dotenv/config";
import http from "http";
import type { IncomingMessage } from "http";
import { execSync, execFileSync } from "child_process";
import axios from "axios";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import os from "os";
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
import { scoreVideos } from "./integrations/apify/index.js";
import { claudeContent, CONTENT_MODELS } from "./integrations/claude-content.js";
import { runMorningScan, getLatestMorningScan } from "./agents/morningScan/index.js";
import { generateCommentReply } from "./agents/commentReply/index.js";
import { generateVideoImprovements } from "./agents/videoFeedback/index.js";
import {
  getTransitionsForContentType,
  getTopTransitionsForRealEstate,
  type ContentType,
} from "./agents/videoFeedback/transitions.js";
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
  getInboundDmCount,
} from "./core/db.js";
import {
  getAllNotifications,
  getUnreadNotifications,
  markNotificationRead,
} from "./core/crmNotificationStore.js";
import {
  initPush,
  getVapidPublicKey,
  addSubscription,
  removeSubscription,
} from "./core/pushStore.js";
import {
  initTeamStore,
  touchPresence,
  getPresence,
  addNotification,
  getNotifications,
  markNotificationsRead,
  addChatMessage,
  getChat,
  markChatRead,
  chatUnreadCounts,
} from "./core/teamStore.js";
import { listTeamMembers } from "./core/teamRoster.js";
import { publicShell, renderPublicListing, renderPublicReport } from "./core/outreachPublicPages.js";
import {
  AUTO_PLAN_ROLES,
  MAX_RECURRING_RUNS,
  describeOffset,
  offsetMs,
  recurrenceMs,
  resolveSender,
  specificDateDueMs,
} from "./core/autoPlanScheduling.js";
import {
  MERGE_FIELDS,
  applyMergeFields,
  describeMergeProblem,
  isSendable,
} from "./core/mergeFields.js";
import {
  scheduleMessage,
  listScheduled,
  getScheduled,
  cancelScheduled,
  rescheduleMessage,
  scheduledCounts,
  type ScheduledChannel,
} from "./core/scheduledMessages.js";
import { canSendOn, startScheduledSender } from "./core/scheduledSender.js";
import { parseSendTime, suggestNextGoodTime } from "./core/scheduleTime.js";
import {
  suggestReply,
  completeReply,
  suggestReplyFromThread,
  completeReplyFromThread,
} from "./core/replySuggest.js";
import {
  run as runBrowserCommand,
  status as browserStatus,
  run as runBrowserCommandDirect,
  recordPoll as recordBrowserPoll,
  submitResult as submitBrowserResult,
  tokenMatches as browserTokenMatches,
  accountForToken as browserAccountForToken,
  withAccount as withBrowserAccount,
  isConfigured as browserControlConfigured,
  recentActivity as recentBrowserActivity,
} from "./core/browserControl.js";
import {
  listDocs,
  listCategories,
  getDoc,
  createDoc,
  updateDoc,
  deleteDoc,
  searchDocs,
  knowledgeStats,
} from "./core/knowledgeStore.js";


import { sendAssignmentEmail } from "./core/taskAssignmentEmail.js";
import { getBrivityPeople, getBrivityImportStatus } from "./core/brivityPeople.js";
import { buildZip } from "./core/zipWriter.js";
import { getSocialAnalytics } from "./core/socialAnalytics.js";
import { handleWebsiteVisit } from "./agents/reEngagement/index.js";
import { handleListingStatusUpdate } from "./agents/listingStatusAutomation/index.js";
import {
  ingestContent,
  repurposeSession,
  runComplianceCheck,
  applyComplianceDecision,
  publishVideo,
  triageDm,
  trackCommentManaged,
  runPerformanceSync,
  getDailyReport,
  getWeeklyReport,
} from "./agents/contentManager/index.js";
import { contentManagerBrain, getOrCreateSession } from "./agents/contentManager/brain/index.js";
import { uploadPostConnected } from "./agents/contentManager/uploadPostPublish.js";
import { getDriveStatus, pollGoogleDrive, driveConfigured } from "./agents/contentManager/googleDrivePull.js";
import {
  verifySignedClip,
} from "./agents/contentManager/metaPublish.js";
import { processBatch } from "./agents/contentManager/batchProcessor.js";
import { processStyleExample } from "./agents/contentManager/styleExamples.js";
import { deleteClipFile, getFreeDiskMB, runSafetyDiskCleanup } from "./core/diskCleanup.js";
import {
  getCachedTrends,
  runCompetitorScrape,
} from "./agents/contentManager/competitorIntel.js";
import { getCurrentWeekNumber } from "./agents/contentManager/brain/stats.js";
import { computeBenchmarkTrajectory } from "./agents/contentManager/brain/tools.js";
import {
  getContentDb,
  listContentVideos,
  listPendingComplianceQueue,
  listLeadCaptures,
  getContentManagerStats,
  getAnalyticsDataset,
  getPillarPerformanceSummary,
  updateContentVideo,
  updateContentVideoFilePath,
  appendContentVideoEditHistory,
  recordClipVersion,
  getLatestClipVersion,
  deleteClipVersion,
  insertClipChatMessage,
  listClipChatMessages,
  getContentVideo,
  getContentSession,
  getLatestBriefing,
  getDailyStrategy,
  ensureDailyTargets,
  getPerformanceModel,
  listLearningLogs,
  listBriefings,
  listCutList,
  listHookLibrary,
  todayDateCst,
  getLatestAgentRun,
  listActiveChatSessions,
  listChatMessages,
  deleteChatSession,
  listSelfEvaluations,
  listStrategyAccuracy,
  listExperiments,
  listCombinationPatterns,
  getSeasonalWeek,
  createBatchSession,
  createBatchSourceFile,
  getBatchSession,
  updateBatchSession,
  listBatchSourceFiles,
  listBatchSessions,
  deleteBatchSession,
  listVideosByBatchSession,
  countVideosByBatchAndStatus,
  getCachedCompetitorTrends,
  getLatestCompetitorTrends,
  getCompetitorTrendsById,
  listAllCompetitorProfiles,
  insertCompetitorProfile,
  updateCompetitorProfile,
  getClipEnhancementByVideoId,
  type ContentVideo,
  updateClipEnhancement,
  listContentVideosWithEnhancements,
  insertPublishLog,
  incrementDailyTarget,
  listPublishingQueue,
  getActiveStrategyRecommendations,
  listStrategyRecommendations,
  getStrategyRecommendationById,
  updateStrategyRecommendation,
  listRecordingTasks,
  insertRecordingTask,
  updateRecordingTask,
  countActiveStrategyRecommendations,
  countPendingRecordingTasksThisWeek,
  getLatestYoutubeAnalysis,
  listAllYoutubeProfiles,
  insertYoutubeProfile,
  updateYoutubeProfile,
  listYoutubeTranscripts,
  getYoutubeTranscript,
  createStyleExample,
  listStyleExamples,
  deleteStyleExample,
  type CmStyleExampleKind,
  recordClipDecision,
} from "./core/contentDb.js";
import { runYouTubeCompetitorAnalysis, getYouTubeIntelProgress } from "./agents/contentManager/youtubeIntel.js";
import {
  runFullCompetitiveAnalysis,
  generateRecordingTask,
  getLatestCompetitiveAnalysis as getLatestAnalysis,
} from "./agents/contentManager/competitiveAnalysis.js";
import {
  getCalendarDayData,
  getCalendarMonthData,
  getSprintProgress,
  generateWeeklyRecordingPlan,
  generateDailyRecordingPlan,
  markRecordingTaskFiled,
} from "./agents/contentManager/calendar.js";
import { getWeekStart } from "./agents/contentManager/brain/stats.js";
import {
  getAutoPlans,
  getAutoPlanById,
  createAutoPlan,
  updateAutoPlan,
  deleteAutoPlan,
  duplicateAutoPlan,
} from "./core/autoPlans.js";
import {
  getAutoPlanTriggers,
  createAutoPlanTrigger,
  updateAutoPlanTrigger,
  deleteAutoPlanTrigger,
} from "./core/autoPlanTriggers.js";
import {
  createTagTemplate,
  deleteTagTemplate,
  getTagTemplates,
} from "./core/tagTemplates.js";
import { filterDashboardLeads } from "./core/leadFilter.js";
import type { LeadFilter, CrmStatusValue } from "./core/types.js";
import { addVocabulary, listVocabulary, removeVocabulary, vocabularyStats } from "./core/crmVocabulary.js";
import { isInternalCall } from "./core/internalCall.js";
import { resolveSendingLine } from "./core/sendingIdentity.js";
import { getCrmApiCatalogue, setCrmApiCatalogue } from "./core/crmApiSurface.js";
import { isRecurringInterval } from "./core/types.js";
import {
  APPOINTMENT_TYPE_GROUPS,
  CRM_STAGES,
  CRM_STAGE_GROUPS,
  CRM_STAGE_LEGACY,
} from "./core/types.js";
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
  CommandTaskStatus,
} from "./core/types.js";
import {
  CRM_TASK_STATUSES,
  COMMAND_TASK_STATUSES,
  MARCO_TASK_STATUSES,
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
import {
  BUYER_STAGES,
  SELLER_STAGES,
  TRACKER_STATUSES,
} from "./core/types.js";
import {
  createTrackerRecord,
  deleteTrackerRecord,
  getTrackerRecord,
  listTrackerRecords,
  setTrackerStage,
  trackerCounts,
  updateTrackerRecord,
  type TrackerFilter,
} from "./core/trackerStore.js";
import {
  applyTaskState,
  applyTaskStateAll,
  linkedTasks,
  pushChecklistToTasks,
  syncChecklistToTasks,
  unlinkChecklistItem,
} from "./core/trackerTasks.js";
import { backfillTrackerFromLeads } from "./core/trackerMigration.js";
import {
  getCommandSettings,
  setCommandTimeZone,
  isValidTimeZone,
  getUserLayout,
  setUserLayout,
} from "./core/commandSettings.js";

import type {
  CommandTask,
  CommandTaskChecklistItem,
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
  getLastTransactionImport,
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
import { applyTransactionImport, planTransactionImport } from "./core/transactionImport.js";
import { runSheetSync, sheetSyncStatus, isSheetSyncConfigured } from "./core/transactionSheetSync.js";
import {
  checkTransactionImportReminder,
  scheduleTransactionImportReminder,
} from "./agents/transactionImportReminder/index.js";
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
import { scoreAllLeads, scoreAndRecordLead, scoreColdLeads, WEIGHTS as LEAD_SCORE_WEIGHTS } from "./agents/leadScoring/index.js";
import { runWarmLeadWeeklyTouch } from "./agents/leadNurture/warmLeadFlow.js";
import { runColdLeadMonthlyTouch } from "./agents/leadNurture/coldLeadFlow.js";
import { routeNewLead } from "./agents/leadNurture/sourceRouting.js";
import {
  getLatestScore,
  getScoreHistory,
  getLeadsByTier,
  getScoreEntriesSince,
} from "./core/leadScoreStore.js";
import { runDailyDigest, deliverDigest } from "./agents/reporting/dailyDigest.js";
import { runWeeklyKPI } from "./agents/reporting/weeklyKPI.js";
import { getLatestSnapshot, getSnapshotsByType } from "./core/reportingStore.js";
import {
  createCommission,
  createExpense,
  getAllCommissions,
  getAllExpenses,
  getGCISummary,
  getExpenseSummary,
  generatePipelineProjection,
  getFinanceAlerts,
  acknowledgeFinanceAlert,
  type ExpenseCategory,
  type FinanceDealType,
} from "./core/financeStore.js";
import {
  buildWeeklyFinanceSummaryData,
  buildMonthlyCloseReportData,
  getCurrentPaceStatus,
  runWeeklyFinanceSummary,
  runMonthlyCloseReport,
  runPaceCheck,
  runExpenseSpikeCheck,
  tryRecordCommissionForClosedDeal,
  syncCommissionsFromClosedTransactions,
} from "./agents/finance/index.js";
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
import { isJunkPriceCap, normalizeArea } from "./core/criteriaExtract.js";
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
import { runHarveyChat, runHarveyOps, getHarveyModel, runHarveyTool } from "./harvey/index.js";
import { HARVEY_GEMINI_TOOLS } from "./harvey/tools.js";
import {
  initHull,
  registerHullWs,
  getHullDb,
  generateTTS,
  handleActivation,
  runPostConversationExtraction,
  buildMemoryPacketForQuery,
  broadcastHullEvent,
} from "./hull/index.js";
import { handleDeepgramUpgrade } from "./hull/voice/deepgramProxy.js";
import { ttsHealthReport } from "./hull/voice/tts.js";
import { handleElevenLabsUpgrade } from "./hull/voice/elevenlabsProxy.js";
import { WebSocketServer } from "ws";
import {
  logSmsIfNew,
  logSmsMessage,
  markRepliedAt,
  getThreadForLead,
  isMessageHandleSeen,
  getInboundMessageCount,
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
import { newMarcoRequestId, marcoCorrelationId } from "./app/marcoLog.js";
import {
  checkOpenShortsHealth,
  mapClipUrlForFrontend,
  trimClipViaOpenShorts,
  editClipViaOpenShorts,
  analyzeReelViaOpenShorts,
} from "./integrations/openshorts/index.js";
import { runClipEditChat, type ClipEditContext } from "./agents/contentManager/clipEditAgent.js";
import { createProxyMiddleware } from "http-proxy-middleware";
import { checkVoxCpmHealth } from "./integrations/voxcpm/index.js";
import {
  isElevenLabsConfigured,
  checkElevenLabsHealth,
  createInstantVoiceClone,
} from "./integrations/elevenlabsVoice/index.js";
import { checkScriptSafety } from "./agents/voiceClone/safetyLock.js";
import {
  createVoiceoverRequest,
  updateVoiceoverRequest,
  getVoiceoverRequest,
  getAllRequests,
  getPendingApprovalRequests,
  getAllReferenceClips,
  createReferenceClip,
  setPrimaryReferenceClip,
  getPrimaryReferenceClip,
  getReferenceClipById,
  setReferenceClipVoiceId,
  getSafetyLogEntries,
  countPendingApprovalRequests,
  resolveVoiceCloneDataRoot,
} from "./core/voiceCloneStore.js";

import { makeLockdown } from "./core/lockdown.js";
import { getSession as authGetSession } from "./core/authStore.js";
import { getUserById as authGetUserById } from "./core/users.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

/* Behind Fly's proxy every request arrives over plain HTTP on the internal
   network, so `req.protocol` reads "http" and the session cookie would never
   get its Secure flag. Trusting the proxy's X-Forwarded-Proto fixes that and
   also makes the IP recorded in login_history the caller's, not the router's. */
app.set("trust proxy", 1);

/* ── THE SITE LOCK ──────────────────────────────────────────────────────────
   Registered here, before every route and before express.static, because a
   gate that is mounted after the thing it guards is not a gate. See
   src/core/lockdown.ts for what stays public and why.
   ────────────────────────────────────────────────────────────────────────── */
app.use(
  makeLockdown({
    enabled: () => siteLoginEnabled(),
    sessionUser: (req) => sessionUserSync(req as express.Request),
    machineTokenOk: (req) => machineTokenOk(req as express.Request),
    internalCall: (req) => isInternalCall(req as express.Request),
  }),
);

/**
 * The signed-in user, resolved synchronously.
 *
 * `currentSessionUser` is async only because it uses dynamic imports; the two
 * stores underneath it are ordinary synchronous SQLite/JSON reads. The lock
 * runs on every single request, so it uses the static imports and stays sync —
 * an async gate would have to be awaited by every caller and is one forgotten
 * `await` away from letting a request through.
 */
function sessionUserSync(req: express.Request): import("./core/types.js").CRMUser | null {
  try {
    const token = getCookieValue(req, SESSION_COOKIE);
    if (!token) return null;
    const session = authGetSession(token);
    if (!session) return null;
    const user = authGetUserById(session.userId);
    if (!user || user.active === false) return null;
    return user;
  } catch {
    /* A broken auth database must fail CLOSED. Returning null sends the caller
       to the login page; returning a user here would be the whole lock. */
    return null;
  }
}

/**
 * A configured machine credential.
 *
 * Differs from the old `dashboardTokenOkIncoming` in exactly one way, which was
 * the bug: when no DASHBOARD_TOKEN is configured this returns FALSE. "Nobody
 * set a token" now means "no machine access", not "let everyone in".
 */
function machineTokenOk(req: express.Request | IncomingMessage): boolean {
  const expected = process.env.DASHBOARD_TOKEN?.trim();
  if (!expected) return false;
  let q = "";
  if ("query" in req && req.query && typeof req.query.token === "string") {
    q = req.query.token;
  } else {
    try {
      const host = req.headers.host || "localhost";
      q = new URL(req.url || "/", `http://${host}`).searchParams.get("token") || "";
    } catch {
      q = "";
    }
  }
  const auth = req.headers.authorization;
  const bearer = typeof auth === "string" && auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  /* Constant-time-ish: compare length first, then every byte. */
  const eq = (a: string) => a.length === expected.length && timingSafeEqualStr(a, expected);
  return eq(q) || eq(bearer);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

app.use(
  "/openshorts",
  createProxyMiddleware({
    target: process.env.OPENSHORTS_URL || "http://localhost:8000",
    changeOrigin: true,
    pathRewrite: { "^/openshorts": "" },
  }),
);

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

function getDiskInfo(): {
  total_mb: number;
  used_mb: number;
  available_mb: number;
  used_pct: number;
  warning: string | null;
  critical: string | null;
} {
  const fallback = {
    total_mb: -1,
    used_mb: -1,
    available_mb: -1,
    used_pct: -1,
    warning: null as string | null,
    critical: null as string | null,
  };
  try {
    const dfOutput = execSync("df -m /data 2>/dev/null || df -m . 2>/dev/null", {
      timeout: 3000,
    }).toString();
    const lines = dfOutput.trim().split("\n");
    if (lines.length < 2) return fallback;
    const parts = lines[1].split(/\s+/);
    const total_mb = parseInt(parts[1], 10) || -1;
    const used_mb = parseInt(parts[2], 10) || -1;
    const available_mb = parseInt(parts[3], 10) || -1;
    const used_pct = parseInt((parts[4] || "0").replace("%", ""), 10) || -1;
    return {
      total_mb,
      used_mb,
      available_mb,
      used_pct,
      warning:
        used_pct > 85 ? "DISK ABOVE 85% — clean up /data/clips and /data/uploads" : null,
      critical:
        used_pct > 95 ? "DISK CRITICAL — processing will fail until space is freed" : null,
    };
  } catch {
    return fallback;
  }
}

/** Harvey's current speaking voice, for /health. Never throws — a settings
    read must not be able to take the health endpoint down. */
function harveyVoiceName(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getVoiceProfile } = require("./hull/voice/voiceProfile.js") as typeof import("./hull/voice/voiceProfile.js");
    const p = getVoiceProfile();
    return `${p.voiceName} · ${p.preset}`;
  } catch {
    return null;
  }
}

app.get("/health", async (_req, res) => {
  const apiKeyConfigured = isAnthropicApiKeyConfigured();
  const openShortsHealth = await checkOpenShortsHealth().catch(() => ({ running: false }));
  const disk = getDiskInfo();
  res.status(200).json({
    ok: true,
    disk,
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
      hull: "aethon-intelligence",
      voice: {
        /* HEARING. This used to read the Deepgram key only, and so reported
           "none" on a box where Harvey could hear perfectly well — ElevenLabs
           Scribe v2 has been the PRIMARY engine since the proxy was written
           and Deepgram is only the fallback. Anyone debugging a deaf Harvey
           was being pointed at the wrong vendor. */
        engine: process.env.ELEVENLABS_API_KEY?.trim()
          ? "elevenlabs-scribe-v2"
          : process.env.DEEPGRAM_API_KEY?.trim()
          ? "deepgram-flux"
          : "none",
        stt_fallback: process.env.DEEPGRAM_API_KEY?.trim() ? "deepgram-flux" : "none",
        deepgram_configured: Boolean(process.env.DEEPGRAM_API_KEY?.trim()),
        brain: "claude",
        /* This said "gemini" regardless of what actually speaks. Harvey's TTS
           has been ElevenLabs throughout (hull/voice/tts.ts); the label was
           left behind by an earlier migration and told anyone reading /health
           the wrong thing about which vendor to check when he went quiet. */
        tts: process.env.ELEVENLABS_API_KEY?.trim() ? "elevenlabs" : "none",
        elevenlabs_configured: Boolean(process.env.ELEVENLABS_API_KEY?.trim()),
        voice_name: harveyVoiceName(),
        gemini_configured: Boolean(geminiApiKey()),
        /* SPEAKING, as opposed to "configured to speak". A key can be set, a
           voice can be named, and every single utterance can still 404 — that
           is exactly what happened on 2026-08-17, and nothing here said so.
           `ok` is null until Harvey has actually tried to say something. */
        speech: ttsHealthReport(),
      },
    },
    openshorts: {
      running: openShortsHealth.running,
      model: "model" in openShortsHealth ? openShortsHealth.model || "gemini-2.5-flash" : "gemini-2.5-flash",
      active_jobs: "activeJobs" in openShortsHealth ? openShortsHealth.activeJobs || 0 : 0,
    },
  });
});

// (The in-house TikTok OAuth token-grab routes were removed — publishing now
// goes through Upload-Post, which handles OAuth for all platforms externally.)

/** OpenClaw — OpenAI-compatible brain endpoint (WhatsApp / messaging gateway). */
app.post("/v1/chat/completions", express.json({ limit: "256kb" }), async (req, res) => {
  if (!isAnthropicApiKeyConfigured()) {
    res.status(503).json({ error: "ANTHROPIC_API_KEY not configured" });
    return;
  }
  try {
    const { handleOpenClawChatCompletions } = await import("./hull/openclaw.js");
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { status, json } = await handleOpenClawChatCompletions(body as Record<string, unknown>);
    res.status(status).json(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[openclaw] /v1/chat/completions", msg);
    res.status(500).json({ error: msg });
  }
});

app.post("/v1/sessions/reset", express.json(), async (req, res) => {
  const sessionId =
    typeof req.body?.sessionId === "string" && req.body.sessionId.trim()
      ? req.body.sessionId.trim()
      : "harvey";
  const { resetOpenClawSession } = await import("./hull/openclaw.js");
  resetOpenClawSession(sessionId);
  res.json({ ok: true, message: "Thread cleared. Memory saved. Fresh start.", sessionId });
});

app.get("/v1/sessions/:sessionId", async (req, res) => {
  const sessionId = String(req.params.sessionId || "harvey").trim();
  const { getOpenClawSession } = await import("./hull/openclaw.js");
  res.json(getOpenClawSession(sessionId));
});

// Unified UI shell — the new entry point. Every sub-agent page loads as a tab
// inside it (Harvey is the persistent home tab). The individual routes below are
// kept intact so each page still works standalone (they're loaded via iframe).
app.get("/shell", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "shell.html"));
});

// Team sign-in screen — "who's logging in?" as a real page, not a modal.
// Ungated on purpose: it IS the sign-in screen, and gating it behind the
// thing it grants would lock the team out. It sets the shared identity every
// page reads, so one pick signs you in across the whole system.
app.get("/who", (_req, res) => {
  res.sendFile(path.join(publicDir, "who.html"));
});

app.get("/", (_req, res) => {
  res.redirect("/shell");
});

// The shell UI is the single entry point. A direct top-level visit to the
// legacy /dashboard link redirects into the shell and lands on its CRM tab
// (which is exactly the dashboard's content). The shell itself still embeds
// this page as its CRM iframe — detected via the explicit embed marker the
// shell appends, or the browser's Sec-Fetch-Dest header for the iframe load —
// and is served the file normally so that tab keeps working.
app.get("/dashboard", requireAuthPage, (req, res) => {
  const embedded =
    req.query.embed === "1" || req.get("sec-fetch-dest") === "iframe";
  if (!embedded) {
    res.redirect("/shell?tab=crm");
    return;
  }
  res.sendFile(path.join(publicDir, "dashboard.html"));
});

/** Legacy DM simulator */
app.get("/chat", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "chat.html"));
});

app.get("/jarvis", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "jarvis.html"));
});

// New blue particle-orb Harvey screen (reuses Harvey's existing voice pipeline).
app.get("/operator", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "operator.html"));
});

// Team Task Command Center (design-spec rebuild; classic board stays at /tasks).
app.get("/team-tasks", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "team-tasks.html"));
});

// Harvey Jobs — start a job, watch each step, read what it produced.
app.get("/listings", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "listings.html"));
});

/* The CMA wizard. Not a sidebar tab, for the same reason MLS is not one: a
   CMA is built for a contact, and opening it standalone loses that. The CRM's
   CMA widget links here with ?leadId=. */
app.get("/cma", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "cma.html"));
});

/** One listing, in full — where a click in the MLS tab lands. */
app.get("/listing", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "listing.html"));
});

app.get("/jobs", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "jobs.html"));
});

// Buyers & Sellers Tracker — the two-pipeline board over /api/tracker/*.
app.get("/tracker", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "tracker.html"));
});

app.get("/memory", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "memory.html"));
});

app.get("/tasks", (_req, res) => {
  // The team Task Command Center replaced the classic board (kept at /tasks-classic).
  res.redirect("/team-tasks");
});

app.get("/tasks-classic", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "tasks.html"));
});

app.get("/social", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "social.html"));
});

// Content Planner — the editorial calendar (plan/backlog/assignment), as
// distinct from the Content Manager's production calendar of filmed clips.
app.get("/content-planner", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "content-planner.html"));
});

app.get("/email-marketing", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "email-marketing.html"));
});

app.get("/lead-nurture", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "lead-nurture.html"));
});

app.get("/reporting", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "reporting.html"));
});

app.get("/finance", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "finance.html"));
});

app.get("/voice-clone", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "voice-clone.html"));
});

// Guided how-to tour (replaced the Voice Clone sidebar tab; /voice-clone above
// still works, so the voice-clone functionality is untouched — just untabbed).
app.get("/how-to", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "how-to.html"));
});

// Clean single-column chat UI (Harvey by default, ?agent=arlo for Arlo).
// Self-contained page — talks to /api/jarvis/chat.
app.get("/hull-chat", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "hull-chat.html"));
});

// Brivity-style CRM front end (staged rebuild: dashboard → messages → leads).
app.get("/crm", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "crm-brivity.html"));
});

const voiceCloneDataRoot = resolveVoiceCloneDataRoot();
app.use("/voice-clone-files", express.static(voiceCloneDataRoot));

function mapVoiceCloneFileUrl(filePath: string, voxcpmApiUrl?: string): string {
  if (!filePath) return "";
  const root = path.normalize(voiceCloneDataRoot);
  const normPath = path.normalize(filePath);
  if (normPath.startsWith(root)) {
    const rel = path.relative(root, normPath).replace(/\\/g, "/");
    return `/voice-clone-files/${rel}`;
  }
  if (voxcpmApiUrl && !filePath.startsWith("http")) {
    const base = voxcpmApiUrl.replace(/\/$/, "");
    const filename = path.basename(filePath);
    return `${base}/audio/${filename}`;
  }
  return filePath;
}

function enrichVoiceoverRequest(req: import("./core/voiceCloneStore.js").VoiceoverRequest | null) {
  if (!req) return null;
  const voxcpmUrl = process.env.VOXCPM_API_URL?.trim();
  const audioUrls = (req.outputFilePaths || []).map((p) => mapVoiceCloneFileUrl(p, voxcpmUrl));
  const exportUrl = req.exportFilePath
    ? mapVoiceCloneFileUrl(req.exportFilePath, voxcpmUrl)
    : undefined;
  return { ...req, audioUrls, exportUrl };
}

app.get("/crm-followup-tasks.js", (_req, res) => {
  res.sendFile(path.join(publicDir, "crm-followup-tasks.js"));
});

/**
 * The per-route check, kept as a second layer behind the site lock.
 *
 * It used to be the ONLY layer, and it passed everyone whenever DASHBOARD_TOKEN
 * was unset. Now a request satisfies it by being signed in or by carrying a
 * configured machine token — and with neither, it fails.
 */
function dashboardTokenOk(req: express.Request): boolean {
  if (sessionUserSync(req)) return true;
  if (machineTokenOk(req)) return true;
  /* Harvey calling this server's own CRM API from inside this process. See
     src/core/internalCall.ts — loopback socket plus a token that only exists
     in this process's memory. */
  if (isInternalCall(req)) return true;
  /* Only when the lock is deliberately disabled does the legacy behaviour
     apply, so a local dev run without secrets still works. */
  return !siteLoginEnabled() && dashboardTokenOkIncoming(req);
}

function dashboardTokenOkIncoming(req: IncomingMessage | express.Request): boolean {
  /* Kept for the WebSocket upgrade path and for unlocked local runs. When the
     lock is armed this is never the deciding check — see dashboardTokenOk. */
  const expected = process.env.DASHBOARD_TOKEN?.trim();
  if (!expected) return !siteLoginEnabled();
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

// ── Site login (accounts + sessions + audit trail) ─────────────────────────
const SESSION_COOKIE = "mp_sid";

function getCookieValue(req: express.Request, name: string): string {
  const raw = req.headers.cookie;
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return part.slice(idx + 1).trim();
      }
    }
  }
  return "";
}

async function currentSessionUser(req: express.Request): Promise<import("./core/types.js").CRMUser | null> {
  const token = getCookieValue(req, SESSION_COOKIE);
  if (!token) return null;
  const { getSession } = await import("./core/authStore.js");
  const session = getSession(token);
  if (!session) return null;
  const { getUserById } = await import("./core/users.js");
  const user = getUserById(session.userId);
  if (!user || user.active === false) return null;
  return user;
}

// Kill switch: the whole login system stays fully built (sessions, audit log,
// Team page, /login) but is only *enforced* when this is explicitly "1". Flip
// it on later with `fly secrets set SITE_LOGIN_ENABLED=1` — no code changes,
// no redeploy of this logic needed.
function siteLoginEnabled(): boolean {
  /* Locked by default as of 2026-08-22. It used to be the reverse — the login
     system was fully built but only enforced when SITE_LOGIN_ENABLED was "1",
     and it never was, so the whole app was reachable by anyone with the URL.
     Unlocking is now an explicit, deliberate act rather than the default state
     of a machine nobody remembered to configure. */
  return process.env.SITE_LOGIN_ENABLED !== "0";
}

/** Gate a page route: redirect to /login (preserving the destination) if not signed in. */
function requireAuthPage(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!siteLoginEnabled()) {
    next();
    return;
  }
  void currentSessionUser(req).then((user) => {
    if (!user) {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    (req as express.Request & { crmUser?: import("./core/types.js").CRMUser }).crmUser = user;
    next();
  });
}

/** Gate an admin-only page: bounce non-admins back to the shell. */
function requireAuthAdminPage(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!siteLoginEnabled()) {
    next();
    return;
  }
  void currentSessionUser(req).then((user) => {
    if (!user) {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    if (user.role !== "admin") {
      res.status(403).send("Admins only.");
      return;
    }
    (req as express.Request & { crmUser?: import("./core/types.js").CRMUser }).crmUser = user;
    next();
  });
}

/** Gate an admin-only API route: JSON 401/403 instead of a redirect. */
function requireAuthAdminApi(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!siteLoginEnabled()) {
    next();
    return;
  }
  void currentSessionUser(req).then((user) => {
    if (!user) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }
    if (user.role !== "admin") {
      res.status(403).json({ error: "Admins only" });
      return;
    }
    (req as express.Request & { crmUser?: import("./core/types.js").CRMUser }).crmUser = user;
    next();
  });
}

/* Reachable while signed in with a temporary password, and only then — the
   lock funnels such an account here and nowhere else. */
app.get("/change-password", (_req, res) => {
  res.sendFile(path.join(publicDir, "change-password.html"));
});

// The login page itself must never be gated (that would be an infinite redirect loop).
app.get("/login", (req, res) => {
  void currentSessionUser(req).then((user) => {
    if (user) {
      res.redirect("/shell");
      return;
    }
    res.sendFile(path.join(publicDir, "login.html"));
  });
});

app.post("/api/auth/login", express.json(), async (req, res) => {
  const email = String(req.body?.email || "").trim();
  const password = String(req.body?.password || "");
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  const { getUserByEmail } = await import("./core/users.js");
  const { verifyPassword, createSession, recordLogin, pruneExpiredSessions } = await import("./core/authStore.js");
  const user = getUserByEmail(email);
  const ok = !!user && user.active !== false && verifyPassword(password, user.passwordHash);
  recordLogin({ userId: user?.id || null, email, success: ok, reason: ok ? undefined : "bad_credentials", req });
  if (!ok) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  pruneExpiredSessions();
  const token = createSession(user!.id, req);
  const { updateUser } = await import("./core/users.js");
  updateUser(user!.id, { lastLogin: new Date().toISOString() });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || req.protocol === "https",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/",
  });
  res.json({ ok: true });
});

app.post("/api/auth/logout", async (req, res) => {
  const token = getCookieValue(req, SESSION_COOKIE);
  if (token) {
    const { destroySession } = await import("./core/authStore.js");
    destroySession(token);
  }
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
  const user = await currentSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const { passwordHash, ...safe } = user;
  void passwordHash;
  res.json({ user: safe });
});

app.get("/api/auth/login-history", requireAuthAdminApi, async (_req, res) => {
  const { getLoginHistory } = await import("./core/authStore.js");
  res.json({ rows: getLoginHistory(150) });
});

app.get("/api/auth/audit-log", requireAuthAdminApi, async (_req, res) => {
  const { getAuditLog } = await import("./core/authStore.js");
  res.json({ rows: getAuditLog(250) });
});

app.post("/api/auth/team", express.json(), requireAuthAdminApi, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim();
  const role = req.body?.role;
  const roleOk = role === "admin" || role === "agent" || role === "isa" || role === "custom";
  if (!name || !email) {
    res.status(400).json({ error: "Name and email are required" });
    return;
  }
  const { getUserByEmail, createUser } = await import("./core/users.js");
  const { ROLE_PERMISSIONS } = await import("./core/types.js");
  if (getUserByEmail(email)) {
    res.status(409).json({ error: "A team member with that email already exists" });
    return;
  }
  const { hashPassword, genTempPassword, recordAudit } = await import("./core/authStore.js");
  const tempPassword = genTempPassword();
  const finalRole = roleOk ? role : "agent";
  const created = createUser({
    name,
    email,
    role: finalRole,
    permissions: { ...ROLE_PERMISSIONS[finalRole] },
    active: true,
    avatarInitials: undefined!,
    avatarColor: "#64748b",
    passwordHash: hashPassword(tempPassword),
    mustChangePassword: true,
  });
  const actor = (req as express.Request & { crmUser?: import("./core/types.js").CRMUser }).crmUser;
  recordAudit({ userId: actor?.id, userName: actor?.name, action: "team.create", detail: `Created ${name} (${email}, ${finalRole})`, req });
  const { passwordHash, ...safe } = created;
  void passwordHash;
  res.status(201).json({ ok: true, user: safe, tempPassword });
});

app.post("/api/auth/team/:id/reset-password", requireAuthAdminApi, async (req, res) => {
  const id = String(req.params.id || "").trim();
  const { getUserById, updateUser } = await import("./core/users.js");
  const target = getUserById(id);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const { hashPassword, genTempPassword, destroyAllSessionsForUser, recordAudit } = await import("./core/authStore.js");
  const tempPassword = genTempPassword();
  updateUser(id, { passwordHash: hashPassword(tempPassword), mustChangePassword: true });
  destroyAllSessionsForUser(id);
  const actor = (req as express.Request & { crmUser?: import("./core/types.js").CRMUser }).crmUser;
  recordAudit({ userId: actor?.id, userName: actor?.name, action: "team.reset_password", detail: `Reset password for ${target.name}`, req });
  res.json({ ok: true, tempPassword });
});

app.post("/api/auth/change-password", express.json(), async (req, res) => {
  const user = await currentSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  const { verifyPassword, hashPassword, recordAudit } = await import("./core/authStore.js");
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }
  /* Raised from 8 to 12 with the site lock. The server is the one that
     decides; the page's own check is only there for a fast answer. */
  if (newPassword.length < 12) {
    res.status(400).json({ error: "New password must be at least 12 characters" });
    return;
  }
  if (newPassword === currentPassword) {
    res.status(400).json({ error: "That is the password you were issued. Pick a different one." });
    return;
  }
  const { updateUser } = await import("./core/users.js");
  updateUser(user.id, { passwordHash: hashPassword(newPassword), mustChangePassword: false });
  recordAudit({ userId: user.id, userName: user.name, action: "account.change_password", detail: undefined, req });
  res.json({ ok: true });
});

app.get("/team", requireAuthAdminPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "team.html"));
});

// One-time setup: sets the very first password on a matching admin account.
// Permanently refuses once ANY user in the system already has a password set,
// so it can never be replayed as a backdoor after initial setup.
app.post("/api/auth/bootstrap", express.json(), async (req, res) => {
  const { getUsers, getUserByEmail, updateUser } = await import("./core/users.js");
  const users = getUsers();
  if (users.some((u) => !!u.passwordHash)) {
    res.status(403).json({ error: "Setup already complete — use the normal login/reset-password flow." });
    return;
  }
  const email = String(req.body?.email || "").trim();
  const password = String(req.body?.password || "");
  if (!email || password.length < 8) {
    res.status(400).json({ error: "email and a password of at least 8 characters are required" });
    return;
  }
  const target = getUserByEmail(email);
  if (!target) {
    res.status(404).json({ error: `No seeded account found for ${email}` });
    return;
  }
  const { hashPassword } = await import("./core/authStore.js");
  updateUser(target.id, { passwordHash: hashPassword(password), mustChangePassword: false });
  res.json({ ok: true });
});

/* ===================== Quo — SMS on Marco's business line =====================
   Quo is the phone system behind (737) 283-4703. These routes mirror its SMS
   into the CRM's Messages tab and send from it. Threads are keyed by PHONE,
   and matched to leads at read time — nothing here writes the lead store,
   because createLead() fires real outbound automations and Quo's book is
   mostly call records that must never become CRM leads.
============================================================================ */

/**
 * The URL Quo should call, guard token included. Same base-URL convention the
 * rest of the app uses, so a deploy behind a different hostname only needs
 * PUBLIC_BASE_URL set in one place.
 */
async function quoWebhookUrl(override?: string): Promise<string | null> {
  const { quoWebhookSecret } = await import("./integrations/quo/index.js");
  const secret = quoWebhookSecret();
  if (!secret) return null;
  const base = (override || process.env.PUBLIC_BASE_URL || "https://marco-90-automation.fly.dev")
    .trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) return null;   // Quo will not call plain http
  return `${base}/api/quo/webhook?key=${secret}`;
}

app.get("/api/quo/status", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { isQuoConfigured, checkQuo, getQuoPhoneNumber } = await import("./integrations/quo/index.js");
  const { quoMessageCount, quoThreadCount } = await import("./core/quoStore.js");
  const { lastQuoSyncAt } = await import("./core/quoSync.js");
  if (!isQuoConfigured()) {
    res.json({
      configured: false, verified: false,
      hint: "Set QUO_API_KEY (and optionally QUO_PHONE_NUMBER_ID) as Fly secrets to turn on SMS.",
    });
    return;
  }
  const check = await checkQuo();
  /* Whether Quo is calling us matters operationally — without the webhook the
     CRM is still correct, just up to 5 minutes behind — so it is reported
     rather than assumed. */
  let webhook: { registered: boolean; url: string | null; error?: string } = { registered: false, url: null };
  try {
    const { listWebhooks } = await import("./integrations/quo/index.js");
    const url = await quoWebhookUrl();
    const hooks = await listWebhooks();
    webhook = { registered: hooks.some((w) => w.url === url), url };
  } catch (err) {
    webhook = { registered: false, url: null, error: (err as Error).message };
  }
  res.json({
    configured: true,
    verified: check.ok,
    error: check.error || null,
    number: getQuoPhoneNumber() || check.numbers?.[0]?.number || null,
    numbers: (check.numbers || []).map((n) => ({ id: n.id, name: n.name, number: n.number })),
    threads: quoThreadCount(),
    messages: quoMessageCount(),
    lastSyncAt: lastQuoSyncAt(),
    webhook,
  });
});

/** Thread list for the SMS tab, joined to leads by phone at read time. */
app.get("/api/quo/threads", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { listQuoThreads } = await import("./core/quoStore.js");
  const { phoneKey } = await import("./integrations/quo/index.js");
  const threads = listQuoThreads(Math.min(500, Number(req.query.limit) || 200));
  /* Join to the CRM's own book so a known contact shows their name rather
     than a bare number. Read-only: no lead is created or modified. */
  const snap = await getDashboardSnapshot();
  const byPhone = new Map<string, { id: string; name: string | null }>();
  for (const l of snap.leads) {
    const k = phoneKey(l.phone);
    if (k && !byPhone.has(k)) byPhone.set(k, { id: l.id, name: l.name });
  }
  res.json({
    ok: true,
    threads: threads.map((t) => {
      const lead = byPhone.get(t.peerKey) || null;
      return { ...t, leadId: lead?.id ?? null, leadName: lead?.name ?? null };
    }),
  });
});

app.get("/api/quo/threads/:peer", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { getQuoThread } = await import("./core/quoStore.js");
  const { phoneKey } = await import("./integrations/quo/index.js");
  const key = phoneKey(String(req.params.peer || ""));
  if (!key) { res.status(400).json({ error: "A phone number is required" }); return; }
  res.json({ ok: true, peerKey: key, messages: getQuoThread(key, 300) });
});

/**
 * The Quo lines on the account, and which CRM user each is assigned to.
 *
 * Read-only. Reads the live list from Quo rather than a stored copy, so a
 * number added or removed in Quo shows up here without anyone re-syncing.
 */
app.get("/api/quo/numbers", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { listPhoneNumbers, isQuoConfigured, getQuoPhoneNumberId, getQuoPhoneNumber } =
    await import("./integrations/quo/index.js");
  const users = getUsers().filter((u) => u.active !== false);
  const assignedBy = new Map<string, string>();
  for (const u of users) if (u.quoPhoneNumberId) assignedBy.set(u.quoPhoneNumberId, u.name);

  if (!isQuoConfigured()) {
    res.json({
      ok: false,
      configured: false,
      error: "Quo is not configured on this server, so its numbers cannot be listed.",
      numbers: [],
      users: users.map((u) => ({ id: u.id, name: u.name, quoPhoneNumberId: u.quoPhoneNumberId || null, quoPhoneNumber: u.quoPhoneNumber || null })),
    });
    return;
  }
  try {
    const numbers = await listPhoneNumbers();
    res.json({
      ok: true,
      configured: true,
      defaultId: getQuoPhoneNumberId(),
      defaultNumber: getQuoPhoneNumber(),
      numbers: numbers.map((n) => ({
        id: n.id,
        number: n.number,
        label: n.name || n.formattedNumber || n.number,
        /* Quo's own idea of who owns the line, by email. Only a SUGGESTION for
           the operator — the CRM's assignment is what actually decides, because
           Quo seats and CRM accounts are different lists that need not agree. */
        quoUsers: (n.users || []).map((x) => ({ email: x.email, name: [x.firstName, x.lastName].filter(Boolean).join(" ") || x.email })),
        assignedTo: assignedBy.get(n.id) || null,
      })),
      users: users.map((u) => ({ id: u.id, name: u.name, email: u.email, quoPhoneNumberId: u.quoPhoneNumberId || null, quoPhoneNumber: u.quoPhoneNumber || null })),
    });
  } catch (err) {
    res.status(502).json({ ok: false, configured: true, error: (err as Error).message, numbers: [] });
  }
});

/** Assign (or clear) the Quo line a CRM user texts from. */
app.post("/api/quo/numbers/assign", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const b = (req.body || {}) as Record<string, unknown>;
  const userId = String(b.userId || "").trim();
  const phoneNumberId = String(b.quoPhoneNumberId || "").trim();
  if (!userId) { res.status(400).json({ error: "userId is required" }); return; }
  const target = getUsers().find((u) => u.id === userId);
  if (!target) { res.status(404).json({ error: `No user with id ${userId}` }); return; }

  /* Clearing is explicit — an empty id means "back to the account default",
     which is a real choice and not the same as a failed lookup. */
  if (!phoneNumberId) {
    const cleared = updateUser(userId, { quoPhoneNumberId: undefined, quoPhoneNumber: undefined });
    res.json({ ok: true, cleared: true, user: cleared });
    return;
  }

  const { listPhoneNumbers, isQuoConfigured } = await import("./integrations/quo/index.js");
  if (!isQuoConfigured()) { res.status(503).json({ error: "Quo is not configured on this server." }); return; }
  let numbers: Awaited<ReturnType<typeof listPhoneNumbers>>;
  try { numbers = await listPhoneNumbers(); }
  catch (err) { res.status(502).json({ error: `Could not read Quo's numbers: ${(err as Error).message}` }); return; }

  /* Verified against Quo before it is stored. An id that Quo does not have
     would be accepted here and then fail on every send, at which point the
     operator would be debugging a message that never left. */
  const match = numbers.find((n) => n.id === phoneNumberId);
  if (!match) {
    res.status(400).json({ error: `Quo has no phone number with id ${phoneNumberId}. Pick one from /api/quo/numbers.` });
    return;
  }
  /* One line per person. Two CRM users sharing a number would make replies
     ambiguous, which is the problem this feature exists to solve. */
  const clash = getUsers().find((u) => u.id !== userId && u.quoPhoneNumberId === phoneNumberId && u.active !== false);
  if (clash) {
    res.status(409).json({ error: `${match.number} is already assigned to ${clash.name}. Clear theirs first.` });
    return;
  }
  const saved = updateUser(userId, { quoPhoneNumberId: match.id, quoPhoneNumber: match.number });
  res.json({ ok: true, user: saved, number: { id: match.id, number: match.number } });
});

/** Which line the signed-in user's texts will go out on, and why. */
app.get("/api/quo/my-line", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { getQuoPhoneNumberId, getQuoPhoneNumber } = await import("./integrations/quo/index.js");
  res.json({
    ok: true,
    line: resolveSendingLine(sessionUserSync(req), {
      defaultId: getQuoPhoneNumberId(),
      defaultNumber: getQuoPhoneNumber(),
    }),
  });
});

/** Send an SMS from Marco's Quo line. */
app.post("/api/quo/send", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const { sendText, toE164, phoneKey, isQuoConfigured } = await import("./integrations/quo/index.js");
  if (!isQuoConfigured()) { res.status(503).json({ error: "Quo is not configured" }); return; }
  const to = toE164(typeof body.to === "string" ? body.to : "");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!to) { res.status(400).json({ error: "A valid US phone number is required" }); return; }
  if (!text) { res.status(400).json({ error: "Message text is required" }); return; }
  /* WHOSE LINE. Resolved from the signed-in user, not from a global. See
     src/core/sendingIdentity.ts — a text that goes out on the wrong number
     sends the client's reply to the wrong person. */
  const { getQuoPhoneNumberId, getQuoPhoneNumber } = await import("./integrations/quo/index.js");
  const line = resolveSendingLine(sessionUserSync(req), {
    defaultId: getQuoPhoneNumberId(),
    defaultNumber: getQuoPhoneNumber(),
  });
  if (!line.id) { res.status(503).json({ error: line.explain }); return; }
  try {
    const sent = await sendText({ to, content: text, from: line.id });
    /* Store our own copy immediately so the thread updates without waiting
       for the next sync — same id Quo will report, so the sync de-dupes. */
    const { upsertQuoMessage } = await import("./core/quoStore.js");
    upsertQuoMessage({
      id: sent.id,
      conversationId: sent.conversationId || "",
      phoneNumberId: sent.phoneNumberId || "",
      peerKey: phoneKey(to),
      peer: to,
      direction: "outgoing",
      text,
      status: sent.status || "sent",
      createdAt: sent.createdAt || new Date().toISOString(),
      userId: sent.userId || null,
    });
    /* Mirror onto the lead's timeline when we can identify them, so the
       contact's history shows the text alongside everything else. */
    try {
      const snap = await getDashboardSnapshot();
      const lead = snap.leads.find((l) => phoneKey(l.phone) === phoneKey(to));
      if (lead) {
        const { appendLeadActivity } = await import("./core/db.js");
        await appendLeadActivity(lead.id, [{
          type: "text_sent",
          description: `SMS (Quo${line.number ? " from " + line.number : ""}): ${text}`,
          timestamp: new Date().toISOString(),
        }]);
      }
    } catch { /* the text went out; timeline mirroring is best-effort */ }
    /* Report the line back. The operator should be able to see which number a
       message actually left on without opening Quo. */
    res.json({ ok: true, id: sent.id, to, status: sent.status, sentFrom: line });
  } catch (err) {
    const e = err as { message?: string; status?: number };
    res.status(502).json({ error: e.message || String(err), status: e.status ?? null, sentFrom: line });
  }
});

/**
 * Register (or confirm) the inbound webhook with Quo, pointed at this app.
 * Called at boot when a public base URL is known, and exposed so it can be
 * re-run by hand after a URL change.
 */
app.post("/api/quo/register-webhook", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { ensureMessageWebhook } = await import("./integrations/quo/index.js");
  try {
    const url = await quoWebhookUrl(typeof req.body?.baseUrl === "string" ? req.body.baseUrl : undefined);
    if (!url) { res.status(400).json({ error: "No public base URL — set PUBLIC_BASE_URL or pass baseUrl" }); return; }
    const out = await ensureMessageWebhook(url);
    res.json({ ok: true, ...out, url });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/quo/sync", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { syncQuoMessages } = await import("./core/quoSync.js");
  const full = req.body?.full === true || req.query.full === "1";
  const result = await syncQuoMessages({ full });
  res.status(result.ok ? 200 : 502).json(result);
});

/**
 * Inbound webhook (message.received / message.delivered). Unauthenticated by
 * necessity — Quo calls it — so it is deliberately narrow: it only accepts a
 * message-shaped payload for our own phone number, stores it, and returns 200.
 * A poll runs regardless, so a dropped or spoofed webhook changes nothing that
 * the next sync would not correct.
 */
app.post("/api/quo/webhook", express.json({ limit: "256kb" }), async (req, res) => {
  try {
    const { quoWebhookSecret } = await import("./integrations/quo/index.js");
    const secret = quoWebhookSecret();
    /* Quo offers no request signing, so the guard is the `?key=` we put on the
       URL when registering. A wrong or missing key is answered 202 rather than
       401 — a probe learns nothing, and Quo would only retry on an error. */
    if (!secret || String(req.query.key || "") !== secret) {
      res.status(202).json({ ok: true });
      return;
    }
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const data = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
    const id = typeof data.id === "string" ? data.id : "";
    const direction = data.direction === "outgoing" ? "outgoing" : "incoming";
    const from = typeof data.from === "string" ? data.from : "";
    const to = Array.isArray(data.to) ? String((data.to as unknown[])[0] || "") : "";
    const peer = direction === "outgoing" ? to : from;
    if (!id || !peer) { res.status(202).json({ ok: true, ignored: "not a message payload" }); return; }
    const { phoneKey } = await import("./integrations/quo/index.js");
    const { upsertQuoMessage } = await import("./core/quoStore.js");
    upsertQuoMessage({
      id,
      conversationId: typeof data.conversationId === "string" ? data.conversationId : "",
      phoneNumberId: typeof data.phoneNumberId === "string" ? data.phoneNumberId : "",
      peerKey: phoneKey(peer),
      peer,
      direction,
      text: typeof data.text === "string" ? data.text : "",
      status: typeof data.status === "string" ? data.status : "",
      createdAt: typeof data.createdAt === "string" ? data.createdAt : new Date().toISOString(),
      userId: typeof data.userId === "string" ? data.userId : null,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(200).json({ ok: false, error: (err as Error).message });
  }
});

/* ============ Listing Alerts & Market Reports — client MLS subscriptions ====
   A Listing Alert keeps a buyer engaged between the first conversation and
   being ready to write an offer; a Market Report does the same job for a
   homeowner who is not shopping. Both run off the live SABOR mirror, both send
   over SMTP, and both log what the contact did with the email — which is the
   signal the whole feature exists to produce.

   The /r/* routes are PUBLIC by necessity: they are the links and pixel inside
   an email a client opens outside the CRM. They take an opaque send id, do one
   narrow thing, and never expose contact data.
=========================================================================== */

/** Vocabulary the board actually uses — the builders render only what is here. */
/**
 * Is the DM agent's intent gate actually working?
 *
 * WHY THIS EXISTS. `/health` reports `api_key_configured`, which only proves an
 * environment variable is set — it has never proved the key can bill a call. If
 * the Anthropic account is rate-limited or out of credit, every call throws,
 * `classifyNewLeadBuyingIntent` FAILS OPEN by design (so a real buyer is never
 * dropped), and the agent answers every inbound message regardless of content.
 * From the outside that is indistinguishable from the agent deciding to reply
 * to everyone — which is exactly the symptom it produces. This endpoint makes
 * the difference visible: one real 1-token call, plus the in-memory ledger of
 * how often the gate has fallen open recently and why.
 */
app.get("/api/llm/health", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { anthropicLiveCheck, failOpenReport } = await import("./integrations/llm/index.js");
  const { gateReport } = await import("./app/intentGateLedger.js");
  const minutes = Math.min(1440, Math.max(5, Number(req.query.minutes) || 120));
  const live = await anthropicLiveCheck();
  const failOpen = failOpenReport(minutes);
  const gate = gateReport(minutes);

  /* Say plainly what this means for the DM agent. There are THREE ways it can
     reply without judging the message, and they need different answers, so the
     verdict names which one is actually happening. */
  const skipped = gate.byOutcome.skipped_prev_out || 0;
  let verdict: string;
  if (!live.ok) {
    verdict =
      `The Anthropic API is FAILING (${live.kind}${live.status ? " / HTTP " + live.status : ""}). ` +
      `While this lasts the intent gate fails open, so the agent replies to every new contact whose ` +
      `message is not caught by the deterministic short-message rules — spam and social chat included.`;
  } else if (skipped > 0 && skipped >= gate.total / 2) {
    verdict =
      `The API is fine, but the intent gate was BYPASSED on ${skipped} of ${gate.total} new contacts — ` +
      `their inbound payload carried a "marco_previous_outbound" value, which skips the gate entirely ` +
      `for TikTok and Instagram DMs. That is a ManyChat flow setting, not a change in this codebase, ` +
      `and it makes the agent reply to every new contact regardless of what they wrote.`;
  } else if ((gate.byOutcome.canned_redirect || 0) > 0 &&
             (gate.byOutcome.canned_redirect || 0) >= gate.total / 2) {
    const byReason: Record<string, number> = {};
    for (const r of gate.recent) if (r.outcome === "canned_redirect" && r.reason) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
    verdict =
      `The API and the gate are both fine. ${gate.byOutcome.canned_redirect} of ${gate.total} inbound messages ` +
      `got a CANNED REDIRECT — the pipeline answers realtors, business pitches and explicit declines with a fixed ` +
      `reply before the intent gate is ever consulted. That is by design, but from the inbox it looks exactly like ` +
      `the agent replying to anybody. Breakdown: ${JSON.stringify(byReason)}.`;
  } else if (failOpen.total > 0) {
    verdict =
      `The API answers now, but the gate fell open ${failOpen.total} time(s) in the last ${minutes} minutes. ` +
      `Each was a new contact the agent replied to without judging whether they were a real lead.`;
  } else if (gate.total === 0) {
    verdict =
      `No new contacts have hit the gate in the last ${minutes} minutes (process has been up ` +
      `${gate.uptimeMinutes} min). Nothing to judge yet — this is not evidence either way.`;
  } else {
    verdict = `Healthy — the gate judged ${gate.total} new contact(s) and rejected ${gate.byOutcome.rejected_by_model || 0}.`;
  }

  res.json({
    ok: live.ok && skipped === 0 && failOpen.total === 0,
    verdict,
    live,
    gate,
    failOpen,
    note:
      "Both ledgers are in-memory and reset on deploy, so a zero here means nothing if uptimeMinutes is small. " +
      "The gate only runs for NEW contacts; an existing conversation always gets a reply by design.",
  });
});

app.get("/api/mls/facets", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { getMlsFacets } = await import("./core/mlsFacets.js");
  try {
    res.json(getMlsFacets(req.query.refresh === "1"));
  } catch (err) {
    res.status(503).json({ error: (err as Error).message, hint: "The MLS mirror is not readable — check /api/mls/status." });
  }
});

/** Live match count + a sample, so criteria are sanity-checked before saving. */
app.post("/api/outreach/preview", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { countMatching, findMatching, describeCriteria } = await import("./core/listingCriteria.js");
  const criteria = (req.body?.criteria && typeof req.body.criteria === "object" ? req.body.criteria : {}) as Record<string, unknown>;
  try {
    res.json({
      ok: true,
      count: countMatching(criteria),
      summary: describeCriteria(criteria),
      /* 24 so the "VIEW N LISTINGS" peek can show a full grid; the count
         above is exact regardless of how many rows come back here. */
      sample: findMatching(criteria, Math.min(24, Number(req.body?.limit) || 6)),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* -------------------------------------------------------- listing alerts -- */

/**
 * Everything the contact profile's right rail needs, in one call: their alerts,
 * their market reports, and what they have actually DONE with them.
 *
 * One endpoint rather than three because the rail paints as a unit — three
 * round trips would render the blocks at three different moments, and the
 * engagement feed is meaningless without the subscriptions it refers to.
 */
app.get("/api/leads/:id/outreach", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const leadId = String(req.params.id);
  const { listAlerts, listReports, listSends, engagementForLead } = await import("./core/outreachStore.js");
  const { countMatching, describeCriteria } = await import("./core/listingCriteria.js");
  const { isSmtpConfigured } = await import("./integrations/smtp/index.js");
  let mlsReady = false;
  try {
    const { listingCounts } = await import("./core/listingsStore.js");
    mlsReady = listingCounts().total > 0;
  } catch { mlsReady = false; }
  res.json({
    ok: true,
    canSendEmail: isSmtpConfigured(),
    mlsReady,
    alerts: listAlerts(leadId).map((a) => ({
      ...a,
      summary: describeCriteria(a.criteria),
      matchesNow: mlsReady ? countMatching(a.criteria) : null,
      sends: listSends(a.id, 5),
    })),
    reports: listReports(leadId).map((r) => ({ ...r, sends: listSends(r.id, 5) })),
    engagement: engagementForLead(leadId, 40),
  });
});

app.post("/api/leads/:id/listing-alerts", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const leadId = String(req.params.id);
  const lead = await getLeadById(leadId);
  if (!lead) { res.status(404).json({ error: "No such contact" }); return; }
  const b = (req.body || {}) as Record<string, unknown>;
  const name = String(b.name || "").trim();
  if (!name) { res.status(400).json({ error: "A name for the alert is required" }); return; }

  const { insertAlert, newId } = await import("./core/outreachStore.js");
  const { nextAlertSend, sendAlertNow } = await import("./core/outreachRunner.js");
  const { ALERT_FREQUENCIES } = await import("./core/outreachStore.js");
  const freq = ALERT_FREQUENCIES.includes(String(b.frequency)) ? String(b.frequency) : "daily";
  const now = new Date().toISOString();
  const alert = insertAlert({
    id: newId("la"),
    leadId,
    name,
    cc: typeof b.cc === "string" && b.cc.trim() ? b.cc.trim() : null,
    sendEmail: b.sendEmail !== false,
    frequency: freq as import("./core/outreachStore.js").AlertFrequency,
    criteria: (b.criteria && typeof b.criteria === "object" ? b.criteria : {}) as Record<string, unknown>,
    paused: false,
    createdAt: now,
    updatedAt: now,
    lastSentAt: null,
    nextSendAt: nextAlertSend(freq as import("./core/outreachStore.js").AlertFrequency),
    lastMatchCount: null,
    createdBy: (await currentSessionUser(req))?.name ?? null,
  });

  /* Brivity's form promises an immediate first email on save, and the promise
     is the useful part — the client sees the alert working the same day. It is
     opt-out rather than silent, and a delivery failure is reported here rather
     than swallowed, because "saved" and "sent" are different claims. */
  let firstSend: unknown = null;
  if (b.sendNow !== false && alert.sendEmail) {
    firstSend = await sendAlertNow(alert.id, { force: true });
  }
  res.status(201).json({ ok: true, alert, firstSend });
});

app.patch("/api/listing-alerts/:id", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { getAlert, updateAlert } = await import("./core/outreachStore.js");
  const { nextAlertSend } = await import("./core/outreachRunner.js");
  const existing = getAlert(String(req.params.id));
  if (!existing) { res.status(404).json({ error: "No such listing alert" }); return; }
  const b = (req.body || {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim();
  if ("cc" in b) patch.cc = typeof b.cc === "string" && b.cc.trim() ? b.cc.trim() : null;
  if (typeof b.sendEmail === "boolean") patch.sendEmail = b.sendEmail;
  if (typeof b.paused === "boolean") patch.paused = b.paused;
  if (b.criteria && typeof b.criteria === "object") patch.criteria = b.criteria;
  if (["daily", "weekly", "monthly"].includes(String(b.frequency))) {
    patch.frequency = String(b.frequency);
    /* Changing the cadence has to move the next send, or a switch from monthly
       to daily would not take effect for another month. */
    patch.nextSendAt = nextAlertSend(String(b.frequency) as "daily" | "weekly" | "monthly");
  }
  res.json({ ok: true, alert: updateAlert(existing.id, patch) });
});

app.delete("/api/listing-alerts/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { deleteAlert } = await import("./core/outreachStore.js");
  res.json({ ok: deleteAlert(String(req.params.id)) });
});

app.post("/api/listing-alerts/:id/send", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { sendAlertNow } = await import("./core/outreachRunner.js");
  const out = await sendAlertNow(String(req.params.id), { force: req.body?.force !== false });
  res.status(out.ok ? 200 : 502).json(out);
});

/* -------------------------------------------------------- market reports -- */

app.post("/api/leads/:id/market-reports", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const leadId = String(req.params.id);
  const lead = await getLeadById(leadId);
  if (!lead) { res.status(404).json({ error: "No such contact" }); return; }
  const b = (req.body || {}) as Record<string, unknown>;
  const address = String(b.address || lead.address || "").trim();
  if (!address) { res.status(400).json({ error: "An address for the report is required" }); return; }

  const { insertReport, newId } = await import("./core/outreachStore.js");
  const { nextReportSend, sendReportNow } = await import("./core/outreachRunner.js");
  const { REPORT_FREQUENCIES } = await import("./core/outreachStore.js");
  const freq = REPORT_FREQUENCIES.includes(String(b.frequency))
    ? String(b.frequency) : "quarterly";
  const drip = b.drip !== false;
  const now = new Date().toISOString();
  const report = insertReport({
    id: newId("mr"),
    leadId,
    name: String(b.name || address).trim(),
    address,
    cc: typeof b.cc === "string" && b.cc.trim() ? b.cc.trim() : null,
    frequency: freq as import("./core/outreachStore.js").ReportFrequency,
    drip,
    criteria: (b.criteria && typeof b.criteria === "object" ? b.criteria : {}) as Record<string, unknown>,
    subject: (b.subject && typeof b.subject === "object" ? b.subject : {}) as Record<string, number>,
    adjustedValue: typeof b.adjustedValue === "number" && Number.isFinite(b.adjustedValue) ? b.adjustedValue : null,
    includeHomeValue: b.includeHomeValue !== false,
    emailMessage: typeof b.emailMessage === "string" && b.emailMessage.trim() ? b.emailMessage.trim() : null,
    paused: false,
    createdAt: now,
    updatedAt: now,
    lastSentAt: null,
    /* Save & Close schedules the first drip for one interval out; Send Now
       delivers immediately and starts the clock from today. */
    nextSendAt: drip ? nextReportSend(freq as import("./core/outreachStore.js").ReportFrequency) : null,
    lastViewedAt: null,
    viewCount: 0,
    createdBy: (await currentSessionUser(req))?.name ?? null,
  });

  let firstSend: unknown = null;
  if (b.sendNow === true) firstSend = await sendReportNow(report.id);
  res.status(201).json({ ok: true, report, firstSend });
});

app.patch("/api/market-reports/:id", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { getReport, updateReport } = await import("./core/outreachStore.js");
  const { nextReportSend } = await import("./core/outreachRunner.js");
  const existing = getReport(String(req.params.id));
  if (!existing) { res.status(404).json({ error: "No such market report" }); return; }
  const b = (req.body || {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim();
  if (typeof b.address === "string" && b.address.trim()) patch.address = b.address.trim();
  if ("cc" in b) patch.cc = typeof b.cc === "string" && b.cc.trim() ? b.cc.trim() : null;
  if (typeof b.paused === "boolean") patch.paused = b.paused;
  if (typeof b.includeHomeValue === "boolean") patch.includeHomeValue = b.includeHomeValue;
  if ("adjustedValue" in b) {
    patch.adjustedValue = typeof b.adjustedValue === "number" && Number.isFinite(b.adjustedValue) ? b.adjustedValue : null;
  }
  if ("emailMessage" in b) patch.emailMessage = typeof b.emailMessage === "string" && b.emailMessage.trim() ? b.emailMessage.trim() : null;
  if (b.criteria && typeof b.criteria === "object") patch.criteria = b.criteria;
  if (b.subject && typeof b.subject === "object") patch.subject = b.subject;
  if (typeof b.drip === "boolean") {
    patch.drip = b.drip;
    patch.nextSendAt = b.drip ? nextReportSend(existing.frequency) : null;
  }
  const { REPORT_FREQUENCIES: RF } = await import("./core/outreachStore.js");
  if (RF.includes(String(b.frequency))) {
    patch.frequency = String(b.frequency);
    if (patch.drip !== false && existing.drip) {
      patch.nextSendAt = nextReportSend(String(b.frequency) as import("./core/outreachStore.js").ReportFrequency);
    }
  }
  res.json({ ok: true, report: updateReport(existing.id, patch) });
});

app.delete("/api/market-reports/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { deleteReport } = await import("./core/outreachStore.js");
  res.json({ ok: deleteReport(String(req.params.id)) });
});

/** What the report currently says — the preview, before anything is sent. */
app.get("/api/market-reports/:id/preview", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { getReport } = await import("./core/outreachStore.js");
  const { buildMarketReport } = await import("./core/marketReport.js");
  const { anchorFor } = await import("./core/outreachRunner.js");
  const report = getReport(String(req.params.id));
  if (!report) { res.status(404).json({ error: "No such market report" }); return; }
  try {
    res.json({
      ok: true,
      report,
      built: buildMarketReport({
        criteria: report.criteria, anchor: anchorFor(report),
        subject: report.subject, adjustedValue: report.adjustedValue,
      }),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Build a report from unsaved criteria — powers the modal's live preview. */
app.post("/api/market-reports/preview", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { buildMarketReport, postalFromAddress, cityFromAddress } = await import("./core/marketReport.js");
  const b = (req.body || {}) as Record<string, unknown>;
  const address = String(b.address || "").trim();
  const criteria = (b.criteria && typeof b.criteria === "object" ? b.criteria : {}) as Record<string, unknown>;
  try {
    res.json({
      ok: true,
      built: buildMarketReport({
        criteria,
        anchor: {
          postalCode: (criteria as { postalCodes?: string[] }).postalCodes?.[0] || postalFromAddress(address),
          city: (criteria as { cities?: string[] }).cities?.[0] || (address ? cityFromAddress(address) : null),
        },
        subject: (b.subject && typeof b.subject === "object" ? b.subject : {}) as Record<string, number>,
        adjustedValue: typeof b.adjustedValue === "number" ? b.adjustedValue : null,
      }),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/market-reports/:id/send", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { sendReportNow } = await import("./core/outreachRunner.js");
  const out = await sendReportNow(String(req.params.id));
  res.status(out.ok ? 200 : 502).json(out);
});

/* ------------------------------------------------------- run + coverage --- */

app.get("/api/outreach/status", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { outreachCounts, hotEngagement } = await import("./core/outreachStore.js");
  const { listingCounts, lastSuccessfulSync } = await import("./core/listingsStore.js");
  const { isSmtpConfigured } = await import("./integrations/smtp/index.js");
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  let mls: unknown = null;
  try { mls = { ...listingCounts(), lastSyncAt: lastSuccessfulSync()?.finishedAt ?? null }; } catch { mls = null; }
  res.json({
    ok: true,
    ...outreachCounts(),
    canSendEmail: isSmtpConfigured(),
    mls,
    engagedLast14Days: hotEngagement(since, 20),
  });
});

app.post("/api/outreach/run", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { runOutreach } = await import("./core/outreachRunner.js");
  res.json(await runOutreach());
});

/**
 * The hygiene check Brivity's "Listing Alerts: None Created" filter exists for:
 * a buyer-intent contact with no alert running is one you are under-serving.
 */
app.get("/api/outreach/coverage", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { listAlerts, listReports } = await import("./core/outreachStore.js");
  const snap = await getDashboardSnapshot();
  const withAlert = new Set(listAlerts().map((a) => a.leadId));
  const withReport = new Set(listReports().map((r) => r.leadId));
  const dead = new Set(["dead", "unresponsive"]);
  const buyers = snap.leads.filter(
    (l) => l.crmIntent !== "seller" && !!l.email && !dead.has(String(l.crmStatus || "")),
  );
  const sellers = snap.leads.filter(
    (l) => l.crmIntent === "seller" && !!l.email && !dead.has(String(l.crmStatus || "")),
  );
  const brief = (l: { id: string; name: string | null; email?: string | null; crmStatus?: string | null }) =>
    ({ id: l.id, name: l.name, email: l.email ?? null, status: l.crmStatus ?? null });
  res.json({
    ok: true,
    buyersTotal: buyers.length,
    buyersWithoutAlert: buyers.filter((l) => !withAlert.has(l.id)).map(brief),
    sellersTotal: sellers.length,
    sellersWithoutReport: sellers.filter((l) => !withReport.has(l.id)).map(brief),
    note: "Contacts with no email address are excluded — an alert with nowhere to send is not a gap this list can close.",
  });
});

/* ------------------------------------------------ public tracking links --- */

const TRACKING_PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64",
);

/** Open pixel. Always answers with the image, whatever the id turns out to be. */
app.get("/r/open", async (req, res) => {
  try {
    const sendId = String(req.query.s || "");
    if (sendId) {
      const { getOutreachDb, markSendOpened } = await import("./core/outreachStore.js");
      const row = getOutreachDb()
        .prepare(`SELECT kind, subscription_id, lead_id FROM outreach_sends WHERE id = ?`)
        .get(sendId) as Record<string, unknown> | undefined;
      if (row) {
        markSendOpened(sendId);
        const { recordEngagement } = await import("./core/outreachStore.js");
        recordEngagement({
          kind: row.kind === "report" ? "report" : "alert",
          subscriptionId: String(row.subscription_id),
          leadId: String(row.lead_id),
          event: "email_opened",
        });
      }
    }
  } catch { /* tracking must never break the image */ }
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.end(TRACKING_PIXEL);
});

/** Click-through. Logs intent, then sends the client to the listing page. */
app.get("/r/click", async (req, res) => {
  const sendId = String(req.query.s || "");
  const listingKey = String(req.query.l || "");
  let target = `/l/${encodeURIComponent(listingKey)}`;
  try {
    const { getOutreachDb } = await import("./core/outreachStore.js");
    const { noteEngagement } = await import("./core/outreachRunner.js");
    const row = getOutreachDb()
      .prepare(`SELECT kind, subscription_id, lead_id FROM outreach_sends WHERE id = ?`)
      .get(sendId) as Record<string, unknown> | undefined;
    if (row && listingKey) {
      const { getListing } = await import("./core/listingsStore.js");
      const l = getListing(listingKey);
      const where = l ? [l.street, l.city].filter(Boolean).join(", ") : listingKey;
      await noteEngagement({
        kind: row.kind === "report" ? "report" : "alert",
        subscriptionId: String(row.subscription_id),
        leadId: String(row.lead_id),
        event: "listing_clicked",
        listingKey,
        description: `Clicked into ${where} from a ${row.kind === "report" ? "market report" : "listing alert"}`,
      });
    }
  } catch { /* a tracking failure must not strand the client */ }
  res.redirect(302, target);
});

/** One-click stop. Pauses rather than deletes, so the agent still sees it. */
app.get("/r/stop", async (req, res) => {
  const kind = String(req.query.k || "");
  const id = String(req.query.id || "");
  let done = false;
  try {
    const { updateAlert, updateReport, getAlert, getReport } = await import("./core/outreachStore.js");
    if (kind === "alert" && getAlert(id)) { updateAlert(id, { paused: true, sendEmail: false }); done = true; }
    if (kind === "report" && getReport(id)) { updateReport(id, { paused: true, drip: false }); done = true; }
  } catch { /* fall through to the honest message */ }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#1F2933;line-height:1.6">
<h1 style="font-size:22px">${done ? "You're unsubscribed" : "We couldn't find that subscription"}</h1>
<p style="color:#6B7280">${done
    ? "You won't get any more of these emails. If you'd still like to hear from Marco directly, just reply to any earlier message."
    : "That link may have already been used, or the subscription was removed. Reply to any earlier email and Marco will sort it out."}</p>
</div>`);
});

/** The full report a client sees from the email. Logs the view. */
app.get("/r/report", async (req, res) => {
  const id = String(req.query.id || "");
  const sendId = String(req.query.s || "");
  try {
    const { getReport, updateReport } = await import("./core/outreachStore.js");
    const { buildMarketReport } = await import("./core/marketReport.js");
    const { anchorFor, noteEngagement } = await import("./core/outreachRunner.js");
    const report = getReport(id);
    if (!report) { res.status(404).send(publicShell("That report is no longer available.", "")); return; }
    const built = buildMarketReport({
      criteria: report.criteria, anchor: anchorFor(report),
      subject: report.subject, adjustedValue: report.adjustedValue, compLimit: 12,
    });
    updateReport(report.id, { lastViewedAt: new Date().toISOString(), viewCount: report.viewCount + 1 });
    await noteEngagement({
      kind: "report", subscriptionId: report.id, leadId: report.leadId,
      event: "report_viewed",
      description: `Opened their market report for ${report.address}`,
    });
    void sendId;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderPublicReport(report, built));
  } catch (err) {
    res.status(500).send(publicShell("We couldn't build that report just now.", (err as Error).message));
  }
});

/** Published CMA — the client-facing page step 7 creates. */
app.get("/c/:id", async (req, res) => {
  try {
    const store = await import("./core/cmaStore.js");
    const { cmaResults } = await import("./core/cmaComps.js");
    const { renderPublicCma } = await import("./core/outreachPublicPages.js");
    const session = store.getSession(String(req.params.id));
    /* A draft is deliberately indistinguishable from a missing one out here.
       An unpublished CMA is unfinished work on a client's house, and "this
       exists but you may not see it" is itself a disclosure. */
    if (!session || session.status !== "published") {
      res.status(404).send(publicShell("That report is not available.",
        "The link may have expired, or the report may not have been published yet. Reply to Marco and he'll re-send it."));
      return;
    }
    const comps = store.listComparables(session.id);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderPublicCma(session, comps, cmaResults(session, comps)));
  } catch (err) {
    res.status(500).send(publicShell("We couldn't load that report.", (err as Error).message));
  }
});

/** Public listing page — where an email click-through lands. */
app.get("/l/:key", async (req, res) => {
  try {
    const { getListing } = await import("./core/listingsStore.js");
    const found = getListing(String(req.params.key));
    if (!found) {
      res.status(404).send(publicShell("That home is no longer on the market.",
        "It may have gone under contract or been withdrawn. Reply to Marco's email and he'll find you something similar."));
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderPublicListing(found));
  } catch (err) {
    res.status(500).send(publicShell("We couldn't load that listing.", (err as Error).message));
  }
});

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

/* ── Brivity live import — real CRM contacts for the new /crm UI ── */
app.get("/api/brivity/people", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  try {
    const people = await getBrivityPeople(req.query.refresh === "1");
    res.status(200).json({ ok: true, ...getBrivityImportStatus(), count: people.length, people });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ ok: false, error: message, ...getBrivityImportStatus() });
  }
});

/**
 * Plan an import of Brivity contacts into the lead store.
 *
 * Read-only: this endpoint never writes. Applying is a separate, deliberate
 * step that has to avoid db.createLead()'s outbound SMS/email hooks — see the
 * header of core/brivityImport.ts.
 */
app.post("/api/brivity/import/plan", express.json({ limit: "16kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  try {
    const { planBrivityImport } = await import("./core/brivityImport.js");
    const plan = await planBrivityImport({
      includeDead: body.includeDead === true,
      preferBrivityName: body.preferBrivityName !== false,
    });
    // Full lists are large; callers asking for a summary get counts only.
    if (body.summary === true) {
      const { creates, merges, ...rest } = plan;
      res.json({ ok: true, ...rest, sampleCreates: creates.slice(0, 10), sampleMerges: merges.slice(0, 10) });
      return;
    }
    res.json({ ok: true, ...plan });
  } catch (err) {
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * Apply a Brivity import. Re-plans server-side first so the write is against
 * current data, then writes via the quiet path (no Twilio/email automations).
 * Requires an explicit {"apply": true}.
 */
app.post("/api/brivity/import/apply", express.json({ limit: "16kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  if (body.apply !== true) {
    res.status(400).json({ ok: false, error: 'Refusing to write without {"apply": true}' });
    return;
  }
  try {
    const { planBrivityImport, applyBrivityImport } = await import("./core/brivityImport.js");
    const plan = await planBrivityImport({
      includeDead: body.includeDead === true,
      enrichDeadMatches: body.enrichDeadMatches !== false,
      preferBrivityName: body.preferBrivityName !== false,
    });
    const result = await applyBrivityImport(plan);
    res.json({
      ok: true,
      planned: { create: plan.counts.create, merge: plan.counts.merge, renames: plan.counts.renames },
      ...result,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
});

/* ===================== Harvey jobs + workspace =====================
   A job runs the agent loop to completion detached from this request, so work
   that needs dozens of tool calls and minutes of wall time can be delegated. */

app.post("/api/harvey/jobs", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const prompt = typeof body.task === "string" ? body.task.trim() : "";
  if (!prompt) { res.status(400).json({ ok: false, error: "task is required" }); return; }
  try {
    const { startJob, isAnthropicConfigured } = await import("./hull/jobRunner.js");
    if (!isAnthropicConfigured()) {
      res.status(503).json({ ok: false, error: "ANTHROPIC_API_KEY is not set." });
      return;
    }
    const job = startJob(prompt, typeof body.createdBy === "string" ? body.createdBy : "marco");
    res.status(202).json({ ok: true, job });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.get("/api/harvey/jobs", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { listJobs, jobCounts } = await import("./core/jobStore.js");
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  res.json({ ok: true, counts: jobCounts(), jobs: listJobs(limit) });
});

app.get("/api/harvey/jobs/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { getJob } = await import("./core/jobStore.js");
  const job = getJob(String(req.params.id));
  if (!job) { res.status(404).json({ ok: false, error: "No such job" }); return; }
  res.json({ ok: true, job });
});

app.post("/api/harvey/jobs/:id/cancel", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { requestCancel, getJob } = await import("./core/jobStore.js");
  const ok = requestCancel(String(req.params.id));
  res.json({ ok, job: getJob(String(req.params.id)) });
});

/**
 * Serve a workspace file as an actual download rather than JSON.
 *
 * Registered BEFORE `/api/harvey/workspace` so the more specific path wins.
 * The JSON reader is right for rendering a preview in the page; it is useless
 * when someone wants the file itself — which is the normal thing to want with a
 * call list. `safePath` still does the containment check, so this cannot be
 * walked out of the workspace.
 */
const WORKSPACE_MIME: Record<string, string> = {
  ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv",
  ".json": "application/json", ".html": "text/html", ".yaml": "text/yaml",
  ".log": "text/plain", ".tsv": "text/tab-separated-values", ".xml": "application/xml",
  ".sql": "application/sql", ".ics": "text/calendar",
};
/**
 * Whether Harvey can run code here, and precisely what that does and does not
 * protect. Stated rather than implied — "hardened" and "sandboxed" are not the
 * same claim and the difference is the whole point of Phase B.
 */
/** Remove a finished job. Running jobs must be cancelled first — see deleteJob. */
app.delete("/api/harvey/jobs/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { deleteJob } = await import("./core/jobStore.js");
  const r = deleteJob(String(req.params.id || ""));
  if (!r.deleted) { res.status(400).json({ ok: false, error: r.reason }); return; }
  res.json({ ok: true, deleted: true });
});

/**
 * Delete a workspace file.
 *
 * Separate from job deletion on purpose: a job record and the file it produced
 * are different things, and removing one should never silently remove the other.
 */
app.delete("/api/harvey/workspace", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const ws = await import("./core/workspace.js");
  try {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    if (!path) { res.status(400).json({ ok: false, error: "path is required" }); return; }
    const deleted = await ws.deleteFile(path);
    if (!deleted) { res.status(404).json({ ok: false, error: `No such file: ${path}` }); return; }
    res.json({ ok: true, deleted: true, path });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

app.get("/api/harvey/exec-status", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { execStatus } = await import("./core/codeExec.js");
  res.json({ ok: true, ...execStatus() });
});

app.get("/api/harvey/workspace/download", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const ws = await import("./core/workspace.js");
  try {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    if (!rel) { res.status(400).json({ ok: false, error: "path is required" }); return; }
    const file = await ws.readFile(rel);
    const base = file.path.split("/").pop() || "file";
    const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")).toLowerCase() : "";
    // inline=1 opens it in the browser instead of saving it — useful for .md/.html.
    const disposition = req.query.inline === "1" ? "inline" : "attachment";
    res.setHeader("Content-Type", (WORKSPACE_MIME[ext] || "text/plain") + "; charset=utf-8");
    res.setHeader("Content-Disposition", `${disposition}; filename="${base.replace(/"/g, "")}"`);
    res.send(file.content);
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

app.get("/api/harvey/workspace", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const ws = await import("./core/workspace.js");
  try {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    if (path) { res.json({ ok: true, file: await ws.readFile(path) }); return; }
    res.json({ ok: true, files: await ws.listFiles(String(req.query.prefix || "")) });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

app.get("/api/brivity/status", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.status(200).json(getBrivityImportStatus());
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

    // Recompute the score breakdown from live engagement rather than trusting
    // the stored sub-score columns, which can be 0 for rows persisted before
    // breakdown scoring (that was the "real views, 0 bars" bug). scoreVideos
    // derives its own max from this set — no external benchmark needed.
    if (videos.length) {
      const rescored = scoreVideos(videos as unknown as Parameters<typeof scoreVideos>[0]);
      const byId = new Map(rescored.videos.map((r) => [r.id, r]));
      videos = videos.map((v) => {
        const r = byId.get(v.id);
        return r ? { ...v, score: r.score, tier: r.tier, scoreBreakdown: r.scoreBreakdown } : v;
      });
    }

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

// Clear Storage — reuses the proven state-aware safe cleanup (never touches
// files for jobs still processing or clips not yet reviewed). No new deletion
// logic; this is a thin wrapper around runSafetyDiskCleanup().
app.post("/api/content/clear-storage", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  try {
    const freeBeforeMB = await getFreeDiskMB();
    const { deleted, freedBytes } = await runSafetyDiskCleanup();
    const freeAfterMB = await getFreeDiskMB();
    res.json({
      ok: true,
      deleted,
      freedBytes,
      freedGB: Math.round((freedBytes / (1024 * 1024 * 1024)) * 100) / 100,
      freeBeforeMB: Number.isFinite(freeBeforeMB) ? freeBeforeMB : null,
      freeAfterMB: Number.isFinite(freeAfterMB) ? freeAfterMB : null,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
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
    const videos = data.videos || [];
    const video = videos.find((v) => v.id === postId);

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

    const avgViews = videos.length
      ? videos.reduce((s, v) => s + (v.views || 0), 0) / videos.length
      : 0;
    const topViews = videos.reduce((m, v) => Math.max(m, v.views || 0), 0);

    const improvements = await generateVideoImprovements({
      description: video.caption || "",
      views: video.views || 0,
      likes: video.likes || 0,
      comments: video.comments || 0,
      shares: video.shares || 0,
      saves: video.saves || 0,
      scoreBreakdown: breakdown,
      avgViews,
      isTopPerformer: topViews > 0 && (video.views || 0) >= topViews,
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

    const avgViews = videos.length
      ? videos.reduce((s, v) => s + (v.views || 0), 0) / videos.length
      : 0;
    const topViews = videos.reduce((m, v) => Math.max(m, v.views || 0), 0);

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
        avgViews,
        isTopPerformer: topViews > 0 && (video.views || 0) >= topViews,
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

// CapCut transition reference — filtered by content type, or the real-estate
// "best of" list when no type is given. Powers the guided editor + feedback tips.
app.get("/api/content/transitions", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const contentType = typeof req.query.type === "string" ? req.query.type : "";
  const transitions = contentType
    ? getTransitionsForContentType(contentType as ContentType)
    : getTopTransitionsForRealEstate();
  res.json({ transitions });
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
  /* Links a lead to a specific MLS listing. Set from the MLS tab inside the
     CRM ("set as their property"), which is the only way to make the link by
     hand — otherwise it is written by the DM pipeline on an exact match. */
  const mlsListingKey =
    body.mlsListingKey === null
      ? null
      : typeof body.mlsListingKey === "string"
        ? body.mlsListingKey.trim() || null
        : undefined;
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
  const address =
    body.address === null ? null : typeof body.address === "string" ? body.address : undefined;
  const strOrNull = (key: string): string | null | undefined => {
    const v = body[key];
    if (v === undefined) return undefined;
    if (v === null) return null;
    return typeof v === "string" ? v : undefined;
  };
  const description = strOrNull("description");
  const letterSalutation = strOrNull("letterSalutation");
  const envelopeSalutation = strOrNull("envelopeSalutation");
  const preferredLanguage = strOrNull("preferredLanguage");
  const relationships = body.relationships !== undefined ? body.relationships : undefined;
  /* Date-only fields: accepted as YYYY-MM-DD, null clears, junk is a 400 —
     a garbled birthday silently stored would poison the Dates filters. */
  const parseDay = (key: "birthday" | "homeAnniversary"): string | null | undefined => {
    const v = body[key];
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) && !Number.isNaN(new Date(v.trim() + "T00:00:00Z").getTime())) {
      return v.trim();
    }
    throw Object.assign(new Error(`${key} must be YYYY-MM-DD or null`), { statusCode: 400 });
  };
  let birthday: string | null | undefined;
  let homeAnniversary: string | null | undefined;
  try {
    birthday = parseDay("birthday");
    homeAnniversary = parseDay("homeAnniversary");
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  let criteria: Record<string, unknown> | null | undefined = undefined;
  if (body.criteria === null) criteria = null;
  else if (body.criteria && typeof body.criteria === "object") {
    const c = body.criteria as Record<string, unknown>;
    criteria = {};
    if ("priceCap" in c) {
      const n = c.priceCap;
      const parsed = n === null || n === "" ? null : typeof n === "number" ? n : Number(n);
      /* A ten-digit "budget" is a phone number. Refused on the way in rather
         than stored and then worked around by every reader. */
      criteria.priceCap = isJunkPriceCap(parsed) ? null : parsed;
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
      const raw = c.area === null ? null : typeof c.area === "string" ? c.area : String(c.area);
      /* Resolve to a real city on the way in, so a hand-typed "san antonio"
         becomes "San Antonio" and actually matches listings.city. Anything
         that is not a place is stored as null rather than as a fragment. */
      criteria.area = raw === null ? null : normalizeArea(raw);
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
      mlsListingKey,
      criteria: criteria as any,
      tags,
      address,
      birthday,
      homeAnniversary,
      description,
      letterSalutation,
      envelopeSalutation,
      preferredLanguage,
      relationships,
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
    const actor = await currentSessionUser(req);
    const { recordAudit } = await import("./core/authStore.js");
    recordAudit({ userId: actor?.id, userName: actor?.name, action: "lead.delete", detail: `${deleted} lead(s)`, req });
    res.json({ deleted, requested: ids.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
}

/**
 * Lead CSV import — Mojo exports, website form dumps, any contact CSV.
 *
 * Dry run by default (POST the csv, read the plan), {"apply":true} commits.
 * Writes go through upsertLeadQuiet — a bulk file must never fire the
 * new-lead automations (Twilio texts to Marco/Carlos, drip enrollment).
 */
app.post("/api/leads/import-csv", express.json({ limit: "8mb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const csv = typeof body.csv === "string" ? body.csv : "";
  if (!csv.trim()) {
    res.status(400).json({ ok: false, error: 'csv is required — {"csv":"…", "apply":true, "source":"Mojo"}' });
    return;
  }
  try {
    const { planLeadImport, applyLeadImport } = await import("./core/leadCsvImport.js");
    const plan = await planLeadImport(csv, {
      defaultSource: typeof body.source === "string" && body.source.trim() ? body.source.trim() : undefined,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
    });
    if (plan.errors.length && !plan.rows.length) {
      res.status(422).json({ ok: false, dryRun: true, ...plan, _writes: undefined });
      return;
    }
    if (body.apply !== true) {
      res.json({
        ok: true, dryRun: true,
        rowsSeen: plan.rowsSeen, create: plan.create, enrich: plan.enrich,
        skip: plan.skip, ambiguous: plan.ambiguous,
        defaultSource: plan.defaultSource,
        unmappedHeaders: plan.unmappedHeaders, errors: plan.errors,
        sample: plan.rows.slice(0, 8),
        ambiguousRows: plan.rows.filter((r) => r.action === "ambiguous").slice(0, 10),
      });
      return;
    }
    const result = await applyLeadImport(plan);
    res.json({ ok: true, dryRun: false, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.post("/api/leads/mass-delete", express.json(), handleMassDeleteLeads);
console.log("[Routes] POST /api/leads/mass-delete registered");
app.post("/api/crm/leads/mass-delete", express.json(), handleMassDeleteLeads);
console.log("[Routes] POST /api/crm/leads/mass-delete registered");

/**
 * Log a manual activity onto a lead's timeline. This is what the profile
 * page's NOTE/EMAIL/CALL/TEXT/APPOINTMENT/OTHER tabs write through — until
 * now they appended to a client array that vanished on reload. Types are the
 * honest "logged" variants: nothing here sends anything.
 */
app.post("/api/crm/lead/:id/activity", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const ALLOWED = new Set(["note", "call", "text_logged", "email_logged", "appointment", "other"]);
  const type = typeof body.type === "string" && ALLOWED.has(body.type) ? body.type : null;
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 2000) : "";
  if (!id || !type || !description) {
    res.status(400).json({ error: "type (" + [...ALLOWED].join("/") + ") and description required" });
    return;
  }
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 2000) : undefined;
  const subType = typeof body.subType === "string" && body.subType.trim() ? body.subType.trim().slice(0, 60) : undefined;
  const author = typeof body.author === "string" && body.author.trim() ? body.author.trim().slice(0, 120) : undefined;
  /* The OTHER tab logs an interaction that happened on a day the operator
     picks, so a back-dated entry is the normal case, not an edge one. It is
     accepted only as YYYY-MM-DD and only in the past — a "logged" activity
     dated next Tuesday is a scheduled thing, and that is what a task is for. */
  let timestamp = new Date().toISOString();
  if (typeof body.activityDate === "string" && body.activityDate.trim()) {
    const day = body.activityDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      res.status(400).json({ error: "activityDate must be YYYY-MM-DD" });
      return;
    }
    const when = new Date(day + "T12:00:00Z");
    if (Number.isNaN(when.getTime())) { res.status(400).json({ error: "activityDate is not a real date" }); return; }
    if (when.getTime() > Date.now() + 86400000) {
      res.status(400).json({ error: "An activity cannot be logged in the future — schedule a task instead." });
      return;
    }
    timestamp = when.toISOString();
  }
  const meta =
    body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)
      ? (body.meta as Record<string, unknown>)
      : undefined;
  try {
    const { appendLeadActivity } = await import("./core/db.js");
    const entry: import("./core/types.js").LeadActivity = { type: type as import("./core/types.js").LeadActivityType, description, timestamp };
    if (notes) entry.notes = notes;
    if (subType) entry.subType = subType;
    if (author) entry.author = author;
    if (meta) entry.meta = meta as import("./core/types.js").LeadActivity["meta"];
    /* A back-dated entry must not move "last touched" forward — the nurture
       cadence reads that field, and logging a pop-by from three weeks ago
       would otherwise reset the clock as if it happened today. Passing the
       lead's CURRENT value is what pins it; omitting the option would stamp
       `now`, which is the bug this is avoiding. */
    const backdated = timestamp < new Date(Date.now() - 60000).toISOString();
    let pin: { lastActivity?: string } | undefined;
    if (backdated) {
      const { getLeadById, normalizeCrmActivity } = await import("./core/db.js");
      const before = await getLeadById(id);
      /* "Last touched" is the most recent REAL touch. Prefer the stored value;
         fall back to the newest activity already on the record; and if there
         is nothing at all, the entry being logged is itself the most recent
         touch — which is still its own date, never today. */
      const priorNewest = normalizeCrmActivity(before?.activity)
        .map((a) => a.timestamp)
        .filter(Boolean)
        .sort()
        .pop();
      pin = { lastActivity: before?.lastActivity || priorNewest || timestamp };
    }
    const lead = await appendLeadActivity(id, [entry], pin);
    if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
    res.json({ ok: true, activity: lead.activity ?? [] });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   CONTACT RECORD — emails, phones, addresses, social, notes, documents.

   The Lead keeps its single `email`/`phone`/`address` as the PRIMARY, and
   these routes keep that field in step whenever the primary row changes.
   Nothing downstream (the lead table, the senders, the DM pipeline) has to
   know this store exists, which is the whole point.
   ═══════════════════════════════════════════════════════════════════════ */

/** Every contact-record route needs the lead to exist; 404 rather than
    writing rows for an id that is a typo. */
async function contactLeadOr404(
  req: express.Request,
  res: express.Response,
): Promise<import("./core/types.js").Lead | null> {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return null;
  }
  const id = String(req.params.id || "").trim();
  if (!id) {
    res.status(400).json({ error: "Missing lead id" });
    return null;
  }
  const { getLeadById } = await import("./core/db.js");
  const lead = await getLeadById(id);
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return null;
  }
  /* Backfill from the Lead's own single-value fields before anything else
     touches the record. Every contact predates this store, and seeding only
     on the GET meant a write that arrived first (an API caller, a second tab)
     permanently lost the contact's original email and phone. Seeding here
     runs on the first route of any kind, and only when there are no rows of
     that kind, so it can never duplicate or resurrect anything. */
  try {
    const { seedFromLead } = await import("./core/contactRecordStore.js");
    seedFromLead({ id: lead.id, email: lead.email, phone: lead.phone, address: lead.address });
  } catch (err) {
    console.error("[contactRecord] seed failed:", err);
  }
  return lead;
}

/** Push the current primary email/phone/address back onto the Lead itself. */
async function syncContactPrimaries(leadId: string): Promise<void> {
  const store = await import("./core/contactRecordStore.js");
  const { updateLeadCrmFields } = await import("./core/db.js");
  const email = store.listEmails(leadId).find((e) => e.isPrimary) || null;
  const phone = store.listPhones(leadId).find((p) => p.isPrimary) || null;
  const addr = store.listAddresses(leadId)[0] || null;
  await updateLeadCrmFields({
    leadId,
    email: email ? email.address : null,
    phone: phone ? phone.number : null,
    address: addr ? store.addressOneLine(addr) : null,
  });
}

app.get("/api/crm/lead/:id/record", async (req, res) => {
  const lead = await contactLeadOr404(req, res);
  if (!lead) return;
  try {
    const store = await import("./core/contactRecordStore.js");
    res.json({ ok: true, record: store.getContactRecord(lead.id), docTypes: store.CONTACT_DOC_TYPES });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── emails ── */

app.post("/api/crm/lead/:id/emails", express.json({ limit: "8kb" }), async (req, res) => {
  const lead = await contactLeadOr404(req, res);
  if (!lead) return;
  const body = (req.body || {}) as Record<string, unknown>;
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    res.status(400).json({ error: "A valid email address is required" });
    return;
  }
  try {
    const store = await import("./core/contactRecordStore.js");
    const row = store.addEmail(lead.id, address, body.kind, body.isPrimary === true);
    await syncContactPrimaries(lead.id);
    res.json({ ok: true, email: row, record: store.getContactRecord(lead.id) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.patch("/api/crm/contact-email/:eid", express.json({ limit: "8kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    const store = await import("./core/contactRecordStore.js");
    const patch: { address?: string; kind?: unknown; isPrimary?: boolean } = {};
    if (typeof body.address === "string") {
      const a = body.address.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) { res.status(400).json({ error: "A valid email address is required" }); return; }
      patch.address = a;
    }
    if (body.kind !== undefined) patch.kind = body.kind;
    if (body.isPrimary !== undefined) patch.isPrimary = body.isPrimary === true;
    const row = store.updateEmail(String(req.params.eid || ""), patch);
    if (!row) { res.status(404).json({ error: "Email not found" }); return; }
    await syncContactPrimaries(row.leadId);
    res.json({ ok: true, email: row, record: store.getContactRecord(row.leadId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/crm/contact-email/:eid", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/contactRecordStore.js");
    const row = store.deleteEmail(String(req.params.eid || ""));
    if (!row) { res.status(404).json({ error: "Email not found" }); return; }
    await syncContactPrimaries(row.leadId);
    res.json({ ok: true, record: store.getContactRecord(row.leadId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── phones ── */

app.post("/api/crm/lead/:id/phones", express.json({ limit: "8kb" }), async (req, res) => {
  const lead = await contactLeadOr404(req, res);
  if (!lead) return;
  const body = (req.body || {}) as Record<string, unknown>;
  const number = typeof body.number === "string" ? body.number.trim() : "";
  if (number.replace(/\D/g, "").length < 7) {
    res.status(400).json({ error: "A phone number needs at least 7 digits" });
    return;
  }
  try {
    const store = await import("./core/contactRecordStore.js");
    const row = store.addPhone(lead.id, number, body.kind, body.dnc === true, body.isPrimary === true);
    await syncContactPrimaries(lead.id);
    res.json({ ok: true, phone: row, record: store.getContactRecord(lead.id) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.patch("/api/crm/contact-phone/:pid", express.json({ limit: "8kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    const store = await import("./core/contactRecordStore.js");
    const patch: { number?: string; kind?: unknown; dnc?: boolean; isPrimary?: boolean } = {};
    if (typeof body.number === "string") {
      const n = body.number.trim();
      if (n.replace(/\D/g, "").length < 7) { res.status(400).json({ error: "A phone number needs at least 7 digits" }); return; }
      patch.number = n;
    }
    if (body.kind !== undefined) patch.kind = body.kind;
    if (body.dnc !== undefined) patch.dnc = body.dnc === true;
    if (body.isPrimary !== undefined) patch.isPrimary = body.isPrimary === true;
    const row = store.updatePhone(String(req.params.pid || ""), patch);
    if (!row) { res.status(404).json({ error: "Phone not found" }); return; }
    await syncContactPrimaries(row.leadId);
    res.json({ ok: true, phone: row, record: store.getContactRecord(row.leadId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/crm/contact-phone/:pid", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/contactRecordStore.js");
    const row = store.deletePhone(String(req.params.pid || ""));
    if (!row) { res.status(404).json({ error: "Phone not found" }); return; }
    await syncContactPrimaries(row.leadId);
    res.json({ ok: true, record: store.getContactRecord(row.leadId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── addresses ── */

app.post("/api/crm/lead/:id/addresses", express.json({ limit: "8kb" }), async (req, res) => {
  const lead = await contactLeadOr404(req, res);
  if (!lead) return;
  const body = (req.body || {}) as Record<string, unknown>;
  const street = typeof body.street === "string" ? body.street.trim() : "";
  if (!street) { res.status(400).json({ error: "Street address is required" }); return; }
  try {
    const store = await import("./core/contactRecordStore.js");
    const row = store.addAddress(lead.id, {
      kind: body.kind,
      street,
      apt: typeof body.apt === "string" ? body.apt : "",
      city: typeof body.city === "string" ? body.city : "",
      region: typeof body.region === "string" ? body.region : "",
      country: typeof body.country === "string" ? body.country : "US",
      postalCode: typeof body.postalCode === "string" ? body.postalCode : "",
    });
    await syncContactPrimaries(lead.id);
    res.json({ ok: true, address: row, record: store.getContactRecord(lead.id) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.patch("/api/crm/contact-address/:aid", express.json({ limit: "8kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    const store = await import("./core/contactRecordStore.js");
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
    const row = store.updateAddress(String(req.params.aid || ""), {
      kind: body.kind, street: str("street"), apt: str("apt"), city: str("city"),
      region: str("region"), country: str("country"), postalCode: str("postalCode"),
    });
    if (!row) { res.status(404).json({ error: "Address not found" }); return; }
    await syncContactPrimaries(row.leadId);
    res.json({ ok: true, address: row, record: store.getContactRecord(row.leadId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/crm/contact-address/:aid", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/contactRecordStore.js");
    const cur = store.getAddress(String(req.params.aid || ""));
    if (!cur) { res.status(404).json({ error: "Address not found" }); return; }
    store.deleteAddress(cur.id);
    await syncContactPrimaries(cur.leadId);
    res.json({ ok: true, record: store.getContactRecord(cur.leadId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── social links ── */

app.put("/api/crm/lead/:id/social", express.json({ limit: "8kb" }), async (req, res) => {
  const lead = await contactLeadOr404(req, res);
  if (!lead) return;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const links = (body.links && typeof body.links === "object" ? body.links : body) as Record<string, unknown>;
  try {
    const store = await import("./core/contactRecordStore.js");
    res.json({ ok: true, social: store.setSocial(lead.id, links) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── notes ── */

app.post("/api/crm/lead/:id/notes", express.json({ limit: "64kb" }), async (req, res) => {
  const lead = await contactLeadOr404(req, res);
  if (!lead) return;
  const body = (req.body || {}) as Record<string, unknown>;
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) { res.status(400).json({ error: "A note needs some text" }); return; }
  try {
    const store = await import("./core/contactRecordStore.js");
    const mentions = Array.isArray(body.mentions)
      ? (body.mentions as unknown[])
          .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>) : {}))
          .filter((m) => typeof m.memberId === "string" && m.memberId)
          .map((m) => ({ memberId: String(m.memberId), memberName: String(m.memberName || m.memberId) }))
      : [];
    const note = store.addNote(lead.id, {
      body: text,
      hiddenFromViewers: body.hiddenFromViewers === undefined ? true : body.hiddenFromViewers === true,
      important: body.important === true,
      author: typeof body.author === "string" ? body.author : "",
      mentions,
    });
    /* A note is an interaction, so it belongs on the activity feed too —
       otherwise the feed says "no contact in 30 days" about someone who was
       written up yesterday. */
    try {
      const { appendLeadActivity } = await import("./core/db.js");
      await appendLeadActivity(lead.id, [
        { type: "note", description: text.slice(0, 200), timestamp: note.createdAt },
      ]);
    } catch (err) {
      console.error("[contactRecord] note logged but activity append failed:", err);
    }
    res.json({ ok: true, note, notes: store.listNotes(lead.id) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.patch("/api/crm/contact-note/:nid", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    const store = await import("./core/contactRecordStore.js");
    const note = store.updateNote(String(req.params.nid || ""), {
      body: typeof body.body === "string" ? body.body : undefined,
      hiddenFromViewers: body.hiddenFromViewers === undefined ? undefined : body.hiddenFromViewers === true,
      important: body.important === undefined ? undefined : body.important === true,
    });
    if (!note) { res.status(404).json({ error: "Note not found" }); return; }
    res.json({ ok: true, note, notes: store.listNotes(note.leadId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/crm/contact-note/:nid", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/contactRecordStore.js");
    res.json({ ok: store.deleteNote(String(req.params.nid || "")) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── documents ──
   15MB is the spec's ceiling and multer enforces it, so an oversized file is
   rejected at the door instead of after the volume has already taken it. */
const CONTACT_DOC_MAX_BYTES = 15 * 1024 * 1024;
const contactDocUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      void import("./core/contactRecordStore.js")
        .then((m) => cb(null, m.resolveContactDocsDir()))
        .catch((err) => cb(err as Error, ""));
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").slice(0, 12).replace(/[^A-Za-z0-9.]/g, "");
      cb(null, `${Date.now()}-${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: CONTACT_DOC_MAX_BYTES, files: 1 },
});

app.post("/api/crm/lead/:id/documents", (req, res) => {
  contactDocUpload.single("file")(req, res, (uploadErr) => {
    void (async () => {
      if (uploadErr) {
        const tooBig = (uploadErr as { code?: string }).code === "LIMIT_FILE_SIZE";
        res.status(tooBig ? 413 : 400).json({
          error: tooBig ? "That file is larger than the 15MB limit." : (uploadErr as Error).message,
        });
        return;
      }
      const lead = await contactLeadOr404(req, res);
      if (!lead) {
        // The bytes already landed; a rejected upload must not leave a stray file.
        if (req.file) { try { fs.rmSync(req.file.path); } catch { /* best effort */ } }
        return;
      }
      if (!req.file) { res.status(400).json({ error: "No file was uploaded" }); return; }
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      try {
        const store = await import("./core/contactRecordStore.js");
        let transactionId: string | null = null;
        /* "Create Pipeline Transaction" is either real or absent: when it is
           on we open an actual transaction in the pipeline store, and the
           document carries its id. It never draws a toggle that does nothing. */
        if (String(body.createTransaction) === "true" || body.createTransaction === true) {
          const { createTransaction } = await import("./core/transactionsStore.js");
          const tx = createTransaction({
            address: typeof body.transactionAddress === "string" && body.transactionAddress.trim()
              ? body.transactionAddress.trim()
              : (lead.address || `${lead.name || "Contact"} — from document`),
            dealType: lead.crmIntent === "seller" ? "seller" : "buyer",
            status: "active",
            leadId: lead.id,
            parties: { leadName: lead.name || undefined, phone: lead.phone || undefined, email: lead.email || undefined },
          });
          transactionId = tx.id || null;
        }
        const doc = store.addDocument(lead.id, {
          docType: body.docType,
          fileName: req.file.originalname || req.file.filename,
          mime: req.file.mimetype || "application/octet-stream",
          bytes: req.file.size,
          storedPath: req.file.path,
          signedDate: body.signedDate,
          expirationDate: body.expirationDate,
          transactionId,
        });
        res.json({ ok: true, document: doc, documents: store.listDocuments(lead.id), transactionId });
      } catch (err) {
        if (req.file) { try { fs.rmSync(req.file.path); } catch { /* best effort */ } }
        res.status(500).json({ error: (err as Error).message });
      }
    })();
  });
});

app.get("/api/crm/contact-document/:did/file", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/contactRecordStore.js");
    const doc = store.getDocument(String(req.params.did || ""));
    if (!doc || !fs.existsSync(doc.storedPath)) { res.status(404).json({ error: "Document not found" }); return; }
    res.setHeader("Content-Type", doc.mime);
    res.setHeader("Content-Disposition", `inline; filename="${doc.fileName.replace(/[^\w. -]/g, "_")}"`);
    fs.createReadStream(doc.storedPath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/crm/contact-document/:did", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/contactRecordStore.js");
    const doc = store.deleteDocument(String(req.params.did || ""));
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }
    res.json({ ok: true, documents: store.listDocuments(doc.leadId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});


/* ═══════════════════════════════════════════════════════════════════════
   TEAM ACCESS ON ONE CONTACT.

   The PRIMARY agent does not move: it stays on the Lead's assignedUserId /
   assignedUserName, which the lead table, the round-robin and every
   notification already read. Reassigning through this route writes there.
   The secondary members and their functional roles are the new part.
   ═══════════════════════════════════════════════════════════════════════ */

app.get("/api/crm/lead/:id/team", async (req, res) => {
  const lead = await contactLeadOr404(req, res);
  if (!lead) return;
  try {
    const store = await import("./core/contactRecordStore.js");
    res.json({
      ok: true,
      primary: { userId: lead.assignedUserId ?? null, userName: lead.assignedUserName ?? null },
      members: store.listAssignments(lead.id),
      roles: store.TEAM_ROLES,
      roster: listTeamMembers(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.put("/api/crm/lead/:id/team", express.json({ limit: "16kb" }), async (req, res) => {
  const lead = await contactLeadOr404(req, res);
  if (!lead) return;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  try {
    const store = await import("./core/contactRecordStore.js");
    /* The primary is optional on this call: SAVE TEAM can change the member
       list without touching ownership, and an absent key must not clear it. */
    if (body.primary !== undefined) {
      const p = (body.primary && typeof body.primary === "object" ? body.primary : {}) as Record<string, unknown>;
      const userId = typeof p.userId === "string" ? p.userId.trim() : "";
      const { updateLeadCrmFields } = await import("./core/db.js");
      if (userId) {
        const member = listTeamMembers().find((m) => m.id === userId);
        await updateLeadCrmFields({
          leadId: lead.id,
          assignedUserId: userId,
          assignedUserName: member?.name || (typeof p.userName === "string" ? p.userName.trim() : userId),
        });
      } else {
        await updateLeadCrmFields({ leadId: lead.id, assignedUserId: null, assignedUserName: null });
      }
    }
    const raw = Array.isArray(body.members) ? body.members : [];
    const roster = listTeamMembers();
    const members = raw
      .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>) : {}))
      .filter((m) => typeof m.userId === "string" && m.userId.trim())
      .map((m) => {
        const uid = String(m.userId).trim();
        return {
          userId: uid,
          // The roster's name wins over whatever the client sent.
          userName: roster.find((r) => r.id === uid)?.name || String(m.userName || uid),
          roleName: typeof m.roleName === "string" ? m.roleName : "",
        };
      });
    const saved = store.setAssignments(lead.id, members);
    const { getLeadById } = await import("./core/db.js");
    const fresh = await getLeadById(lead.id);
    res.json({
      ok: true,
      primary: { userId: fresh?.assignedUserId ?? null, userName: fresh?.assignedUserName ?? null },
      members: saved,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   WEB ACTIVITY.

   Brivity's version reads an IDX website. This system has no site tracking
   connected, and the lead table's Web Activity filter has said so since it
   was built. What it DOES have is engagement it generates and measures
   itself: clicks inside the listing alerts and market reports it sends
   (outreach_engagement, with the listing key), and the homes a contact has
   favourited (favoritesStore, priced from the MLS mirror).

   So this endpoint reports those, and names the difference. `visits` is
   deliberately null rather than 0 — nothing counts sessions, and a zero
   would read as "they have never been to the site", which is a claim this
   system is in no position to make.
   ═══════════════════════════════════════════════════════════════════════ */

app.get("/api/crm/lead/:id/web-activity", async (req, res) => {
  const lead = await contactLeadOr404(req, res);
  if (!lead) return;
  try {
    const outreach = await import("./core/outreachStore.js");
    const favs = await import("./core/favoritesStore.js");
    const { getListing } = await import("./core/listingsStore.js");

    const events = outreach.engagementForLead(lead.id, 300);
    const clicks = events.filter((e) => e.event === "listing_clicked");
    const opens = events.filter((e) => e.event === "email_opened");
    const reportViews = events.filter((e) => e.event === "report_viewed");

    /* One row per property, with its own view count and last-viewed stamp —
       the detail modal's grid is per property, not per click. */
    type Viewed = {
      listingKey: string; address: string; city: string; state: string; zip: string;
      price: number | null; beds: number | null; baths: number | null; photo: string | null;
      views: number; lastViewedAt: string; saved: boolean;
    };
    const byKey = new Map<string, Viewed>();
    for (const e of clicks) {
      if (!e.listingKey) continue;
      const cur = byKey.get(e.listingKey);
      if (cur) {
        cur.views += 1;
        if (e.at > cur.lastViewedAt) cur.lastViewedAt = e.at;
        continue;
      }
      let l: Record<string, unknown> | null = null;
      try { l = (getListing(e.listingKey) as unknown as Record<string, unknown>) || null; } catch { l = null; }
      const num = (k: string): number | null => (typeof l?.[k] === "number" ? (l[k] as number) : null);
      const str = (k: string): string => (typeof l?.[k] === "string" ? (l[k] as string) : "");
      const media = Array.isArray(l?.media) ? (l!.media as unknown[]) : [];
      byKey.set(e.listingKey, {
        listingKey: e.listingKey,
        address: str("unparsedAddress") || str("address") || "",
        city: str("city"), state: str("stateOrProvince") || str("state"), zip: str("postalCode"),
        price: num("listPrice"), beds: num("bedroomsTotal") ?? num("beds"),
        baths: num("bathroomsTotalInteger") ?? num("baths"),
        photo: typeof media[0] === "string" ? (media[0] as string) : null,
        views: 1, lastViewedAt: e.at, saved: false,
      });
    }

    const favourites = favs.listFavorites(lead.id);
    for (const f of favourites) {
      const key = f.listingKey;
      const existing = byKey.get(key);
      if (existing) { existing.saved = true; continue; }
      let l: Record<string, unknown> | null = null;
      try { l = (getListing(key) as unknown as Record<string, unknown>) || null; } catch { l = null; }
      const num = (k: string): number | null => (typeof l?.[k] === "number" ? (l[k] as number) : null);
      const str = (k: string): string => (typeof l?.[k] === "string" ? (l[k] as string) : "");
      const media = Array.isArray(l?.media) ? (l!.media as unknown[]) : [];
      byKey.set(key, {
        listingKey: key,
        address: str("unparsedAddress") || str("address") || "",
        city: str("city"), state: str("stateOrProvince") || str("state"), zip: str("postalCode"),
        price: num("listPrice"), beds: num("bedroomsTotal") ?? num("beds"),
        baths: num("bathroomsTotalInteger") ?? num("baths"),
        photo: typeof media[0] === "string" ? (media[0] as string) : null,
        /* Favourited but never clicked from an email: it has 0 measured views,
           and that zero is real because clicks ARE counted. */
        views: 0, lastViewedAt: f.addedAt || new Date().toISOString(), saved: true,
      });
    }

    const properties = [...byKey.values()].sort((a, b) => b.lastViewedAt.localeCompare(a.lastViewedAt));
    const pricesViewed = properties.filter((p) => p.views > 0 && p.price).map((p) => p.price as number);
    const lastAt = events.length ? events.map((e) => e.at).sort().pop()! : null;

    res.json({
      ok: true,
      summary: {
        /* null, not 0 — see the note above this route. */
        visits: null,
        views: clicks.length,
        favorites: favourites.length,
        avgPrice: pricesViewed.length
          ? Math.round(pricesViewed.reduce((a, b) => a + b, 0) / pricesViewed.length)
          : null,
        emailOpens: opens.length,
        reportViews: reportViews.length,
        lastActivityAt: lastAt,
      },
      properties,
      unavailable: [
        { scope: "visits", reason: "No IDX website or client portal sends session data to this system, so there is no visit count. VIEWS below counts listing clicks inside the alerts and reports this system sends and measures itself." },
      ],
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   AGREEMENTS — buyer, seller, referral.

   One flow: optional file upload, dates, and (for a referral) a fee and a
   partner. "Create Active Referral Transaction" opens a REAL transaction in
   the pipeline store, so the agreement, the document and the deal are three
   rows that point at each other rather than three copies of the same claim.
   ═══════════════════════════════════════════════════════════════════════ */

app.get("/api/crm/lead/:id/agreements", async (req, res) => {
  const lead = await contactLeadOr404(req, res);
  if (!lead) return;
  try {
    const store = await import("./core/contactRecordStore.js");
    res.json({
      ok: true,
      agreements: store.listAgreements(lead.id),
      propertyTypes: store.PROPERTY_TYPES,
      clientIntents: store.CLIENT_INTENTS,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/crm/lead/:id/agreements", (req, res) => {
  contactDocUpload.single("file")(req, res, (uploadErr) => {
    void (async () => {
      if (uploadErr) {
        const tooBig = (uploadErr as { code?: string }).code === "LIMIT_FILE_SIZE";
        res.status(tooBig ? 413 : 400).json({
          error: tooBig ? "That file is larger than the 15MB limit." : (uploadErr as Error).message,
        });
        return;
      }
      const lead = await contactLeadOr404(req, res);
      if (!lead) {
        if (req.file) { try { fs.rmSync(req.file.path); } catch { /* best effort */ } }
        return;
      }
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const kindRaw = typeof body.kind === "string" ? body.kind : "referral";
      const title = typeof body.title === "string" && body.title.trim()
        ? body.title.trim()
        : `${lead.name || "Contact"} ${kindRaw === "referral" ? "Referral" : kindRaw === "buyer" ? "Buyer Agreement" : "Listing Agreement"}`;
      try {
        const store = await import("./core/contactRecordStore.js");
        let documentId: string | null = null;
        if (req.file) {
          const doc = store.addDocument(lead.id, {
            docType: kindRaw === "buyer" ? "buyer_representation" : kindRaw === "seller" ? "listing_agreement" : "referral_agreement",
            fileName: req.file.originalname || req.file.filename,
            mime: req.file.mimetype || "application/octet-stream",
            bytes: req.file.size,
            storedPath: req.file.path,
            signedDate: body.signedDate,
            expirationDate: body.expirationDate,
            transactionId: null,
          });
          documentId = doc.id;
        }
        let transactionId: string | null = null;
        if (String(body.createTransaction) === "true" || body.createTransaction === true) {
          const { createTransaction } = await import("./core/transactionsStore.js");
          const feeNum = Number(body.feeValue);
          const intent = typeof body.clientIntent === "string" ? body.clientIntent : "Buyer";
          const dealType =
            kindRaw === "referral" ? "referral"
            : intent === "Seller" ? "seller"
            : intent === "Tenant" ? "tenant"
            : intent === "Landlord" ? "landlord"
            : "buyer";
          const tx = createTransaction({
            address: typeof body.address === "string" && body.address.trim() ? body.address.trim() : (lead.address || title),
            dealType: dealType as import("./core/transactionsStore.js").TransactionDealType,
            status: "pipeline",
            leadId: lead.id,
            parties: {
              leadName: lead.name || undefined,
              phone: lead.phone || undefined,
              email: lead.email || undefined,
              /* Primary Agent is who owns the DEAL. Referring Agent is who sent
                 it — different people on a referral, and conflating them would
                 put the wrong name on the pipeline. */
              assignedTo:
                (typeof body.primaryAgent === "string" && body.primaryAgent) ||
                (typeof body.referringAgent === "string" ? body.referringAgent : undefined) || undefined,
              /* Only a PERCENTAGE belongs in commissionPercent. A flat amount
                 stored there would be read as 2500% by the GCI maths. The
                 agreement's own commission field wins over the referral fee,
                 because a referral has both and they are not the same number. */
              commissionPercent:
                body.commissionType !== "flat" && Number.isFinite(Number(body.commissionValue))
                  ? Number(body.commissionValue)
                  : body.feeType !== "flat" && Number.isFinite(feeNum) ? feeNum : undefined,
            },
            price: Number.isFinite(Number(body.estClosePrice)) && String(body.estClosePrice) !== ""
              ? Number(body.estClosePrice) : undefined,
            source: typeof body.source === "string" && body.source ? body.source : undefined,
          });
          transactionId = tx.id || null;
        }
        const feeNum = Number(body.feeValue);
        const agreement = store.addAgreement(lead.id, {
          kind: kindRaw,
          documentId,
          transactionId,
          title,
          feeValue: Number.isFinite(feeNum) ? feeNum : null,
          feeType: body.feeType,
          referringAgent: typeof body.referringAgent === "string" ? body.referringAgent : "",
          partnerLeadId: typeof body.partnerLeadId === "string" && body.partnerLeadId ? body.partnerLeadId : null,
          partnerName: typeof body.partnerName === "string" ? body.partnerName : "",
          clientIntent: body.clientIntent,
          propertyType: body.propertyType,
          primaryAgent: typeof body.primaryAgent === "string" ? body.primaryAgent : "",
          source: typeof body.source === "string" ? body.source : "",
          estClosePrice: Number.isFinite(Number(body.estClosePrice)) && String(body.estClosePrice) !== ""
            ? Number(body.estClosePrice) : null,
          commissionValue: Number.isFinite(Number(body.commissionValue)) && String(body.commissionValue) !== ""
            ? Number(body.commissionValue) : null,
          commissionType: body.commissionType,
          clientLeadId: typeof body.clientLeadId === "string" && body.clientLeadId ? body.clientLeadId : null,
          clientName: typeof body.clientName === "string" ? body.clientName : "",
          signedDate: body.signedDate,
          expirationDate: body.expirationDate,
        });
        res.json({
          ok: true, agreement, transactionId, documentId,
          agreements: store.listAgreements(lead.id),
          documents: store.listDocuments(lead.id),
        });
      } catch (err) {
        if (req.file) { try { fs.rmSync(req.file.path); } catch { /* best effort */ } }
        res.status(500).json({ error: (err as Error).message });
      }
    })();
  });
});

app.delete("/api/crm/agreement/:aid", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/contactRecordStore.js");
    const gone = store.deleteAgreement(String(req.params.aid || ""));
    if (!gone) { res.status(404).json({ error: "Agreement not found" }); return; }
    /* The document and the transaction are separate records with their own
       lifetimes; removing the agreement row must not silently delete a signed
       contract or close a live deal. */
    res.json({ ok: true, agreements: store.listAgreements(gone.leadId), keptDocumentId: gone.documentId, keptTransactionId: gone.transactionId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});


/* ═══════════════════════════════════════════════════════════════════════
   AUTO PLAN PREVIEW.

   What the operator is deciding is "if I apply this plan to this person,
   what actually goes out and when". So the preview computes real send times
   from the plan's own step offsets against a real enrollment moment, and
   resolves each step's sender through the same `resolveSender` the runner
   uses — including its fallbacks, which are reported rather than hidden.

   Merge fields are deliberately left UNRESOLVED in the body. The spec asks
   for it and it is also the honest render: the runner substitutes them at
   send time, and showing a filled-in draft here would imply this text is
   final when a missing field can still block the send.
   ═══════════════════════════════════════════════════════════════════════ */

app.get("/api/auto-plans/:id/preview", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const planId = String(req.params.id || "").trim();
  const leadId = typeof req.query.leadId === "string" ? req.query.leadId.trim() : "";
  try {
    const { getAutoPlans } = await import("./core/autoPlans.js");
    const plan = getAutoPlans().find((p) => p.id === planId);
    if (!plan) { res.status(404).json({ error: "Auto plan not found" }); return; }

    const { getLeadById } = await import("./core/db.js");
    const lead = leadId ? await getLeadById(leadId) : null;
    if (leadId && !lead) { res.status(404).json({ error: "Lead not found" }); return; }

    const { offsetMs, describeOffset, resolveSender } = await import("./core/autoPlanScheduling.js");
    const startMs = Date.now();

    const steps = (plan.steps || []).map((step, i) => {
      const anchor = step.anchor || "enrollment";
      const ms = offsetMs(step);
      /* Only enrollment-anchored steps have a knowable clock time before the
         plan is applied. A step hanging off a prior step's COMPLETION, or off
         a contract date this contact does not have, is shown with its rule
         instead of a fabricated timestamp. */
      const datable = anchor === "enrollment";
      const at = datable ? new Date(startMs + ms).toISOString() : null;
      const dayIndex = datable ? Math.max(0, Math.floor(ms / 86400000)) : null;
      const sender = resolveSender(step.sendFrom, lead);
      const sendTo =
        step.type === "email"
          ? (lead?.email || null)
          : step.type === "text"
            ? (lead?.phone || null)
            : (step.assignedTo || "Marco Puga");
      return {
        index: i,
        id: step.id,
        type: step.type,
        title: step.subject || (step.content || "").split("\n")[0].slice(0, 90) || `${step.type} step`,
        subject: step.subject || null,
        content: step.content || "",
        instructions: step.instructions || null,
        anchor,
        offsetLabel: describeOffset(step),
        /* "Today", "Day 1", "Day 3" — the timeline's own grouping. */
        dayLabel: dayIndex === null ? "When its trigger fires" : dayIndex === 0 ? "Today" : `Day ${dayIndex}`,
        dayIndex,
        sendAt: at,
        sendFrom: sender.name,
        sendFromFallback: sender.fallbackFrom || null,
        sendTo,
        /* Named, not silently skipped: a text step for somebody with no phone
           will not go out, and the operator should see that before applying. */
        blocked:
          step.type === "email" && !lead?.email
            ? "This contact has no email address, so this step cannot send."
            : step.type === "text" && !lead?.phone
              ? "This contact has no phone number, so this step cannot send."
              : null,
        taskPriority: step.taskPriority ?? null,
        cc: step.cc || [],
      };
    });

    res.json({
      ok: true,
      plan: { id: plan.id, name: plan.name, stepCount: steps.length },
      contact: lead ? { id: lead.id, name: lead.name, email: lead.email ?? null, phone: lead.phone ?? null } : null,
      steps,
      note: "Merge fields are shown as written. They are filled in when the step actually sends, so the wording here is the template, not the finished message.",
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   LISTING ALERT TEMPLATES — reusable saved search criteria.
   A template carries criteria only: no contact and no cadence, so applying
   one to a second lead cannot drag the first lead's schedule along with it.
   ═══════════════════════════════════════════════════════════════════════ */

app.get("/api/outreach/alert-templates", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const { listAlertTemplates } = await import("./core/outreachStore.js");
    res.json({ ok: true, templates: listAlertTemplates() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/outreach/alert-templates", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) { res.status(400).json({ error: "A template needs a name" }); return; }
  try {
    const { saveAlertTemplate, listAlertTemplates } = await import("./core/outreachStore.js");
    /* Criteria are stored as the alert routes store them — an object, keys
       validated where they are USED (buildCriteriaSql ignores what it does not
       know). A second validator here would be a second place to keep in step. */
    const saved = saveAlertTemplate({
      id: typeof body.id === "string" ? body.id : undefined,
      name,
      criteria: (body.criteria && typeof body.criteria === "object"
        ? body.criteria
        : {}) as import("./core/listingCriteria.js").ListingCriteria,
      createdBy: typeof body.createdBy === "string" ? body.createdBy : null,
    });
    res.json({ ok: true, template: saved, templates: listAlertTemplates() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/outreach/alert-templates/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const { deleteAlertTemplate, listAlertTemplates } = await import("./core/outreachStore.js");
    const gone = deleteAlertTemplate(String(req.params.id || ""));
    if (!gone) { res.status(404).json({ error: "Template not found" }); return; }
    res.json({ ok: true, templates: listAlertTemplates() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   THE REPORTS DASHBOARD.

   Brivity's CMA product puts market reports and CMAs side by side with
   headline counts. Half of that is real here: every market report this
   system has sent, with its own opens, views and last-sent dates, plus an
   open rate computed from the sends it measured. The CMA half is not — no
   CMA generator is wired into this CRM — so the payload says so in the same
   shape rather than returning a zero that would read as "none created".
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * The CMA half of the reports dashboard.
 *
 * This block used to say no CMA generator existed, which was true until the
 * wizard was built. What stays true is the shape of the data behind it: the
 * board publishes no solds, so `soldFromFeed` is false and the count of CMAs
 * carrying a sold comparable is reported separately — a CMA built on asking
 * prices alone is a weaker document and the dashboard should not hide that.
 */
function cmaKpi(): Record<string, unknown> {
  try {
     
    const store = require("./core/cmaStore.js") as typeof import("./core/cmaStore.js");
    const sessions = store.listSessions({ limit: 500 });
    let withSold = 0;
    for (const s of sessions) {
      if (store.listComparables(s.id, "SOLD").length > 0) withSold++;
    }
    return {
      available: true,
      created: sessions.length,
      published: sessions.filter((s) => s.status === "published").length,
      withSoldComps: withSold,
      soldFromFeed: false,
      note:
        "Sold comparables do not come from the MLS feed — it publishes Active and Pending only. They come from " +
        "Marco's own closed transactions or are typed in, so a CMA with no sold comps is built on asking prices.",
    };
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}

app.get("/api/outreach/reports-dashboard", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const outreach = await import("./core/outreachStore.js");
    const snap = await getDashboardSnapshot();
    const leadName = new Map(snap.leads.map((l) => [l.id, l.name] as const));
    const leadAgent = new Map(snap.leads.map((l) => [l.id, l.assignedUserName || "Marco Puga"] as const));

    const reports = outreach.listReports().map((r) => {
      const sends = outreach.listSends(r.id, 200);
      const opened = sends.filter((s) => s.openCount > 0);
      const lastOpened = opened.map((s) => s.openedAt).filter(Boolean).sort().pop() || null;
      return {
        id: r.id,
        created: r.createdAt,
        assignedTo: leadAgent.get(r.leadId) || "Marco Puga",
        name: r.name,
        location: r.address,
        contact: leadName.get(r.leadId) || r.leadId,
        leadId: r.leadId,
        lastSent: r.lastSentAt,
        lastOpened,
        views: r.viewCount,
        lastViewed: r.lastViewedAt,
        frequency: r.frequency,
        drip: r.drip,
        sends: sends.length,
        opens: opened.length,
      };
    });

    const totalSends = reports.reduce((a, r) => a + r.sends, 0);
    const totalOpens = reports.reduce((a, r) => a + r.opens, 0);
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const createdLast30 = reports.filter((r) => r.created >= cutoff).length;
    const priorCutoff = new Date(Date.now() - 60 * 86400000).toISOString();
    const createdPrior30 = reports.filter((r) => r.created >= priorCutoff && r.created < cutoff).length;
    /* A percentage change needs a non-zero base. From zero it is not "+100%",
       it is "no previous period to compare with", and the card says so. */
    const trend =
      createdPrior30 === 0
        ? null
        : Math.round(((createdLast30 - createdPrior30) / createdPrior30) * 100);

    res.json({
      ok: true,
      reports,
      kpis: {
        marketReportsCreated: reports.length,
        marketReportsCreatedLast30: createdLast30,
        marketReportsTrendPct: trend,
        /* Only counts sends this system's own pixel measured. */
        openRatePct: totalSends ? Math.round((totalOpens / totalSends) * 100) : null,
        totalSends,
      },
      cma: cmaKpi(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});


/* ═══════════════════════════════════════════════════════════════════════════
   CMA — the Comparative Market Analysis wizard.

   Seven steps: Start, then one selection step for each of Active, Pending,
   Sold and Off Market, then Results and Publish. The selection steps look
   identical and are not: see src/core/cmaComps.ts for which of them has a
   board behind it and which is hand entry, and why.

   The three things this wizard is asked for and cannot do, each answered in
   place rather than drawn as dead furniture:

     · THE MAP. Every one of the ~32k rows in the mirror has geo.lat null —
       counted, not sampled (mlsFacets runs that check on every refresh). So
       there are no pins, no "redo search here" against map bounds, no
       distance sort and no mile radius. The area is resolved by the market
       report's widening place ladder (postal → city → county → board) and the
       wizard reports which rung it settled on.
     · STREET VIEW AND ADDRESS AUTOCOMPLETE. Both are Google Maps Platform
       products and this system has no key for any of them. The subject
       address is typed and validated against the cities the board actually
       covers; the subject image is the MLS photo when the address matches a
       listing, and otherwise nothing.
     · A BOARD-WIDE SOLD SEARCH. The feed has no solds. Marco's own closed
       transactions do carry real list-and-sold pairs and are offered as what
       they are.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Ladder builders for the step-1 dropdowns. Values are what the SQL sees. */
function cmaPriceLadder(): number[] {
  const out: number[] = [];
  for (let v = 50000; v <= 700000; v += 25000) out.push(v);
  return out;
}
function cmaBathLadder(): number[] {
  const out: number[] = [];
  for (let v = 1; v <= 10; v += 0.5) out.push(v);
  return out;
}
function cmaSqftLadder(): number[] {
  const out: number[] = [];
  for (let v = 500; v <= 9500; v += 500) out.push(v);
  return out;
}
/* The spec's lot ladder mixes square feet with acres. The feed publishes
   acres (`property.acres`), so the square-foot rungs are converted rather than
   compared against a different unit — 2,000 sqft against a column holding
   0.046 would match every lot on the board. */
const CMA_LOT_LADDER: Array<{ value: number; label: string }> = [
  { value: 2000 / 43560, label: "2,000 sqft" },
  { value: 4500 / 43560, label: "4,500 sqft" },
  { value: 6500 / 43560, label: "6,500 sqft" },
  { value: 8000 / 43560, label: "8,000 sqft" },
  ...[0.25, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 10, 15, 20, 25].map((a) => ({
    value: a,
    label: `${a} acre${a === 1 ? "" : "s"}`,
  })),
];

const CMA_YEAR_BUILT: Array<{ value: number | null; label: string }> = [
  { value: null, label: "Any" },
  { value: 1, label: "Last 1 year" },
  { value: 5, label: "Last 5 years" },
  { value: 10, label: "Last 10 years" },
  { value: 20, label: "Last 20 years" },
  { value: 30, label: "Last 30 years" },
  { value: 50, label: "Last 50 years" },
  { value: 100, label: "Last 100 years" },
];

const CMA_STATUS_DATE: Array<{ value: number | null; label: string }> = [
  { value: null, label: "Any" },
  { value: 30, label: "Last 30 days" },
  { value: 60, label: "Last 60 days" },
  { value: 90, label: "Last 90 days" },
  { value: 180, label: "Last 180 days" },
  { value: 365, label: "Last 1 year" },
  { value: 730, label: "Last 2 years" },
];

app.get("/api/cma/meta", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const { getMlsFacets } = await import("./core/mlsFacets.js");
    const { CANDIDATE_SORTS, UNAVAILABLE_SORT } = await import("./core/cmaComps.js");
    const facets = getMlsFacets();
    res.json({
      ok: true,
      /* One board, named rather than implied. A second MLS would appear here
         without the form learning a new shape. */
      mlsOptions: [
        { value: "SABOR", label: "TX - SABOR - San Antonio Board of REALTORS", connected: true },
      ],
      propertyTypes: facets.propertyTypes,
      subTypes: facets.subTypes.slice(0, 20),
      cities: facets.cities.slice(0, 60),
      statuses: facets.statuses,
      ladders: {
        price: cmaPriceLadder(),
        beds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        baths: cmaBathLadder(),
        sqft: cmaSqftLadder(),
        lotSize: CMA_LOT_LADDER,
        yearBuilt: CMA_YEAR_BUILT,
        statusDate: CMA_STATUS_DATE,
      },
      sorts: CANDIDATE_SORTS,
      unavailableSort: UNAVAILABLE_SORT,
      /* Everything the spec asks for that this data cannot answer, named
         once so the page renders the reasons instead of hard-coding them. */
      unavailable: [
        {
          field: "Search radius (0.25 – 100 miles)",
          reason:
            "Listings on this feed carry no latitude or longitude, so a radius around the subject cannot be " +
            "measured. The comp area widens by place instead — postal code, then city, then county, then the " +
            "whole board — and stops at the first rung with enough comparables. The wizard reports which one it used.",
        },
        {
          field: "Map view, price pins and “Redo search here”",
          reason:
            "A map view, geocoded price pins and re-searching against map bounds all need a coordinate on every " +
            "listing. There is none on any of the ~32,000 rows in this mirror, so no map is drawn rather than an " +
            "empty one. What the rail shows instead is built from data the feed does publish.",
        },
        {
          field: "Google Street View image of the subject",
          reason:
            "No Google Maps Platform key is configured for this system. When the subject address matches a " +
            "listing in the feed, that listing's own photo is used; otherwise the image is left empty.",
        },
        {
          field: "Address autocomplete and geocoding",
          reason:
            "No Google Maps Platform key, so there is nothing to autocomplete or geocode against. Type the address " +
            "in full — it is checked against the cities and postal codes this board actually covers, so a typo is " +
            "caught before the comp search runs.",
        },
        ...facets.unavailable,
      ],
      facetsComputedAt: facets.computedAt,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Every CMA, newest first. `?leadId=` narrows to one contact's. */
app.get("/api/cma/sessions", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/cmaStore.js");
    const leadId = String(req.query.leadId || "").trim() || null;
    const sessions = store.listSessions({ leadId, limit: Number(req.query.limit) || 100 });
    /* Selected counts come back with the list so the dashboard can show "3 of
       20 slots filled" without a request per row. */
    const withCounts = sessions.map((s) => {
      const comps = store.listComparables(s.id);
      return {
        ...s,
        selectedCount: comps.length,
        selectedByStatus: {
          ACTIVE: comps.filter((c) => c.listingStatus === "ACTIVE").length,
          PENDING: comps.filter((c) => c.listingStatus === "PENDING").length,
          SOLD: comps.filter((c) => c.listingStatus === "SOLD").length,
          OFF_MKT: comps.filter((c) => c.listingStatus === "OFF_MKT").length,
        },
      };
    });
    res.json({ ok: true, sessions: withCounts });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Step 1 submit: create the session.
 *
 * The subject address is checked against the board's own city list before the
 * session is created. Without geocoding there is no other way to catch a typo,
 * and a CMA anchored on a place the feed does not cover returns comps from
 * nowhere near the house — which looks like a working report.
 */
app.post("/api/cma/sessions", express.json({ limit: "256kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/cmaStore.js");
    const { cityFromAddress, postalFromAddress, resolveArea } = await import("./core/marketReport.js");
    const b = (req.body || {}) as Record<string, unknown>;

    const clientName = String(b.clientName || "").trim();
    const subjectAddress = String(b.subjectAddress || "").trim();
    if (!clientName) { res.status(400).json({ error: "A client name is required — the CMA is prepared for someone." }); return; }
    if (!subjectAddress) { res.status(400).json({ error: "A subject property address is required." }); return; }

    const city = String(b.subjectCity || "").trim() || cityFromAddress(subjectAddress);
    const postalCode = String(b.subjectPostalCode || "").trim() || postalFromAddress(subjectAddress);
    if (!city && !postalCode) {
      res.status(400).json({
        error:
          "That address does not contain a city or postal code this board covers. There is no geocoder wired " +
          "into this system, so the city or ZIP has to be readable from the address itself for the comp search " +
          "to know where to look.",
      });
      return;
    }

    const criteria = (b.criteria && typeof b.criteria === "object" ? b.criteria : {}) as Record<string, unknown>;
    const session = store.createSession({
      clientName,
      leadId: (b.leadId as string) || null,
      mls: (b.mls as string) || "SABOR",
      subjectAddress,
      subjectCity: city,
      subjectState: (b.subjectState as string) || "TX",
      subjectPostalCode: postalCode,
      subjectPropertyType: (b.subjectPropertyType as string) || "RES",
      subjectBeds: b.subjectBeds as number,
      subjectBaths: b.subjectBaths as number,
      subjectSqft: b.subjectSqft as number,
      subjectLotSize: b.subjectLotSize as number,
      subjectYearBuilt: b.subjectYearBuilt as number,
      criteria,
    });

    /* Resolve the comp area now, so step 2 opens on a set that already clears
       the floor and the header can say how wide it had to go. */
    /* includeWithoutPhotos matters here too: the ladder picks its rung by
       COUNTING matches, so excluding photo-less listings would widen the area
       past a postal code that actually has enough comparables in it. */
    const area = resolveArea(
      { postalCode, city },
      { ...(criteria as Record<string, never>), statuses: ["Active"], includeWithoutPhotos: true },
    );
    const withArea = store.updateSession(session.id, {
      criteria: { ...criteria, ...area.criteria, statuses: undefined },
      areaRung: area.rung,
      areaLabel: area.label,
    });
    res.json({ ok: true, session: withArea || session, area });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/cma/sessions/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/cmaStore.js");
    const session = store.getSession(String(req.params.id));
    if (!session) { res.status(404).json({ error: "That CMA no longer exists." }); return; }
    const comps = store.listComparables(session.id);
    res.json({
      ok: true,
      session,
      comparables: comps,
      trays: {
        ACTIVE: comps.filter((c) => c.listingStatus === "ACTIVE"),
        PENDING: comps.filter((c) => c.listingStatus === "PENDING"),
        SOLD: comps.filter((c) => c.listingStatus === "SOLD"),
        OFF_MKT: comps.filter((c) => c.listingStatus === "OFF_MKT"),
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.patch("/api/cma/sessions/:id", express.json({ limit: "256kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/cmaStore.js");
    const b = (req.body || {}) as Record<string, unknown>;
    /* Only forward keys the caller actually sent — updateSession writes what it
       is given and nothing else, which is the point. */
    const patch: Record<string, unknown> = {};
    for (const k of [
      "clientName", "mls", "subjectAddress", "subjectCity", "subjectState", "subjectPostalCode",
      "subjectPropertyType", "subjectBeds", "subjectBaths", "subjectSqft", "subjectLotSize",
      "subjectYearBuilt", "criteria", "currentStep", "areaRung", "areaLabel",
      "suggestedMinListPrice", "suggestedMaxListPrice", "estimatedDomMin", "estimatedDomMax",
    ]) {
      if (k in b) patch[k] = b[k];
    }
    const updated = store.updateSession(String(req.params.id), patch);
    if (!updated) { res.status(404).json({ error: "That CMA no longer exists." }); return; }
    res.json({ ok: true, session: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/cma/sessions/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/cmaStore.js");
    res.json({ ok: store.deleteSession(String(req.params.id)) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** The left-rail feed for one selection step. */
app.get("/api/cma/sessions/:id/candidates", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/cmaStore.js");
    const { candidateFeed } = await import("./core/cmaComps.js");
    const session = store.getSession(String(req.params.id));
    if (!session) { res.status(404).json({ error: "That CMA no longer exists." }); return; }

    const status = String(req.query.status || "ACTIVE").toUpperCase();
    if (!["ACTIVE", "PENDING", "SOLD", "OFF_MKT"].includes(status)) {
      res.status(400).json({ error: `Unknown step status "${status}".` });
      return;
    }
    const feed = candidateFeed(session, status as import("./core/cmaStore.js").CompStatus, {
      sort: req.query.sort as import("./core/cmaComps.js").CandidateSort,
      limit: Number(req.query.limit) || 40,
      offset: Number(req.query.offset) || 0,
      days: Number(req.query.days) || null,
    });
    /* Mark what is already in the tray so the feed renders minus buttons on
       the right rows without the page having to cross-reference two lists. */
    const selected = new Set(
      store
        .listComparables(session.id, status as import("./core/cmaStore.js").CompStatus)
        .map((c) => c.sourceKey)
        .filter(Boolean) as string[],
    );
    res.json({
      ok: true,
      ...feed,
      rows: feed.rows.map((r) => ({ ...r, selected: selected.has(r.key) })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Select a comparable into the first open tray slot for that step. */
app.post("/api/cma/sessions/:id/comparables", express.json({ limit: "256kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/cmaStore.js");
    const session = store.getSession(String(req.params.id));
    if (!session) { res.status(404).json({ error: "That CMA no longer exists." }); return; }

    const b = (req.body || {}) as Record<string, unknown>;
    const status = String(b.listingStatus || "").toUpperCase();
    if (!["ACTIVE", "PENDING", "SOLD", "OFF_MKT"].includes(status)) {
      res.status(400).json({ error: `Unknown step status "${status}".` });
      return;
    }
    const source = String(b.source || "manual");
    if (!["mls", "transaction", "manual"].includes(source)) {
      res.status(400).json({ error: `Unknown comparable source "${source}".` });
      return;
    }
    const address = String(b.address || "").trim();
    if (!address) { res.status(400).json({ error: "A comparable needs an address." }); return; }

    const comp = store.addComparable({
      sessionId: session.id,
      listingStatus: status as import("./core/cmaStore.js").CompStatus,
      source: source as import("./core/cmaStore.js").CompSource,
      sourceKey: (b.sourceKey as string) || null,
      mlsNumber: (b.mlsNumber as string) || null,
      address,
      city: (b.city as string) || null,
      postalCode: (b.postalCode as string) || null,
      price: b.price as number,
      originalListPrice: b.originalListPrice as number,
      soldPrice: b.soldPrice as number,
      sellerConcessions: b.sellerConcessions as number,
      beds: b.beds as number,
      baths: b.baths as number,
      sqft: b.sqft as number,
      lotSize: b.lotSize as number,
      yearBuilt: b.yearBuilt as number,
      listDate: (b.listDate as string) || null,
      statusDate: (b.statusDate as string) || null,
      estimatedClosingDate: (b.estimatedClosingDate as string) || null,
      daysOnMarket: b.daysOnMarket as number,
      offMarketType: (b.offMarketType as import("./core/cmaStore.js").OffMarketType) || null,
      photoUrl: (b.photoUrl as string) || null,
      notes: (b.notes as string) || null,
    });
    res.json({ ok: true, comparable: comp });
  } catch (err) {
    const name = (err as Error).name;
    /* A full tray and a duplicate pick are both the operator doing something
       reasonable, not a server fault — 409, with the sentence to show them. */
    if (name === "TrayFullError" || name === "DuplicateComparableError") {
      res.status(409).json({ error: (err as Error).message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Step 5's inline `edit`, and how a transaction-sourced sold gets its size. */
app.patch("/api/cma/comparables/:compId", express.json({ limit: "256kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/cmaStore.js");
    const b = (req.body || {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of [
      "mlsNumber", "address", "city", "postalCode", "price", "originalListPrice", "soldPrice",
      "sellerConcessions", "beds", "baths", "sqft", "lotSize", "yearBuilt", "listDate",
      "statusDate", "estimatedClosingDate", "daysOnMarket", "offMarketType", "photoUrl", "notes",
    ]) {
      if (k in b) patch[k] = b[k];
    }
    const updated = store.updateComparable(String(req.params.compId), patch);
    if (!updated) { res.status(404).json({ error: "That comparable is no longer in this CMA." }); return; }
    res.json({ ok: true, comparable: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/cma/comparables/:compId", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/cmaStore.js");
    res.json({ ok: store.removeComparable(String(req.params.compId)) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Step 6: what the selected comps actually say. */
app.get("/api/cma/sessions/:id/results", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/cmaStore.js");
    const { cmaResults } = await import("./core/cmaComps.js");
    const session = store.getSession(String(req.params.id));
    if (!session) { res.status(404).json({ error: "That CMA no longer exists." }); return; }
    const comps = store.listComparables(session.id);
    res.json({ ok: true, session, comparables: comps, results: cmaResults(session, comps) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Step 7: publish.
 *
 * Publishing means one specific thing here — the CMA gets a client-facing page
 * at /c/:id that anybody with the link can read. It does not email anyone. The
 * step says which of those it did, because "Published" that quietly also sent
 * mail to a client is the kind of surprise this system must not spring.
 */
/**
 * Step 7: send the published CMA to a client.
 *
 * Three things this refuses to fake:
 *   · It will not send an unpublished CMA. The email links to the client page,
 *     and an unpublished one returns "not available" — mailing somebody a dead
 *     link is worse than not mailing them.
 *   · The delivery row is written whether the send SUCCEEDED OR FAILED. A
 *     failure that leaves no trace is indistinguishable from one nobody tried,
 *     and "did my seller get it?" is the first question asked afterwards.
 *   · "Schedule Market Report Drip" creates a REAL market report subscription
 *     against the subject address and enrols the recipient, or it reports why
 *     it could not. It never records a drip that does not exist.
 */
app.post("/api/cma/sessions/:id/send", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/cmaStore.js");
    const session = store.getSession(String(req.params.id));
    if (!session) { res.status(404).json({ error: "That CMA no longer exists." }); return; }
    if (session.status !== "published") {
      res.status(400).json({
        error: "Publish the CMA first. The email links to the client page, and an unpublished one is not readable.",
      });
      return;
    }

    const b = (req.body || {}) as Record<string, unknown>;
    const firstName = String(b.firstName || "").trim();
    const lastName = String(b.lastName || "").trim();
    const email = String(b.email || "").trim();
    const wantsDrip = b.scheduleMarketDrip === true;
    if (!firstName) { res.status(400).json({ error: "A first name is required." }); return; }
    /* Deliberately not a full RFC validator — just enough to catch the typo
       that would otherwise bounce silently. */
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: "That email address does not look valid." });
      return;
    }

    const comps = store.listComparables(session.id);
    const { cmaResults } = await import("./core/cmaComps.js");
    const results = cmaResults(session, comps);
    const { publicBaseUrl, esc } = await import("./core/outreachEmail.js");
    const viewUrl = `${publicBaseUrl()}/c/${encodeURIComponent(session.id)}`;
    const money = (n: number | null) => (n == null ? null : "$" + Math.round(n).toLocaleString());

    const range =
      session.suggestedMinListPrice != null && session.suggestedMaxListPrice != null
        ? `${money(session.suggestedMinListPrice)} – ${money(session.suggestedMaxListPrice)}`
        : session.suggestedMinListPrice != null
          ? String(money(session.suggestedMinListPrice))
          : results.estimate != null
            ? String(money(results.estimate))
            : null;

    const subject = `Your market analysis for ${session.subjectAddress}`;
    const html =
      `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1F2933;line-height:1.6">` +
      `<p>Hi ${esc(firstName)},</p>` +
      `<p>Here is the comparative market analysis I put together for <b>${esc(session.subjectAddress)}</b>.</p>` +
      (range ? `<p>Based on ${results.totalSelected} comparable home${results.totalSelected === 1 ? "" : "s"}, ` +
        `my suggested list price is <b>${esc(range)}</b>.</p>` : "") +
      `<p><a href="${esc(viewUrl)}" style="display:inline-block;background:#0F766E;color:#fff;text-decoration:none;` +
      `font-weight:600;padding:12px 20px;border-radius:8px">View the full analysis</a></p>` +
      `<p style="font-size:13px;color:#6B7280">This is a pricing opinion based on comparable homes, not an appraisal. ` +
      `Reply to this email with any questions.</p>` +
      `<p>— Marco Puga</p></div>`;

    /* The drip is attempted BEFORE the email, so the email can honestly say
       whether one was scheduled. */
    let reportId: string | null = null;
    let leadId: string | null = session.leadId;
    let dripNote: string | null = null;
    if (wantsDrip) {
      try {
        const db = await import("./core/db.js");
        const snap = await db.getDashboardSnapshot();
        const match = snap.leads.find((l) => (l.email || "").toLowerCase() === email.toLowerCase());
        leadId = match?.id || session.leadId || null;
        if (!leadId) {
          dripNote =
            "No contact in the CRM has that email address, so there is nobody to enrol. " +
            "The CMA was still sent. Add them as a contact and start the drip from their record.";
        } else {
          const outreach = await import("./core/outreachStore.js");
          const { nextReportSend } = await import("./core/outreachRunner.js");
          const now = new Date().toISOString();
          /* Monthly, and the first one lands a month out rather than
             immediately — they have just been sent the CMA. */
          const created = outreach.insertReport({
            id: `mr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            leadId,
            name: `Market updates — ${session.subjectAddress}`,
            address: session.subjectAddress,
            cc: null,
            frequency: "monthly",
            drip: true,
            criteria: session.criteria,
            subject: {
              beds: session.subjectBeds ?? undefined,
              baths: session.subjectBaths ?? undefined,
              sqft: session.subjectSqft ?? undefined,
            } as Record<string, number>,
            adjustedValue: null,
            includeHomeValue: true,
            emailMessage: null,
            paused: false,
            createdAt: now,
            updatedAt: now,
            lastSentAt: null,
            nextSendAt: nextReportSend("monthly"),
            lastViewedAt: null,
            viewCount: 0,
            createdBy: (await currentSessionUser(req))?.name ?? null,
          });
          reportId = created.id;
        }
      } catch (err) {
        dripNote = `The CMA was sent, but the market drip could not be scheduled: ${(err as Error).message}`;
      }
    }

    let ok = true;
    let error: string | null = null;
    try {
      const { sendEmail } = await import("./integrations/gmail/index.js");
      await sendEmail({ to: email, subject, body: html, html: true });
    } catch (err) {
      ok = false;
      error = (err as Error).message;
    }

    const delivery = store.recordDelivery({
      sessionId: session.id,
      firstName, lastName, email,
      marketDripScheduled: !!reportId,
      reportId, leadId,
      ok, error,
    });

    if (!ok) { res.status(502).json({ error: `The CMA could not be emailed: ${error}`, delivery }); return; }
    res.json({
      ok: true,
      delivery,
      dripScheduled: !!reportId,
      dripNote,
      note: `Sent to ${email}.` + (reportId ? " A monthly market drip is scheduled for that contact." : ""),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/cma/sessions/:id/deliveries", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/cmaStore.js");
    res.json({ ok: true, deliveries: store.listDeliveries(String(req.params.id)) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/cma/sessions/:id/publish", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const store = await import("./core/cmaStore.js");
    const session = store.getSession(String(req.params.id));
    if (!session) { res.status(404).json({ error: "That CMA no longer exists." }); return; }
    const comps = store.listComparables(session.id);
    if (!comps.length) {
      res.status(400).json({
        error: "Nothing is selected yet — a CMA with no comparables has nothing to show a client.",
      });
      return;
    }
    const unpublish = (req.body || {}).unpublish === true;
    const updated = store.updateSession(session.id, {
      status: unpublish ? "draft" : "published",
      publishedAt: unpublish ? null : new Date().toISOString(),
      currentStep: 7,
    });
    res.json({
      ok: true,
      session: updated,
      url: unpublish ? null : `/c/${session.id}`,
      note: unpublish
        ? "Unpublished. The client link now returns a not-available page."
        : "Published. The link below is live and readable by anyone who has it. Nothing was emailed — sending is a separate action.",
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* Per-user UI switches (contact record's "Collapse by default", and whatever
   one-line view preference comes next). Table layout lives in table-prefs. */
app.get("/api/settings/ui-prefs", async (req, res) => {
  const user = String(req.query.user || "").trim();
  if (!user) { res.status(400).json({ ok: false, error: "user required" }); return; }
  const { getUserUiPrefs } = await import("./core/userPrefs.js");
  res.json({ ok: true, prefs: getUserUiPrefs(user) });
});

app.put("/api/settings/ui-prefs", express.json({ limit: "8kb" }), async (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const user = typeof body.user === "string" ? body.user.trim() : "";
  if (!user) { res.status(400).json({ ok: false, error: "user required" }); return; }
  try {
    const { setUserUiPrefs } = await import("./core/userPrefs.js");
    res.json({ ok: true, prefs: setUserUiPrefs(user, body.prefs) });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});



/* ═══════════════════════════════════════════════════════════════════════
   THE UNIFIED ACTIVITY TIMELINE.

   Brivity's contact timeline is one reverse-chronological feed over every
   channel, with a filter bar that counts each kind. This builds the same feed
   out of the four places this system actually keeps that history:

     · the lead's own `activity[]`   — notes, calls, logged and sent messages,
                                       appointments, auto-plan and web events
     · the Quo SMS thread            — real two-way texts with their direction
     · outreach sends + engagement   — market-report and listing-alert drips,
                                       with the opens THIS system's own pixel
                                       recorded
     · the task board                — tasks raised on the contact

   WHAT IS DELIBERATELY NOT IN IT, and why the endpoint says so out loud in
   `unavailable` rather than rendering an empty pill that reads as a zero:

     · Open/click counts on ordinary Gmail sends. Brivity's come from its own
       tracked sending domain. Mail sent from here goes out through Marco's
       Gmail, which reports nothing back, so an email card shows "no tracking"
       instead of "0 opens" — those two statements are not the same, and the
       second one is a lie about a message that may well have been read.
     · Website visit and property-view events. There is no site tracking
       connected; the WEB category counts only the outreach engagement that is
       real.
     · Field-level profile change history. Nothing writes an audit row per
       lead field, so there is no "Status changed HOT → NURT" card to draw.
   ═══════════════════════════════════════════════════════════════════════ */

/** The nine buckets the filter bar offers, in the order it renders them. */
type TimelineCategory = "note" | "email" | "call" | "text" | "appointment" | "task" | "other" | "web";

interface TimelineItem {
  id: string;
  category: TimelineCategory;
  /** The card's headline. */
  title: string;
  /** Body/preview text under the headline. */
  body?: string;
  at: string;
  /** Narrower kind inside the category (call outcome, OTHER sub-type…). */
  subType?: string;
  author?: string;
  /** Flat display detail the card renders as labelled lines. */
  detail?: Record<string, string | number | boolean | null>;
  /** Set on outreach cards this system's own pixel actually measured. */
  opens?: number;
  /** True when the channel genuinely carries no open/click tracking. */
  noTracking?: boolean;
  /** Outgoing vs incoming, for text bubbles. */
  direction?: "in" | "out";
}

/**
 * The card's headline, written the way the feed reads: an action with an
 * actor, not a type name. "Call" tells the reader nothing they cannot see
 * from the icon; "Marco Puga called this contact" is the line they scan for.
 */
function timelineTitleFor(type: string, actor: string, contact: string, subType?: string): string {
  /* Older entries carry no author. Naming a phantom ("Someone called this
     contact") is worse than the passive voice, which claims nothing. */
  const by = actor ? ` by ${actor}` : "";
  const who = actor || "";
  const did = (verb: string, rest = "") => (actor ? `${who} ${verb}${rest}` : `${verb.replace(/^(\w+)/, (m) => m.charAt(0).toUpperCase() + m.slice(1))}${rest}`);
  switch (type) {
    case "note": return did("added a note");
    case "email_sent": return did("emailed ", contact);
    case "email_logged": return did("logged an email to ", contact);
    case "email_pending": return `Email queued to ${contact}`;
    case "call":
    case "call_made": return did("called this contact");
    case "text_sent": return `Text sent to ${contact}`;
    case "text_received": return `${contact} texted back`;
    case "text_logged": return did("logged a text to ", contact);
    case "appointment": return "Appointment";
    case "task": return "Task";
    case "web_visit": return `${contact} visited the site`;
    case "home_hearted": return `${contact} favourited a home`;
    case "home_clicked": return `${contact} opened a listing`;
    case "listing_active": return "Their listing went Active";
    case "listing_off_market": return "Their listing went off market";
    case "auto_plan": return "Auto plan step";
    case "skip_trace": return "Skip trace run";
    case "re_engagement": return "Re-engagement sent";
    /* OTHER is the one place the sub-type IS the headline: "Pop By" and
       "Mail" are the whole point of the entry. */
    default: return subType ? `${subType} logged${by}` : did("logged an activity");
  }
}

/** Which bucket a stored LeadActivity type belongs to. */
function timelineCategoryFor(type: string): TimelineCategory {
  if (type === "note") return "note";
  if (type === "email_sent" || type === "email_logged" || type === "email_pending") return "email";
  if (type === "call" || type === "call_made") return "call";
  if (type === "text_sent" || type === "text_received" || type === "text_logged") return "text";
  if (type === "appointment") return "appointment";
  if (type === "task") return "task";
  if (type === "web_visit" || type === "home_hearted" || type === "home_clicked") return "web";
  return "other";
}

app.get("/api/crm/lead/:id/timeline", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  if (!id) { res.status(400).json({ error: "Missing lead id" }); return; }
  try {
    const { getLeadById, normalizeCrmActivity } = await import("./core/db.js");
    const lead = await getLeadById(id);
    if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

    const items: TimelineItem[] = [];
    const push = (it: TimelineItem) => { if (it.at) items.push(it); };

    /* ── 1. the lead's own activity ── */
    const contactName = lead.name || "this contact";
    const activity = normalizeCrmActivity(lead.activity);
    activity.forEach((a, i) => {
      const category = timelineCategoryFor(a.type);
      const detail: Record<string, string | number | boolean | null> = { ...(a.meta || {}) };
      /* The sub-type is already a pill on the card; repeating it as a detail
         line makes every OTHER and CALL card say the same word three times. */
      if (a.subType) {
        for (const key of Object.keys(detail)) {
          if (String(detail[key]) === a.subType) delete detail[key];
        }
      }
      if (a.notes) detail.Notes = a.notes;
      push({
        id: `act_${i}_${a.timestamp}`,
        category,
        title: timelineTitleFor(a.type, a.author || "", contactName, a.subType),
        body: a.description || undefined,
        at: a.timestamp,
        subType: a.subType,
        author: a.author,
        detail: Object.keys(detail).length ? detail : undefined,
        /* An email this system sent through Gmail carries no open data at all,
           and saying so is different from reporting zero. */
        noTracking: category === "email" ? true : undefined,
        direction: a.type === "text_received" ? "in" : a.type === "text_sent" ? "out" : undefined,
      });
    });

    /* ── 2. the real SMS thread ── */
    try {
      const thread = getThreadForLead(id);
      (thread || []).forEach((m, i) => {
        const at = String(m.sentAt || "");
        if (!at || !m.messageBody) return;
        const outbound = m.direction !== "inbound";
        push({
          id: `sms_${i}_${at}`,
          category: "text",
          title: outbound ? "Text sent" : "Text received",
          body: m.messageBody,
          at,
          direction: outbound ? "out" : "in",
          detail: m.threadType ? { Source: m.threadType } : undefined,
        });
      });
    } catch (err) {
      console.error("[timeline] SMS thread unavailable:", err);
    }

    /* ── 3. outreach: what went out, and the opens the pixel measured ── */
    let outreachTracked = 0;
    try {
      const outreach = await import("./core/outreachStore.js");
      const subs = [
        ...outreach.listAlerts(id).map((a) => ({ kind: "alert" as const, id: a.id, name: a.name, address: "", frequency: a.frequency })),
        ...outreach.listReports(id).map((r) => ({ kind: "report" as const, id: r.id, name: r.name, address: r.address, frequency: r.frequency })),
      ];
      for (const sub of subs) {
        for (const send of outreach.listSends(sub.id, 40)) {
          outreachTracked++;
          const detail: Record<string, string | number | boolean | null> = {
            [sub.kind === "report" ? "Report Name" : "Alert Name"]: sub.name,
          };
          if (sub.address) detail.Location = sub.address;
          if (sub.frequency) detail["Scheduled Drip"] = String(sub.frequency);
          if (send.listingCount) detail.Listings = send.listingCount;
          if (!send.ok && send.error) detail.Error = send.error;
          push({
            id: `send_${send.id}`,
            category: "web",
            title: sub.kind === "report" ? "Market Report sent via drip" : "Listing Alert sent",
            at: send.sentAt,
            detail,
            /* Real, because this system's own tracking pixel recorded it. */
            opens: send.openCount || 0,
          });
        }
      }
      for (const e of outreach.engagementForLead(id, 60)) {
        push({
          id: `eng_${e.id}`,
          category: "web",
          title: `${e.kind === "report" ? "Market report" : "Listing alert"} — ${String(e.event).replace(/_/g, " ")}`,
          at: e.at,
          detail: e.listingKey ? { Listing: e.listingKey } : undefined,
        });
      }
    } catch (err) {
      console.error("[timeline] outreach unavailable:", err);
    }

    /* ── 4. tasks raised on this contact ──
       The CRM task store (tasks.json), not the COMMAND board — these are the
       rows the contact record's Tasks widget and the appointment tab write,
       and mixing in a different store here would show the contact tasks that
       were never about them. */
    try {
      const { filterTasks } = await import("./core/tasks.js");
      for (const t of filterTasks({ leadId: id })) {
        const detail: Record<string, string | number | boolean | null> = {};
        if (t.dueDate) detail.Due = t.dueDate + (t.dueTime ? " " + t.dueTime : "");
        if (t.assignedUserName) detail["Assigned To"] = t.assignedUserName;
        if (t.priority) detail.Priority = t.priority;
        if (t.type) detail.Type = t.type;
        const done = t.status === "completed";
        push({
          id: `task_${t.id}`,
          category: "task",
          title: done ? "Task completed" : "Task created",
          body: t.title,
          at: (done && t.completedAt) || t.createdAt,
          detail: Object.keys(detail).length ? detail : undefined,
          author: t.assignedUserName || undefined,
        });
      }
    } catch (err) {
      console.error("[timeline] tasks unavailable:", err);
    }

    items.sort((a, b) => String(b.at).localeCompare(String(a.at)));

    const counts: Record<string, number> = { all: items.length, note: 0, email: 0, call: 0, text: 0, appointment: 0, task: 0, other: 0, web: 0 };
    for (const it of items) counts[it.category] = (counts[it.category] || 0) + 1;

    /* Named limits, not silence. Each line says what the category cannot
       cover and why, so a low count is read correctly. */
    const unavailable: Array<{ scope: string; reason: string }> = [
      { scope: "email", reason: "Mail goes out through Marco's Gmail, which reports no opens or clicks back — email cards show no tracking rather than a zero." },
      { scope: "web", reason: "There is no website visit tracking connected. This counts only listing-alert and market-report activity, which this system sends and measures itself." },
      { scope: "profile", reason: "Nothing records a per-field change log on a lead, so there are no status/address change entries to show." },
    ];

    res.json({ ok: true, items: items.slice(0, 400), counts, unavailable, outreachTracked });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Send a real email to this contact and log it on the timeline.
 *
 * This exists rather than the page calling `/api/crm/email/send` directly so
 * the send and the timeline entry cannot come apart: the entry is written only
 * after Gmail accepts, and it is typed `email_sent` (delivered) rather than
 * `email_logged` (written down), which are different claims.
 */
app.post("/api/crm/lead/:id/send-email", express.json({ limit: "2mb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const html = typeof body.html === "string" ? body.html.trim() : "";
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (!subject || !html) { res.status(400).json({ error: "subject and html are required" }); return; }
  if (!/\S+@\S+\.\S+/.test(to)) { res.status(400).json({ error: "A valid recipient email is required" }); return; }
  const cc = (Array.isArray(body.cc) ? body.cc : [])
    .map((v) => String(v || "").trim())
    .filter((v) => /\S+@\S+\.\S+/.test(v))
    .slice(0, 10);
  try {
    const { getLeadById, appendLeadActivity } = await import("./core/db.js");
    const lead = await getLeadById(id);
    if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
    const { sendEmail } = await import("./integrations/gmail/index.js");
    const recipients = [to, ...cc];
    // Self-copy is a real extra recipient, so it goes through the same send.
    if (body.copyMe === true) {
      const self = process.env.GMAIL_USER?.trim() || process.env.SMTP_USER?.trim();
      if (self && /\S+@\S+\.\S+/.test(self) && !recipients.includes(self)) recipients.push(self);
    }
    for (const recipient of recipients) {
      await sendEmail({ to: recipient, subject, body: html, html: true });
      await new Promise((r) => setTimeout(r, 120));
    }
    const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const meta: Record<string, string | number | boolean | null> = { To: to, Subject: subject };
    if (cc.length) meta.CC = cc.join(", ");
    await appendLeadActivity(id, [{
      type: "email_sent",
      description: subject,
      timestamp: new Date().toISOString(),
      author: typeof body.author === "string" ? body.author.slice(0, 120) : undefined,
      notes: plain.slice(0, 600) || undefined,
      meta,
    }]);
    res.json({ ok: true, sent: recipients.length, to, cc });
  } catch (err) {
    /* Gmail's own words: "not connected" and "recipient rejected" need
       different things done about them. */
    res.status(502).json({ error: (err as Error).message || "Gmail rejected the send" });
  }
});

/** Whether the composer's send buttons can actually send, and if not, why. */
app.get("/api/crm/messaging-status", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const out: Record<string, unknown> = {};
  try {
    const { isGmailConfigured, isGmailOAuthConfigured, getEmailTransport, getMarcoEmail } =
      await import("./integrations/gmail/index.js");
    const ok = isGmailConfigured() || isGmailOAuthConfigured();
    const transport = getEmailTransport();
    /* Which transport is reported, not just whether one exists. The composer
       used to tell the operator it was sending "through Marco's connected
       Gmail account" while the actual path was SMTP with an app password —
       and the OAuth token has been dead since July, so that sentence named
       the one transport that could NOT have sent it. */
    out.email = {
      ok,
      transport,
      from: getMarcoEmail(),
      reason: ok
        ? null
        : "No email transport is configured on the server — set GMAIL_SMTP_USER and GMAIL_SMTP_APP_PASSWORD, " +
          "or reconnect Gmail OAuth. Nothing can be sent from here until one of those exists.",
    };
  } catch {
    out.email = { ok: false, reason: "The Gmail integration could not be loaded." };
  }
  try {
    const quo = await import("./integrations/quo/index.js");
    const ok = quo.isQuoConfigured();
    out.text = { ok, reason: ok ? null : "Quo is not configured, so texts cannot be sent from here." };
    /* The composer names the line a text will go out from. "the business line"
       is a guess; the actual number is not. */
    if (ok) {
      const num = quo.getQuoPhoneNumber();
      if (num) out.textNumber = num;
    }
  } catch {
    out.text = { ok: false, reason: "The Quo integration could not be loaded." };
  }
  /* Click-to-dial has no softphone behind it. The button is not drawn rather
     than drawn and dead; this is what tells the page that. */
  out.call = { ok: false, reason: "No softphone or click-to-dial is connected — calls are placed on your own phone and logged here." };
  out.calendar = { ok: false, reason: "No Google Calendar account is connected, so an appointment cannot be pushed to one." };
  res.json({ ok: true, channels: out });
});

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
  /* Validated against CRM_STAGES, not a second copy of the list. A hard-coded
     array here is the exact bug FORAI records for TASK_TYPES: the two lists
     drift, and a stage the UI offers is silently downgraded on write — the
     operator sets "Listing Agreement", it saves as "new", and nothing says so. */
  const crmStage = ((CRM_STAGES as string[]).includes(String(body.crmStage || ""))
    ? body.crmStage
    : "new_lead") as CrmStage;
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

// ── Ad Manager: connection status + local campaign planner ─────────────────
// Real spend/impressions/campaigns come from the existing AD_DASHBOARD_BASE_URL
// proxy above (GET /api/ads/summary) when that upstream Flask app is reachable.
// There's no write-capable Meta Marketing API integration in this codebase, so
// campaign creation here is a genuinely functional local planner (SQLite,
// survives restarts, fully CRUD) rather than a fake "creates a real Facebook
// ad" button — status moves Draft → Pending Review → Active as Marco's team
// actually pushes it live in Ads Manager.
app.get("/api/ads/connection-status", async (_req, res) => {
  if (!AD_DASHBOARD_BASE_URL) {
    res.json({ configured: false, reachable: false });
    return;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (AD_DASHBOARD_API_KEY) headers.Authorization = `Bearer ${AD_DASHBOARD_API_KEY}`;
    const r = await fetch(`${AD_DASHBOARD_BASE_URL}/api/latest`, { headers, signal: ctrl.signal });
    clearTimeout(t);
    res.json({ configured: true, reachable: r.ok });
  } catch {
    res.json({ configured: true, reachable: false });
  }
});

app.get("/api/ads/campaigns", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { getAdCampaigns } = await import("./core/adsStore.js");
  res.json({ campaigns: getAdCampaigns() });
});

app.post("/api/ads/campaigns", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const platform = b.platform === "facebook" || b.platform === "instagram" ? b.platform : "both";
  const objective =
    b.objective === "traffic" || b.objective === "awareness" || b.objective === "engagement" || b.objective === "messages"
      ? b.objective
      : "leads";
  const { createAdCampaign } = await import("./core/adsStore.js");
  const actor = await currentSessionUser(req);
  const campaign = createAdCampaign({
    name,
    platform,
    objective,
    dailyBudget: Number(b.dailyBudget) || 0,
    totalBudget: Number(b.totalBudget) || 0,
    startDate: typeof b.startDate === "string" ? b.startDate : "",
    endDate: typeof b.endDate === "string" ? b.endDate : "",
    audience: typeof b.audience === "string" ? b.audience : "",
    creativeNotes: typeof b.creativeNotes === "string" ? b.creativeNotes : "",
    linkedPostId: typeof b.linkedPostId === "string" ? b.linkedPostId : null,
    linkedPostCaption: typeof b.linkedPostCaption === "string" ? b.linkedPostCaption : null,
    linkedPostCoverUrl: typeof b.linkedPostCoverUrl === "string" ? b.linkedPostCoverUrl : null,
    createdBy: actor?.name || null,
  });
  const { recordAudit } = await import("./core/authStore.js");
  recordAudit({ userId: actor?.id, userName: actor?.name, action: "ads.campaign_create", detail: name, req });
  res.status(201).json({ ok: true, campaign });
});

app.patch("/api/ads/campaigns/:id", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  if (typeof b.name === "string") updates.name = b.name;
  if (b.platform === "facebook" || b.platform === "instagram" || b.platform === "both") updates.platform = b.platform;
  if (["leads", "traffic", "awareness", "engagement", "messages"].includes(String(b.objective))) updates.objective = b.objective;
  if (["draft", "pending_review", "active", "paused", "completed"].includes(String(b.status))) updates.status = b.status;
  if (b.dailyBudget !== undefined) updates.dailyBudget = Number(b.dailyBudget) || 0;
  if (b.totalBudget !== undefined) updates.totalBudget = Number(b.totalBudget) || 0;
  if (typeof b.startDate === "string") updates.startDate = b.startDate;
  if (typeof b.endDate === "string") updates.endDate = b.endDate;
  if (typeof b.audience === "string") updates.audience = b.audience;
  if (typeof b.creativeNotes === "string") updates.creativeNotes = b.creativeNotes;
  const { updateAdCampaign } = await import("./core/adsStore.js");
  const updated = updateAdCampaign(id, updates as Parameters<typeof updateAdCampaign>[1]);
  if (!updated) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  const actor = await currentSessionUser(req);
  const { recordAudit } = await import("./core/authStore.js");
  recordAudit({
    userId: actor?.id,
    userName: actor?.name,
    action: "ads.campaign_update",
    detail: updates.status ? `${updated.name} → ${updates.status}` : updated.name,
    req,
  });
  res.json({ ok: true, campaign: updated });
});

app.delete("/api/ads/campaigns/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const { getAdCampaignById, deleteAdCampaign } = await import("./core/adsStore.js");
  const target = getAdCampaignById(id);
  const ok = deleteAdCampaign(id);
  if (!ok) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  const actor = await currentSessionUser(req);
  const { recordAudit } = await import("./core/authStore.js");
  recordAudit({ userId: actor?.id, userName: actor?.name, action: "ads.campaign_delete", detail: target?.name, req });
  res.json({ ok: true });
});

app.get("/api/ads/boost-candidates", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { getSocialVideos } = await import("./core/socialStore.js");
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || "12"), 10) || 12, 1), 50);
  try {
    res.json({ posts: getSocialVideos({ limit }) });
  } catch (err) {
    res.json({ posts: [], error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/ads", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "ads.html"));
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
  // The dedicated Harvey chat (hull-chat) sends full:true so Harvey always runs
  // the smartest path with every business/memory tool available.
  const fullMode = req.body?.full === true || req.body?.full === "true";

  try {
    const result = await runHarveyChat({
      message,
      sessionId,
      deps: harveyDeps(),
      fullMode,
    });
    res.status(200).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[jarvis/chat]", msg);
    res.status(500).json({ error: msg });
  }
});

// ── Pasted-reel analysis (async job) ───────────────────────────────────────
// A reel analysis takes 30-90s (download + transcribe + vision read). Running
// that INSIDE the /api/jarvis/chat request meant a long, feedback-less hang
// that could trip an idle/proxy timeout — the "he doesn't see it" symptom. So
// the chat UI detects a reel link, posts it here to get a job id immediately
// (letting it show "analyzing now…" at once), and polls for the result.
interface ReelChatJob {
  status: "queued" | "downloading" | "analyzing" | "complete" | "failed";
  analysis?: string;
  spoken?: string;
  metadata?: Record<string, unknown>;
  error?: string;
  createdAt: number;
}
const reelChatJobs = new Map<string, ReelChatJob>();

function pruneReelChatJobs(): void {
  const cutoff = Date.now() - 30 * 60_000; // keep 30 min
  for (const [id, job] of reelChatJobs) {
    if (job.createdAt < cutoff) reelChatJobs.delete(id);
  }
}

app.post("/api/jarvis/analyze-reel", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (!/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: "A full reel/short URL (http…) is required." });
    return;
  }
  pruneReelChatJobs();
  const jobId = randomUUID();
  reelChatJobs.set(jobId, { status: "downloading", createdAt: Date.now() });
  // Kick off the (already self-polling) sidecar analysis in the background and
  // stash the result; the client polls GET below rather than holding a socket.
  void analyzeReelViaOpenShorts(url, note)
    .then((result) => {
      const job = reelChatJobs.get(jobId);
      if (!job) return;
      if (result.status === "complete") {
        job.status = "complete";
        job.analysis = result.analysis || "";
        job.spoken = result.spoken || "";
        job.metadata = result.metadata || {};
      } else {
        job.status = "failed";
        job.error = result.error || "Reel analysis failed.";
        job.metadata = result.metadata || {};
      }
    })
    .catch((err) => {
      const job = reelChatJobs.get(jobId);
      if (job) {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
      }
    });
  res.json({ jobId, status: "started" });
});

app.get("/api/jarvis/analyze-reel/:jobId", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const job = reelChatJobs.get(String(req.params.jobId || ""));
  if (!job) {
    res.status(404).json({ error: "Job not found or expired" });
    return;
  }
  res.json(job);
});

/** Aethon voice command — Claude brain (not Gemini Live). */
function findFirstSentenceBoundary(text: string): number {
  /* Never split on an abbreviation ("Mr.", "approx.", "e.g.") — a false
     boundary here ships a half-thought to TTS and it lands as an audible
     mid-sentence choke (playbook §6.1). */
  const ABBREV = /(?:\b(?:mr|mrs|ms|dr|st|vs|no|approx|etc|inc|jr|sr)|\b[a-z])\.$/i;
  const re = /[.!?…]\s/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const upto = text.slice(0, m.index + 1);
    if (!ABBREV.test(upto.trimEnd())) return m.index + 1;
  }
  return -1;
}

app.post("/api/jarvis/voice/command", express.json({ limit: "64kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "Missing message" });
    return;
  }
  const sessionId =
    typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : undefined;
  const streamMode = req.body?.stream === true;

  if (streamMode) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    let accumulated = "";
    let firstChunkSent = false;

    try {
      const result = await runHarveyChat({
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
                res.write(
                  `data: ${JSON.stringify({ type: "speech_chunk", text: first, isFinal: false })}\n\n`,
                );
                console.log(
                  "[Voice Command] Streamed first sentence at",
                  first.length,
                  "chars",
                );
              }
            }
          }
        },
      });
      res.write(
        `data: ${JSON.stringify({
          type: "speech_complete",
          speech: result.speech,
          sessionId: result.sessionId,
        })}\n\n`,
      );
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.write(`data: ${JSON.stringify({ type: "error", error: msg })}\n\n`);
      res.end();
    }
    return;
  }

  try {
    const result = await runHarveyChat({
      message,
      sessionId,
      deps: harveyDeps(),
      voiceMode: true,
    });
    res.status(200).json({ speech: result.speech, sessionId: result.sessionId });
  } catch (err) {
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
    const packet = await buildMemoryPacketForQuery("morning activation brief");
    const text = await handleActivation(packet);
    res.status(200).json({ text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** Gemini Live removed — Aethon hull uses Deepgram Flux + Claude + Gemini TTS. */
app.post("/api/jarvis/gemini-live/token", express.json({ limit: "64kb" }), (req, res) => {
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
    const result = await runHarveyTool(toolName, toolInput);
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
  const status: MarcoTaskStatus = MARCO_TASK_STATUSES.includes(body.status as MarcoTaskStatus)
    ? (body.status as MarcoTaskStatus)
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
  if (MARCO_TASK_STATUSES.includes(body.status as MarcoTaskStatus)) {
    updates.status = body.status as MarcoTaskStatus;
    updates.previousStatus = undefined;
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
  const task = updateMarcoTask(id, { status: "done", completedAt: new Date().toISOString(), previousStatus: undefined });
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

function hullMemoryStats(db: ReturnType<typeof getHullDb>) {
  const facts = (db.prepare("SELECT COUNT(*) as c FROM facts WHERE superseded_by IS NULL").get() as { c: number }).c;
  const nodes = (db.prepare("SELECT COUNT(*) as c FROM nodes").get() as { c: number }).c;
  const edges = (db.prepare("SELECT COUNT(*) as c FROM edges").get() as { c: number }).c;
  const rules = (db.prepare("SELECT COUNT(*) as c FROM rules").get() as { c: number }).c;
  const episodes = (db.prepare("SELECT COUNT(*) as c FROM episodes").get() as { c: number }).c;
  const syntheses = (db.prepare("SELECT COUNT(*) as c FROM syntheses").get() as { c: number }).c;
  return { facts, nodes, edges, rules, episodes, syntheses };
}

/** Hull memory — full snapshot (legacy /api/jarvis/memory). */
app.get("/api/jarvis/memory", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const db = getHullDb();
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
  const db = getHullDb();
  const facts = db.prepare("SELECT * FROM facts WHERE superseded_by IS NULL ORDER BY strength DESC").all();
  const nodes = db.prepare("SELECT * FROM nodes").all();
  const edges = db
    .prepare(
      `SELECT e.id, e.source_id, e.target_id, e.relationship, e.strength, e.created_at,
              s.name as source_name, t.name as target_name
       FROM edges e JOIN nodes s ON e.source_id = s.id JOIN nodes t ON e.target_id = t.id`,
    )
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
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const db = getHullDb();
  res.json({
    nodes: db.prepare("SELECT * FROM nodes").all(),
    edges: db.prepare("SELECT * FROM edges").all(),
  });
});

app.get("/api/memory/episodes", (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const db = getHullDb();
  res.json(db.prepare("SELECT * FROM episodes ORDER BY timestamp DESC LIMIT 20").all());
});

app.get("/api/memory/rules", (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const db = getHullDb();
  res.json(db.prepare("SELECT * FROM rules ORDER BY confidence DESC").all());
});

app.get("/api/memory/identity", (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const db = getHullDb();
  const profile = db.prepare("SELECT dimension, confidence FROM identity_dimensions ORDER BY dimension").all();
  const recentQuestions = db
    .prepare("SELECT dimension, question, asked_at, answered FROM identity_questions ORDER BY asked_at DESC LIMIT 10")
    .all();
  res.json({ profile, recentQuestions });
});

/** Email marketing API */
app.get("/api/email/recent", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { getRecentEmails } = await import("./core/emailStore.js");
  res.json({ emails: getRecentEmails(parseInt(String(req.query.limit || "50"), 10) || 50) });
});

app.get("/api/email/lead/:leadId", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { getEmailsForLead } = await import("./core/emailStore.js");
  res.json({ emails: getEmailsForLead(req.params.leadId) });
});

app.get("/api/email/stats", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { getEmailStats, countActiveDripSequences } = await import("./core/emailStore.js");
  const since =
    (req.query.since as string) ||
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  res.json({ ...getEmailStats(since), activeSequences: countActiveDripSequences() });
});

app.get("/api/email/sequences", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { getActiveDripSequences } = await import("./core/emailStore.js");
  const { listAllLeads } = await import("./core/db.js");
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
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { getEmailTemplates } = await import("./core/emailStore.js");
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    res.json({ templates: getEmailTemplates(type) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/email/templates] GET failed:", message);
    res.status(500).json({ error: message || "Failed to load templates" });
  }
});

app.post("/api/email/templates", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { saveEmailTemplate } = await import("./core/emailStore.js");
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  const templateType =
    typeof req.body?.templateType === "string" ? req.body.templateType.trim() : "mass_email";
  if (!name || !subject || !body) {
    return res.status(400).json({ error: "name, subject, and body required" });
  }
  const template = saveEmailTemplate({
    name,
    subject,
    body,
    templateType: templateType as "mass_email" | "drip" | "other",
    isActive: true,
  });
  res.json({ template });
});

app.patch("/api/email/templates/:id", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { updateEmailTemplate } = await import("./core/emailStore.js");
  const updates: Record<string, unknown> = {};
  if (typeof req.body?.name === "string") updates.name = req.body.name.trim();
  if (typeof req.body?.subject === "string") updates.subject = req.body.subject.trim();
  if (typeof req.body?.body === "string") updates.body = req.body.body.trim();
  if (typeof req.body?.isActive === "boolean") updates.isActive = req.body.isActive;
  updateEmailTemplate(String(req.params.id || ""), updates);
  res.json({ success: true });
});

app.delete("/api/email/templates/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { deleteEmailTemplate } = await import("./core/emailStore.js");
  deleteEmailTemplate(String(req.params.id || ""));
  res.json({ success: true });
});

app.post("/api/email/mass-send", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });

  const { isEmailConfigured, sendEmail } = await import("./integrations/email/index.js");
  if (!isEmailConfigured()) {
    return res.status(503).json({
      error:
        "Email not configured — set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN",
    });
  }

  const { logEmail, markEmailSent, markEmailFailed, getEmailTemplate } = await import(
    "./core/emailStore.js"
  );
  const { findLeadById } = await import("./core/db.js");

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

  const leads = await Promise.all(leadIds.map((id: string) => findLeadById(String(id))));
  const leadsWithEmail = leads.filter(
    (l): l is NonNullable<typeof l> => !!l && !!l.email && String(l.email).trim().length > 0,
  );
  const leadsWithoutEmail = leadIds.length - leadsWithEmail.length;

  console.log(
    "[MassEmail] Sending to",
    leadsWithEmail.length,
    "leads (",
    leadsWithoutEmail,
    "skipped — no email)",
  );

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
      const result = await sendEmail(lead.email!, personalizedSubject, personalizedBody);
      if (result.success) {
        markEmailSent(emailRecord.id!, result.messageId);
        console.log("[MassEmail] Sent to", lead.email, `(${i + 1}/${leadsWithEmail.length})`);
      } else {
        markEmailFailed(emailRecord.id!, result.error || "unknown error");
        console.error("[MassEmail] Failed for", lead.email, "-", result.error);
      }
    }, i * DELAY_MS);
  }
});

app.post("/api/email/send-existing-client", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { sendContextAwareEmail } = await import("./agents/emailMarketing/existingClientFlow.js");
  const leadId = String(req.body?.leadId || "");
  const subject = String(req.body?.subject || "");
  const body = String(req.body?.body || "");
  const result = await sendContextAwareEmail(leadId, subject, () => body);
  res.json(result);
});

app.get("/api/email/client-context/:leadId", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { buildClientContext } = await import("./agents/emailMarketing/existingClientFlow.js");
  res.json(await buildClientContext(req.params.leadId));
});

app.post("/api/email/start-drip", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { leadId, sequenceType } = req.body || {};
  if (sequenceType === "buyer_drip") {
    void import("./agents/emailMarketing/buyerDrip.js").then((m) => m.startBuyerDrip(String(leadId)));
  } else if (sequenceType === "seller_drip") {
    void import("./agents/emailMarketing/sellerDrip.js").then((m) => m.startSellerDrip(String(leadId)));
  } else {
    res.status(400).json({ error: "Invalid sequenceType" });
    return;
  }
  res.json({ success: true });
});

app.post("/api/email/sequence/:id/pause", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { pauseSequence } = await import("./core/emailStore.js");
  pauseSequence(req.params.id);
  res.json({ ok: true });
});

app.get("/api/email/connection-status", async (_req, res) => {
  const { isEmailConfigured } = await import("./integrations/email/index.js");
  const { checkGmailAuth, getEmailTransport } = await import("./integrations/gmail/index.js");
  const { getSmtpStatus, verifySmtpConnection } = await import("./integrations/smtp/index.js");
  const configured = isEmailConfigured();
  const transport = getEmailTransport();
  // `verified` must mean "a send would actually work", so this exercises the
  // credentials for real. It used to call verifyEmailConnection(), which only
  // resolved a sender address and so reported verified:true against a token
  // Google was rejecting — a false green that hid a total email outage. The
  // SMTP path does a real LOGIN handshake for the same reason.
  if (transport === "smtp") {
    const check = await verifySmtpConnection();
    const smtp = getSmtpStatus();
    res.json({
      configured: true,
      transport: "smtp",
      verified: check.ok,
      error: check.error || null,
      sender: check.user || smtp.user,
      smtp: {
        host: smtp.host,
        port: smtp.port,
        sentToday: smtp.sentToday,
        dailyCap: smtp.dailyCap,
        remainingToday: smtp.remainingToday,
        lastSentAt: smtp.lastSentAt,
        lastError: smtp.lastError,
        lastErrorAt: smtp.lastErrorAt,
      },
    });
    return;
  }
  const auth = configured ? await checkGmailAuth() : { ok: false, error: "No email transport configured" };
  res.json({
    configured,
    transport,
    verified: auth.ok,
    error: auth.error || null,
    hint: configured
      ? undefined
      : "Set GMAIL_SMTP_USER + GMAIL_SMTP_APP_PASSWORD (an app password does not expire weekly the way the OAuth token has).",
  });
});

/**
 * Operator-facing SMTP check: verify the credentials, and optionally put one
 * real message in an inbox so "it works" is something you can see rather than
 * something the app asserts. The test send bypasses the daily cap — it is one
 * message, deliberately triggered, and being unable to test because a drip
 * used the budget would be its own problem.
 */
app.post("/api/email/smtp-test", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { getSmtpConfig, getSmtpStatus, sendViaSmtp, verifySmtpConnection } = await import("./integrations/smtp/index.js");
  const cfg = getSmtpConfig();
  if (!cfg) {
    res.status(400).json({
      ok: false,
      error: "SMTP is not configured.",
      setup: [
        "Turn on 2-Step Verification for the Google account (app passwords do not exist without it).",
        "Generate an app password at myaccount.google.com/apppasswords.",
        "fly secrets set GMAIL_SMTP_USER=<address> GMAIL_SMTP_APP_PASSWORD=<16-char password>",
      ],
    });
    return;
  }
  const check = await verifySmtpConnection();
  if (!check.ok) {
    res.status(502).json({ ok: false, stage: "login", error: check.error });
    return;
  }
  const to = typeof req.body?.to === "string" && req.body.to.trim() ? req.body.to.trim() : cfg.user;
  if (req.body?.send === false) {
    res.json({ ok: true, stage: "login", verified: true, user: check.user, status: getSmtpStatus() });
    return;
  }
  try {
    const sent = await sendViaSmtp({
      to,
      subject: "Marco 90 — SMTP test",
      body:
        "<p>This is a test from the Marco 90 automation system.</p>" +
        "<p>If you are reading this, outbound email is working over SMTP with an app password — " +
        "drips, digests, task-assignment emails and Auto Plan email steps can all send.</p>",
      html: true,
      bypassCap: true,
    });
    res.json({ ok: true, stage: "sent", to, messageId: sent.messageId, status: getSmtpStatus() });
  } catch (err) {
    res.status(502).json({ ok: false, stage: "send", error: (err as Error).message });
  }
});

// ── CRM Email Marketing: real Gmail sends for newsletters/campaigns ───────
// Uses the same Gmail OAuth connection (GMAIL_CLIENT_ID/SECRET + stored
// refresh token) already wired up for Harvey's inbox sync/send.
app.post("/api/crm/email/send-test", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const subject = String(req.body?.subject || "").trim();
  const html = String(req.body?.html || req.body?.body || "").trim();
  if (!subject || !html) {
    res.status(400).json({ error: "subject and html are required" });
    return;
  }
  try {
    const { sendEmail } = await import("./integrations/gmail/index.js");
    const result = await sendEmail({ to: "me", subject: `[TEST] ${subject}`, body: html, html: true });
    const actor = await currentSessionUser(req);
    const { recordAudit } = await import("./core/authStore.js");
    recordAudit({ userId: actor?.id, userName: actor?.name, action: "email.send_test", detail: subject, req });
    res.json({ ok: true, to: result.to, messageId: result.messageId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

app.post("/api/crm/email/send", express.json({ limit: "2mb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const subject = String(req.body?.subject || "").trim();
  const html = String(req.body?.html || req.body?.body || "").trim();
  const rawTo = req.body?.to;
  if (!subject || !html) {
    res.status(400).json({ error: "subject and html are required" });
    return;
  }
  if (!Array.isArray(rawTo) || rawTo.length === 0) {
    res.status(400).json({ error: "to (array of recipient emails) is required" });
    return;
  }
  const MAX_RECIPIENTS = 500;
  const to = Array.from(
    new Set(
      rawTo
        .map((v: unknown) => String(v || "").trim().toLowerCase())
        .filter((v: string) => v && /\S+@\S+\.\S+/.test(v)),
    ),
  );
  if (!to.length) {
    res.status(400).json({ error: "No valid recipient emails provided" });
    return;
  }
  if (to.length > MAX_RECIPIENTS) {
    res.status(400).json({
      error: `Too many recipients (${to.length}); max ${MAX_RECIPIENTS} per send — split into batches.`,
    });
    return;
  }
  const { sendEmail } = await import("./integrations/gmail/index.js");
  const results: Array<{ to: string; ok: boolean; error?: string }> = [];
  for (const recipient of to) {
    try {
      await sendEmail({ to: recipient, subject, body: html, html: true });
      results.push({ to: recipient, ok: true });
    } catch (err) {
      results.push({ to: recipient, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    // Gentle pacing so a large batch doesn't trip Gmail send-rate limits.
    await new Promise((r) => setTimeout(r, 120));
  }
  const sent = results.filter((r) => r.ok).length;
  const actor = await currentSessionUser(req);
  const { recordAudit } = await import("./core/authStore.js");
  recordAudit({
    userId: actor?.id,
    userName: actor?.name,
    action: "email.send",
    detail: `"${subject}" to ${sent}/${to.length} recipients`,
    req,
  });
  res.json({ sent, failed: results.length - sent, total: results.length, results: results.slice(0, 50) });
});

app.post("/api/email/process-buyer-drips-now", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { processDueBuyerDrips } = await import("./agents/emailMarketing/buyerDrip.js");
  res.json(await processDueBuyerDrips());
});

app.post("/api/email/process-seller-drips-now", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { processDueSellerDrips } = await import("./agents/emailMarketing/sellerDrip.js");
  res.json(await processDueSellerDrips());
});

app.post("/api/email/quarterly-touch-now", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { runPastClientQuarterlyTouch } = await import("./agents/emailMarketing/pastClientQuarterly.js");
  res.json(await runPastClientQuarterlyTouch());
});

app.post("/api/email/no-reply-check-now", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { checkNoReplyFollowups } = await import("./agents/emailMarketing/noReplyFollowup.js");
  res.json(await checkNoReplyFollowups());
});

app.get("/api/email/detail/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { getEmailById } = await import("./core/emailStore.js");
  const email = getEmailById(req.params.id);
  if (!email) return res.status(404).json({ error: "Email not found" });
  const { listAllLeads } = await import("./core/db.js");
  const leads = await listAllLeads();
  const lead = leads.find((l) => l.id === email.leadId);
  res.json({
    email,
    leadName: lead?.name || lead?.username || email.leadId,
    leadEmail: lead?.email,
  });
});

app.get("/api/email/replies", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { getRepliedEmails, getInboundCachedReplies } = await import("./core/emailStore.js");
  const { listAllLeads } = await import("./core/db.js");
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
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { getActiveDripSequences, getEmailsForDripType } = await import("./core/emailStore.js");
  const { listAllLeads } = await import("./core/db.js");
  const sequences = getActiveDripSequences(100);
  const leads = await listAllLeads();
  const byId = new Map(leads.map((l) => [l.id, l]));
  const dripTypeMap: Record<string, "buyer_drip" | "seller_drip"> = {
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
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { getCachedGmailMessages } = await import("./core/emailStore.js");
  const limit = parseInt(String(req.query.limit || "30"), 10) || 30;
  res.json({ messages: getCachedGmailMessages(limit) });
});

app.post("/api/email/sync-gmail", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { syncGmailInbox } = await import("./agents/emailMarketing/gmailSync.js");
    const result = await syncGmailInbox();
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── Gmail sync health + in-app OAuth relink ────────────────────────────────
// The env refresh token died with invalid_grant on June 22 and the sync went
// silently stale for weeks. These endpoints (1) expose sync health so the UI
// can show a banner, and (2) let Marco re-link Gmail from the browser — the
// new refresh token is stored in the email DB on the /data volume, which
// getConfig() prefers over the env var, so no Fly secrets rotation is needed.

app.get("/api/email/sync-status", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const { getGmailAuthInfo } = await import("./integrations/gmail/index.js");
  const { getGmailSyncStatus } = await import("./agents/emailMarketing/gmailSync.js");
  const auth = getGmailAuthInfo();
  const sync = getGmailSyncStatus();
  const lastOk = sync.lastSyncAt ? Date.parse(sync.lastSyncAt) : NaN;
  const staleHours = Number.isFinite(lastOk)
    ? Math.round((Date.now() - lastOk) / 3_600_000)
    : null;
  res.json({ ...auth, ...sync, staleHours });
});

/** Pending OAuth state values — CSRF guard for the relink callback. */
const gmailOauthStates = new Map<string, number>();

function gmailOauthRedirectUri(req: express.Request): string {
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  return `${proto}://${req.get("host")}/api/email/gmail-oauth/callback`;
}

app.get("/api/email/gmail-oauth/start", (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const clientId = process.env.GMAIL_CLIENT_ID?.trim();
  if (!clientId) {
    return res
      .status(500)
      .send("GMAIL_CLIENT_ID is not configured — set it before linking Gmail.");
  }
  // Prune stale states (>10 min), then mint a fresh one.
  const now = Date.now();
  for (const [s, t] of gmailOauthStates) if (now - t > 600_000) gmailOauthStates.delete(s);
  const state = randomUUID();
  gmailOauthStates.set(state, now);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", gmailOauthRedirectUri(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
  );
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent"); // force a NEW refresh token
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.get("/api/email/gmail-oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const fail = (msg: string) =>
    res
      .status(400)
      .send(
        `<body style="font-family:monospace;background:#0a0e14;color:#e6e6e6;padding:40px">` +
          `<h2 style="color:#ff5566">Gmail relink failed</h2><p>${msg}</p>` +
          `<p><a style="color:#00d4ff" href="/api/email/gmail-oauth/start">Try again</a></p></body>`,
      );
  if (!code) return fail(String(req.query.error || "Google returned no authorization code."));
  if (!state || !gmailOauthStates.has(state)) return fail("Invalid or expired state — start over.");
  gmailOauthStates.delete(state);

  const clientId = process.env.GMAIL_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim() || "";
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: gmailOauthRedirectUri(req),
        grant_type: "authorization_code",
      }),
    });
    const tok = (await tokenRes.json().catch(() => ({}))) as {
      refresh_token?: string;
      access_token?: string;
      error_description?: string;
      error?: string;
    };
    if (!tokenRes.ok || !tok.refresh_token) {
      return fail(
        tok.error_description ||
          tok.error ||
          "No refresh token returned — remove the app's prior grant at myaccount.google.com/permissions and try again.",
      );
    }

    // Resolve which account was linked (nice for the status banner).
    let linkedEmail: string | undefined;
    if (tok.access_token) {
      const prof = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      const pd = (await prof.json().catch(() => ({}))) as { emailAddress?: string };
      linkedEmail = pd.emailAddress?.trim();
    }

    const { storeGmailRefreshToken } = await import("./integrations/gmail/index.js");
    storeGmailRefreshToken(tok.refresh_token, linkedEmail);

    // Immediately prove it works end-to-end with a real sync.
    const { syncGmailInbox } = await import("./agents/emailMarketing/gmailSync.js");
    const result = await syncGmailInbox({ maxResults: 30 });

    res.send(
      `<body style="font-family:monospace;background:#0a0e14;color:#e6e6e6;padding:40px">` +
        `<h2 style="color:#00ff88">Gmail reconnected ✓</h2>` +
        `<p>Linked account: <b>${linkedEmail || "unknown"}</b></p>` +
        `<p>Synced <b>${result.synced}</b> messages just now (${result.repliesMatched} lead replies matched).</p>` +
        `<p><a style="color:#00d4ff" href="/shell?tab=email">Back to the dashboard</a></p></body>`,
    );
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

app.get("/api/email/gmail/:messageId", async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { getGmailMessage } = await import("./integrations/gmail/inbox.js");
    const { getCachedGmailMessage, cacheGmailMessage } = await import("./core/emailStore.js");
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    /* "Gmail is not connected" is not a crash, and a 500 says it is. Every
       other integration here answers 503 for an unconfigured transport (Quo,
       Twilio), and the difference matters to whoever is reading the network
       tab: a 500 sends them looking for a bug in this handler. */
    const unconfigured = /not configured/i.test(message);
    res.status(unconfigured ? 503 : 500).json({
      error: message,
      ...(unconfigured ? { hint: "Connect Gmail in Settings — no message can be read until then." } : {}),
    });
  }
});

app.post("/api/memory/extract-voice", express.json({ limit: "512kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const transcript = Array.isArray(req.body?.transcript) ? req.body.transcript : [];
  const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "voice";
  await runPostConversationExtraction(
    sessionId,
    transcript.map((t: { role?: string; text?: string }) => ({
      role: String(t.role || "user"),
      text: String(t.text || ""),
    })),
  );
  broadcastHullEvent({ type: "memory_updated" });
  res.json({ ok: true });
});

/** Harvey memory search — hybrid retrieval. */
app.get("/api/jarvis/memory/search", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const { searchFacts } = await import("./hull/memory/retrieval.js");
  const results = await searchFacts(q, 10);
  res.json(results);
});

/** Harvey memory — add fact. */
app.post("/api/jarvis/memory/add", express.json(), async (req, res) => {
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
  const db = getHullDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO facts (id, content, category, keywords, strength, access_count, last_accessed, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, content, category, keywords, strength, now, now);
  broadcastHullEvent({ type: "memory_updated" });
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
  const db = getHullDb();
  const tables = ["facts", "nodes", "edges", "rules", "episodes", "syntheses", "identity_questions"] as const;
  let deleted = false;
  for (const table of tables) {
    const result = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    if (result.changes > 0) deleted = true;
  }
  if (!deleted) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  broadcastHullEvent({ type: "memory_updated" });
  res.status(200).json({ ok: true, id });
});

/** Gemini TTS — Aethon mouth (director's notes + Charon). */
let ttsInFlight = 0;
const TTS_MAX_CONCURRENT = 2;

app.post("/api/jarvis/voice", express.json({ limit: "256kb" }), async (req, res) => {
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
    const audio = await generateTTS(text);
    if (!audio) {
      /* "TTS failed" told the browser nothing and the browser told the operator
         nothing, which is how Harvey stayed silent for a day without anyone
         being able to say why. Hand back the actual reason. */
      const why = ttsHealthReport().lastError;
      res.status(502).json({
        error: why ? `Text-to-speech failed — ${why}` : "Text-to-speech failed",
        hint: "Check the voice at /api/harvey/voice; /health reports the last attempt under harvey.voice.speech.",
      });
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Sample-Rate", String(audio.sampleRate));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(audio.pcm);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  } finally {
    ttsInFlight--;
  }
});

/* ===================== Harvey's voice =====================================
   Which voice Harvey speaks in, and how it delivers. Stored rather than
   env-only, because ELEVENLABS_VOICE_ID is a Fly secret: a code-side default
   would be silently overridden in production, and choosing a voice is a thing
   you do by listening a few times, not by redeploying.
========================================================================== */

app.get("/api/harvey/voice", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { getVoiceProfile, effectiveDelivery, DELIVERY_PRESETS, RECOMMENDED_VOICES } =
    await import("./hull/voice/voiceProfile.js");
  const profile = getVoiceProfile();
  const configured = Boolean(process.env.ELEVENLABS_API_KEY?.trim());

  /* The account's real voice list, so the picker offers what actually exists
     rather than a hard-coded menu that can drift. Failure here is not fatal —
     the curated shortlist still works. */
  let library: Array<{ id: string; name: string; category?: string; description?: string }> = [];
  let libraryError: string | null = null;
  if (configured) {
    try {
      const r = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!.trim() },
        signal: AbortSignal.timeout(12000),
      });
      if (r.ok) {
        const body = (await r.json()) as { voices?: Array<Record<string, unknown>> };
        library = (body.voices || []).map((v) => ({
          id: String(v.voice_id ?? ""),
          name: String(v.name ?? ""),
          category: v.category ? String(v.category) : undefined,
          description: (v.labels && typeof v.labels === "object")
            ? Object.values(v.labels as Record<string, unknown>).filter(Boolean).join(", ")
            : undefined,
        })).filter((v) => v.id);
      } else {
        libraryError = `ElevenLabs returned ${r.status}`;
      }
    } catch (err) {
      libraryError = (err as Error).message;
    }
  }

  /* Recommendations matched against the live library BY NAME — a stock voice id
     can differ per account, and offering one that 404s would leave Harvey
     mute with nothing pointing at the cause.

     Matching is on the LEADING NAME ONLY. ElevenLabs returns premade voices as
     "Sarah - Mature, Reassuring, Confident", so an exact-string compare misses
     every one of them and the picker greys out voices that are in fact right
     there — which is worse than not matching at all, because it tells the
     operator a working voice is unavailable. */
  const leadName = (n: string) => n.split(/\s+[-–—]\s+/)[0].trim().toLowerCase();
  const byName = new Map(library.map((v) => [leadName(v.name), v]));
  const recommended = RECOMMENDED_VOICES.map((v) => {
    const live = byName.get(leadName(v.name));
    return {
      name: v.name,
      /* The account's own descriptor beats our note when there is one — it is
         ElevenLabs' current wording for that voice, not a copy that can rot. */
      note: live?.name.includes(" - ") ? `${live.name.split(/\s+[-–—]\s+/).slice(1).join(" - ")} — ${v.note}` : v.note,
      id: live?.id || v.id,
      availableOnAccount: library.length ? Boolean(live) : null,
    };
  });

  res.json({
    ok: true,
    configured,
    hint: configured ? null : "ELEVENLABS_API_KEY is not set — Harvey has no voice until it is.",
    current: { ...profile, delivery: effectiveDelivery(profile) },
    envPinned: process.env.ELEVENLABS_VOICE_ID?.trim() || null,
    presets: Object.entries(DELIVERY_PRESETS).map(([key, p]) => ({ key, label: p.label, note: p.note, delivery: p.delivery })),
    recommended,
    library,
    libraryError,
    model: process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_flash_v2_5",
    modelNote:
      "Flash v2.5 on purpose: ElevenLabs' more natural v3 model cannot run in real time, and Harvey speaks mid-conversation.",
  });
});

app.put("/api/harvey/voice", express.json({ limit: "32kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { setVoiceProfile, effectiveDelivery, voiceExistsOnAccount } =
    await import("./hull/voice/voiceProfile.js");
  const { clearTtsCache } = await import("./hull/voice/tts.js");
  const b = (req.body || {}) as Record<string, unknown>;

  /*
   * A voice id the account does not have is refused HERE, before it is stored.
   *
   * This is the check whose absence caused the 2026-08-17 outage: a bad id was
   * accepted, written to disk, and from that moment Harvey was mute — the
   * failure only existed at speak time, on a server nobody was tailing. A save
   * is rare and a person is waiting on it, so one round trip to confirm the
   * voice is real is cheap insurance against total silence.
   *
   * `null` means the account could not be reached; a blip must not block a
   * legitimate save, so only a KNOWN-bad id is rejected.
   */
  if (typeof b.voiceId === "string" && b.voiceId.trim()) {
    const exists = await voiceExistsOnAccount(b.voiceId.trim());
    if (exists === false) {
      res.status(400).json({
        error: `ElevenLabs has no voice ${b.voiceId.trim()} on this account. ` +
          `Saving it would leave Harvey with no voice at all, so it was not saved.`,
      });
      return;
    }
  }

  try {
    const who = (await currentSessionUser(req))?.name ?? undefined;
    const profile = setVoiceProfile(b, who);
    /* Cached lines were rendered in the OLD voice; keeping them would make the
       change look half-applied for everything Harvey had already said. */
    clearTtsCache();
    res.json({ ok: true, current: { ...profile, delivery: effectiveDelivery(profile) } });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Speak a sample line in a candidate voice WITHOUT saving it, so a voice can be
 * auditioned before it becomes the one clients hear.
 */
app.post("/api/harvey/voice/preview", express.json({ limit: "32kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) { res.status(503).json({ error: "ELEVENLABS_API_KEY is not set" }); return; }
  const b = (req.body || {}) as Record<string, unknown>;
  const { getVoiceProfile, effectiveDelivery, DELIVERY_PRESETS } = await import("./hull/voice/voiceProfile.js");
  const { sanitizeForSpeech } = await import("./hull/voice/speakNumbers.js");

  const current = getVoiceProfile();
  const voiceId = typeof b.voiceId === "string" && b.voiceId.trim() ? b.voiceId.trim() : current.voiceId;
  const presetKey = typeof b.preset === "string" && DELIVERY_PRESETS[b.preset] ? b.preset : current.preset;
  const delivery = (b.delivery && typeof b.delivery === "object")
    ? { ...effectiveDelivery(current), ...(b.delivery as Record<string, number>) }
    : (DELIVERY_PRESETS[presetKey] || DELIVERY_PRESETS.soothing).delivery;

  const sample = typeof b.text === "string" && b.text.trim()
    ? b.text.trim().slice(0, 300)
    : "Good morning, Marco. You have three showings today, and the Blanco listing just went under contract. Nothing else needs you right now.";

  const settings: Record<string, unknown> = {
    stability: delivery.stability,
    similarity_boost: delivery.similarityBoost,
    style: delivery.style,
    use_speaker_boost: delivery.speakerBoost,
  };
  const speed = Number(b.speed ?? current.speed);
  if (Number.isFinite(speed)) settings.speed = Math.min(1.2, Math.max(0.7, speed));

  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_24000`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/pcm" },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          text: sanitizeForSpeech(sample),
          model_id: process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_flash_v2_5",
          voice_settings: settings,
        }),
      },
    );
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      res.status(502).json({ error: `ElevenLabs returned ${r.status}`, detail: detail.slice(0, 300) });
      return;
    }
    const pcm = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Sample-Rate", "24000");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(pcm);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/** Legacy alias — gemini-tts → hull TTS. */
app.post("/api/jarvis/gemini-tts", express.json({ limit: "256kb" }), async (req, res) => {
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
    const audio = await generateTTS(text);
    if (!audio) {
      /* "TTS failed" told the browser nothing and the browser told the operator
         nothing, which is how Harvey stayed silent for a day without anyone
         being able to say why. Hand back the actual reason. */
      const why = ttsHealthReport().lastError;
      res.status(502).json({
        error: why ? `Text-to-speech failed — ${why}` : "Text-to-speech failed",
        hint: "Check the voice at /api/harvey/voice; /health reports the last attempt under harvey.voice.speech.",
      });
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Sample-Rate", String(audio.sampleRate));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(audio.pcm);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
app.post("/reset", resetCors, (req, res) => {
  // DANGER: this wipes EVERY lead + conversation (production holds hundreds of
  // real DM threads). It exists for local demo/testing only — in production it
  // must be explicitly enabled AND pass the dashboard token.
  const allowed = process.env.ALLOW_MEMORY_RESET?.trim().toLowerCase() === "true";
  if (!allowed) {
    res.status(403).json({
      error: "Reset disabled — this would erase all live leads/conversations. Set ALLOW_MEMORY_RESET=true to enable (local/testing only).",
    });
    return;
  }
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  resetMemoryStore();
  res.status(200).json({ ok: true, message: "In-memory store cleared." });
});

// ── DM Agent console ────────────────────────────────────────────────────────
// The DM agent (/simulate, /webhook) reads inbound Instagram/SMS DMs and
// auto-replies, persisting each thread as a lead + conversation. These two
// read-only endpoints power the DM Agent tab's inbox. Note: DM leads often
// have no phone, so they never appear in /api/dashboard/data (which filters to
// phone-holding leads) — this reads the full conversation store directly.
/**
 * WHEN DID INBOUND DMs LAST ACTUALLY ARRIVE, per platform and per day.
 *
 * WHY THIS EXISTS. "The TikTok automation stopped replying" has two causes that
 * look identical from the inbox and need opposite fixes:
 *
 *   1. Messages ARE reaching this server and something here declines to answer.
 *   2. Messages are NOT reaching this server at all, because the chain upstream
 *      — TikTok -> ManyChat -> External Request -> /webhook — is broken
 *      somewhere. Nothing in this codebase can be wrong in that case, and no
 *      amount of reading this codebase will show it.
 *
 * Every other diagnostic here answers "what did we do with the message". This
 * one answers the question that has to come first: was there a message. It is
 * computed from stored conversations rather than a live counter, so it can look
 * BACKWARDS through a takedown that happened before anyone thought to
 * instrument it — the day-by-day histogram shows the cliff and its date.
 *
 * Counts and timestamps only: no message text, no names, no handles.
 */
app.get("/api/dm/inbound-report", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 60));
    const { listAllLeads: allLeads, getConversation: getConv } = await import("./core/db.js");
    const leads = await allLeads();
    const now = Date.now();
    const cutoff = now - days * 86400000;

    interface PlatformStat {
      lastInboundAt: string | null;
      inbound24h: number;
      inbound7d: number;
      inbound30d: number;
      inboundInWindow: number;
      contactsWithInbound: number;
      firstInboundInWindow: string | null;
      byDay: Record<string, number>;
    }
    const stats = new Map<string, PlatformStat>();
    const touch = (p: string): PlatformStat => {
      let s = stats.get(p);
      if (!s) {
        s = { lastInboundAt: null, inbound24h: 0, inbound7d: 0, inbound30d: 0,
              inboundInWindow: 0, contactsWithInbound: 0, firstInboundInWindow: null, byDay: {} };
        stats.set(p, s);
      }
      return s;
    };

    for (const lead of leads) {
      const platform = String(lead.platform || "unknown").toLowerCase();
      const conv = await getConv(lead.id);
      let sawInbound = false;
      for (const m of conv.messages || []) {
        /* role "user" is the person writing to us. Assistant messages are our
           own replies and would make a dead channel look alive. */
        if (m.role !== "user") continue;
        const t = Date.parse(m.at || "");
        if (!Number.isFinite(t)) continue;
        const s = touch(platform);
        if (!s.lastInboundAt || m.at > s.lastInboundAt) s.lastInboundAt = m.at;
        if (now - t <= 86400000) s.inbound24h++;
        if (now - t <= 7 * 86400000) s.inbound7d++;
        if (now - t <= 30 * 86400000) s.inbound30d++;
        if (t >= cutoff) {
          s.inboundInWindow++;
          const day = new Date(t).toISOString().slice(0, 10);
          s.byDay[day] = (s.byDay[day] || 0) + 1;
          if (!s.firstInboundInWindow || m.at < s.firstInboundInWindow) s.firstInboundInWindow = m.at;
          sawInbound = true;
        }
      }
      if (sawInbound) touch(platform).contactsWithInbound++;
    }

    const platforms: Record<string, unknown> = {};
    for (const [p, s] of stats) {
      platforms[p] = {
        ...s,
        hoursSinceLastInbound: s.lastInboundAt
          ? Number(((now - Date.parse(s.lastInboundAt)) / 3600000).toFixed(1))
          : null,
        /* Sorted, and only days that had traffic — a run of missing dates is
           the signal, and printing 60 zeroes would bury it. */
        byDay: Object.fromEntries(Object.entries(s.byDay).sort(([a], [b]) => a.localeCompare(b))),
      };
    }

    /* Say what it means for the reported symptom, naming the platform asked
       about rather than leaving the reader to work it out from the numbers. */
    const focus = String(req.query.platform || "tiktok").toLowerCase();
    const f = stats.get(focus);
    let verdict: string;
    if (!f || !f.lastInboundAt) {
      verdict =
        `No inbound ${focus} message has EVER reached this server. Nothing in this codebase can be ` +
        `the cause — the break is upstream, between ${focus} and ManyChat, or in the ManyChat flow's ` +
        `External Request step, which is what calls this server.`;
    } else {
      const hrs = (now - Date.parse(f.lastInboundAt)) / 3600000;
      if (hrs <= 24) {
        verdict =
          `Inbound ${focus} messages ARE reaching this server — ${f.inbound24h} in the last 24 hours, ` +
          `most recent ${hrs.toFixed(1)}h ago. So ManyChat is calling the webhook, and whatever is wrong ` +
          `is either this server's decision not to reply (see /api/llm/health) or the send-back leg ` +
          `inside ManyChat. It is NOT a broken connection.`;
      } else {
        verdict =
          `Inbound ${focus} messages have STOPPED. The last one arrived ${(hrs / 24).toFixed(1)} days ago ` +
          `(${f.lastInboundAt}); ${f.inbound7d} in the last 7 days, ${f.inbound30d} in the last 30. ` +
          `This server is idle on that channel, so the break is upstream of it — ${focus} to ManyChat, ` +
          `or the ManyChat flow that calls this webhook. Check byDay below for the date it stopped.`;
      }
    }

    res.json({
      generatedAt: new Date().toISOString(),
      windowDays: days,
      focus,
      verdict,
      note: "Counts inbound (role=user) messages only. Synthetic test traffic appears in byDay like any other.",
      platforms,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/dm/conversations", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { listAllLeads: allLeads, getConversation: getConv } = await import("./core/db.js");
    const leads = await allLeads();
    const items: Array<Record<string, unknown>> = [];
    for (const lead of leads) {
      const conv = await getConv(lead.id);
      const msgs = conv.messages || [];
      if (!msgs.length) continue;
      const last = msgs[msgs.length - 1];
      items.push({
        id: lead.id,
        name: lead.name || lead.username || lead.userId || "Lead",
        platform: lead.platform || "unknown",
        userId: lead.userId,
        state: lead.state ? String(lead.state) : null,
        phone: lead.phone?.trim() || null,
        email: lead.email?.trim() || null,
        hasPhone: Boolean(lead.phone?.trim()),
        lastText: last?.text || "",
        lastAt: last?.at || null,
        lastRole: last?.role || "user",
        userMessages: msgs.filter((m) => m.role === "user").length,
        agentMessages: msgs.filter((m) => m.role === "assistant").length,
        total: msgs.length,
      });
    }
    items.sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")));
    // Production has hundreds of live threads; cap the payload (newest first)
    // and let the client ask for more. total reflects the uncapped count.
    const limit = Math.max(1, Math.min(1000, parseInt(String(req.query.limit || "300"), 10) || 300));
    res.json({ total: items.length, conversations: items.slice(0, limit) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Aggregate numbers for the DM Agent tab's overview cards (Reporting-style):
// platform split, message volume, today's activity, phone captures, and
// threads needing Marco. Computed live from the same store the agent writes.
app.get("/api/dm/stats", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { listAllLeads: allLeads, getConversation: getConv } = await import("./core/db.js");
    const leads = await allLeads();
    const today = new Date().toISOString().slice(0, 10);
    const byPlatform: Record<string, number> = {};
    let conversations = 0;
    let leadMessages = 0;
    let agentReplies = 0;
    let messagesToday = 0;
    let newLeadsToday = 0;
    let phonesCaptured = 0;
    let flaggedForCall = 0;
    let paused = 0;
    let activeToday = 0;
    for (const lead of leads) {
      const conv = await getConv(lead.id);
      const msgs = conv.messages || [];
      if (!msgs.length) continue;
      conversations++;
      const plat = String(lead.platform || "unknown");
      byPlatform[plat] = (byPlatform[plat] || 0) + 1;
      let touchedToday = false;
      for (const m of msgs) {
        if (m.role === "user") leadMessages++;
        else agentReplies++;
        if (m.at && String(m.at).slice(0, 10) === today) {
          messagesToday++;
          touchedToday = true;
        }
      }
      if (touchedToday) activeToday++;
      if (String(lead.createdAt || "").slice(0, 10) === today) newLeadsToday++;
      if (lead.phone?.trim()) phonesCaptured++;
      if (String(lead.state) === "flag_for_call") flaggedForCall++;
      if (lead.automationPaused) paused++;
    }
    res.json({
      generatedAt: new Date().toISOString(),
      conversations,
      byPlatform,
      messages: { fromLeads: leadMessages, agentReplies, total: leadMessages + agentReplies, today: messagesToday },
      today: { newLeads: newLeadsToday, activeConversations: activeToday },
      phoneCaptures: {
        total: phonesCaptured,
        rate: conversations ? Math.round((phonesCaptured / conversations) * 100) : 0,
      },
      needsMarco: { flaggedForCall, automationPaused: paused },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/dm/conversation/:leadId", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { listAllLeads: allLeads, getConversation: getConv } = await import("./core/db.js");
    const lead = (await allLeads()).find((l) => l.id === req.params.leadId);
    if (!lead) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const conv = await getConv(lead.id);
    res.json({
      lead: {
        id: lead.id,
        name: lead.name || lead.username || lead.userId || "Lead",
        platform: lead.platform || "unknown",
        userId: lead.userId,
        state: lead.state ? String(lead.state) : null,
        phone: lead.phone || null,
        crmStage: lead.crmStage,
        crmIntent: lead.crmIntent,
      },
      messages: conv.messages || [],
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
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
      /* SMS carries no post context — the listing link, if any, was already made
         when the lead came in through the DM funnel. */
      listingRef: null,
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

/** Website visit — re-engagement when lead is ghosted (30+ days no inbound SMS). */
/* ── Client property shortlist + branded PDF ──────────────────────────────
   The homes picked for one lead, and the one-click document made from them.
   Facts join live from the MLS mirror at read time (price cuts show same-day). */
app.get("/api/leads/:id/favorites", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { listFavorites } = await import("./core/favoritesStore.js");
  res.json({ favorites: listFavorites(String(req.params.id || "")) });
});

app.post("/api/leads/:id/favorites", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const listingKey = String((req.body as Record<string, unknown>)?.listingKey || "").trim();
  if (!listingKey) { res.status(400).json({ error: "listingKey is required" }); return; }
  const { getListing } = await import("./core/listingsStore.js");
  if (!getListing(listingKey)) {
    res.status(404).json({ error: "That listing is not in the MLS mirror." });
    return;
  }
  const { addFavorite } = await import("./core/favoritesStore.js");
  const note = typeof (req.body as Record<string, unknown>)?.note === "string"
    ? String((req.body as Record<string, unknown>).note) : undefined;
  res.json({ ok: true, ...addFavorite(String(req.params.id || ""), listingKey, note) });
});

app.delete("/api/leads/:id/favorites/:key", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { removeFavorite } = await import("./core/favoritesStore.js");
  res.json({ ok: true, ...removeFavorite(String(req.params.id || ""), String(req.params.key || "")) });
});

/** The branded PDF of a lead's shortlist — photos, pricing, details, links. */
app.get("/api/leads/:id/property-pdf", async (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const leadId = String(req.params.id || "");
    const { listFavorites } = await import("./core/favoritesStore.js");
    const entries = listFavorites(leadId);
    if (!entries.some((e) => e.listing)) {
      res.status(404).json({ error: "This lead has no shortlisted homes yet. Add some from the MLS tab first." });
      return;
    }
    const { getLeadById } = await import("./core/db.js");
    const lead = await getLeadById(leadId);
    const clientName = (lead?.name || "you").trim() || "you";
    const { buildPropertyPdf } = await import("./core/propertyPdf.js");
    const origin = `${req.get("x-forwarded-proto") || req.protocol}://${req.get("host")}`;
    const bytes = await buildPropertyPdf({ clientName, entries, linkOrigin: origin });
    const safeName = clientName.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "client";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="homes-for-${safeName}.pdf"`);
    res.send(Buffer.from(bytes));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/leads/:id/website-visit", express.json(), async (req, res) => {
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
    const result = await handleWebsiteVisit(leadId);
    res.status(200).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message, triggered: false });
  }
});

/** Legacy website visit intake (body: leadId or phone) — delegates to re-engagement agent. */
app.post("/api/activity/website-visit", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const leadIdRaw = typeof req.body?.leadId === "string" ? req.body.leadId.trim() : "";
  const phoneRaw = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  let lead = leadIdRaw ? await getLeadById(leadIdRaw) : null;
  if (!lead && phoneRaw) lead = await findLeadByPhoneDigits(phoneRaw);
  if (!lead) {
    res.status(404).json({ error: "Lead not found", triggered: false });
    return;
  }
  try {
    const result = await handleWebsiteVisit(lead.id);
    res.status(200).json({ ...result, leadId: lead.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message, triggered: false });
  }
});

/** Listing status intake — transition detection; manual today, MLS feed later. */
app.post("/api/leads/:id/listing-status", express.json(), async (req, res) => {
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
    const result = await handleListingStatusUpdate(
      leadId,
      address,
      status as "active" | "pending" | "off_market" | "expired" | "sold",
      source,
    );
    res.status(200).json(result);
  } catch (err) {
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
  res.json({ notifications: unreadOnly ? getUnreadNotifications() : getAllNotifications() });
});

app.post("/api/crm/notifications/:id/read", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  markNotificationRead(String(req.params.id || ""));
  res.json({ success: true });
});

/** Content Manager — ingest, repurpose, compliance, publish, analytics. */
app.post("/api/content/ingest", express.json(), async (req, res) => {
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
    const session = await ingestContent({
      type,
      path: typeof req.body?.path === "string" ? req.body.path : undefined,
      url: typeof req.body?.url === "string" ? req.body.url : undefined,
      meta: req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : undefined,
    });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/content/repurpose/:sessionId", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  try {
    const clips = await repurposeSession(String(req.params.sessionId || ""));
    res.json({ clips });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/content/compliance/:videoId", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  try {
    const result = await runComplianceCheck(String(req.params.videoId || ""));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/content/publish/:videoId", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  // Accept a platforms[] array (one call → many platforms via Upload-Post).
  // Back-compat: a single `platform` string is wrapped into the array.
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  let platforms: string[] = [];
  if (Array.isArray(body.platforms)) {
    platforms = body.platforms.map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  } else if (typeof body.platform === "string" && body.platform.trim()) {
    platforms = [body.platform.trim().toLowerCase()];
  }
  if (!platforms.length) {
    res.status(400).json({ error: "platforms required (array of tiktok/instagram/facebook)" });
    return;
  }
  const scheduledFor = typeof body.scheduled_for === "string" ? body.scheduled_for.trim() : null;
  try {
    const outcome = await publishVideo(String(req.params.videoId || ""), platforms, { scheduledFor });
    const anySuccess = outcome.results.some((r) => r.state === "success");
    const anyPending = outcome.results.some((r) => r.state === "pending");
    const allFailed = outcome.results.length > 0 && outcome.results.every((r) => r.state === "failed");
    // Only a genuine all-platform failure is an error. "pending" (accepted, not
    // yet confirmed) is a normal 200 — the clip shows "Submitted".
    if (allFailed) {
      res.status(502).json({
        error: outcome.results.map((r) => `${r.platform}: ${r.error || "failed"}`).join("; "),
        results: outcome.results,
      });
      return;
    }
    // Honest per-platform results — never a blanket "published".
    res.json({ ok: anySuccess, pending: anyPending, results: outcome.results });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Whether publishing is connected right now. Upload-Post handles TikTok,
// Instagram and Facebook through ONE API key, so this is a single real check
// (a live listUsers() call) mirrored across the three platform flags the UI
// reads. Until UPLOAD_POST_API_KEY is set and valid, all three are "Not
// connected" — no faked state.
app.get("/api/content/publish/capabilities", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const connected = await uploadPostConnected();
  res.json({
    provider: "upload-post",
    connected,
    tiktok: { connected },
    instagram: { connected },
    facebook: { connected },
  });
});

// Publicly fetchable clip stream for Meta (Instagram/Facebook cURL the video
// by URL). Authorized by a short-lived HMAC signature in the query, NOT the
// dashboard token — so the master token is never exposed to Meta.
app.get("/api/content/public-clip/:videoId", (req, res) => {
  const videoId = String(req.params.videoId || "");
  const exp = String(req.query.exp || "");
  const sig = String(req.query.sig || "");
  if (!verifySignedClip(videoId, exp, sig)) {
    res.status(403).json({ error: "Invalid or expired clip signature" });
    return;
  }
  const video = getContentVideo(videoId);
  if (!video) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }
  const filePath = resolveClipFileForVideo(video);
  if (!filePath) {
    res.status(404).json({ error: "Video file not found on disk" });
    return;
  }
  try {
    streamClipVideoFile(req, res, filePath);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Remove a clip from the publish queue — it will NOT be posted. Mirrors the
// Review Queue reject flow: a status change (to "rejected", which drops it from
// the queue) plus reclaiming the clip file, not a hard DB delete.
app.post("/api/content/publishing-queue/:videoId/remove", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  try {
    const videoId = String(req.params.videoId || "");
    const video = getContentVideo(videoId);
    if (!video) {
      res.status(404).json({ error: `Video not found: ${videoId}` });
      return;
    }
    updateContentVideo(videoId, { status: "rejected" });
    // Late reject (pulled from the publish queue) — still a rejection signal.
    try {
      recordClipDecision(videoId, "rejected");
    } catch (err) {
      console.warn("[publishing-queue-remove] could not record clip decision:", err);
    }
    const clipPath = resolveClipFileForVideo(video);
    if (clipPath) deleteClipFile(clipPath);
    res.json({ ok: true, videoId, removed: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/content/triage-dm", express.json(), async (req, res) => {
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
    const result = await triageDm({
      platform,
      userId,
      message,
      username: typeof req.body?.username === "string" ? req.body.username : undefined,
    });
    res.json(result);
  } catch (err) {
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
  const videos = listContentVideosWithEnhancements({
    status: validStatuses.has(status)
      ? (status as import("./core/contentDb.js").ContentVideoStatus)
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
  res.json(getContentManagerStats());
});

app.get("/api/content/lead-captures", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const capturedFrom =
    req.query.captured_from === "dm" || req.query.captured_from === "comment"
      ? req.query.captured_from
      : undefined;
  const limit = Number(req.query.limit) || 100;
  res.json({ captures: listLeadCaptures({ capturedFrom, limit }) });
});

app.post("/api/content/comments/log", (_req, res) => {
  if (!dashboardTokenOk(_req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  trackCommentManaged();
  res.json({ ok: true });
});

app.post("/api/content/compliance/:videoId/decision", express.json(), (req, res) => {
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
    const videoId = String(req.params.videoId || "");
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const result = applyComplianceDecision(videoId, decision, reason);
    // A rejected clip has no further use — reclaim its file immediately.
    if (decision === "rejected") {
      // Record BEFORE deleting the file so the decision row captures the
      // clip's traits (hook type, scores) for the Brain's feedback loop.
      try {
        recordClipDecision(videoId, "rejected");
      } catch (err) {
        console.warn("[compliance-decision] could not record clip decision:", err);
      }
      const video = getContentVideo(videoId);
      const clipPath = video ? resolveClipFileForVideo(video) : null;
      if (clipPath) deleteClipFile(clipPath);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/content/analytics", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json({
    rows: getAnalyticsDataset(),
    pillarSummary: getPillarPerformanceSummary(),
    weekly: getWeeklyReport(),
  });
});

function resolveContentVideoUploadDir(): string {
  const base = fs.existsSync("/data") ? "/data" : path.join(process.cwd(), "data");
  const dir = path.join(base, "uploads", "videos");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveContentClipsDir(): string {
  const base = fs.existsSync("/data") ? "/data" : path.join(process.cwd(), "data");
  const dir = path.join(base, "clips");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveClipVideoFilePath(storedPath: string): string | null {
  if (!storedPath || storedPath.startsWith("mock://")) return null;

  const normalized = storedPath.replace(/\\/g, "/");

  if (normalized.startsWith("/openshorts/clips/")) {
    const rel = normalized.replace("/openshorts/clips/", "");
    const candidate = path.join(resolveContentClipsDir(), rel);
    if (fs.existsSync(candidate)) return candidate;
  }

  if (normalized.startsWith("/clips/")) {
    const rel = normalized.replace("/clips/", "");
    const candidate = path.join(resolveContentClipsDir(), rel);
    if (fs.existsSync(candidate)) return candidate;
  }

  if (fs.existsSync(storedPath)) return storedPath;

  const dataBase = fs.existsSync("/data") ? "/data" : path.join(process.cwd(), "data");
  const stripped = normalized
    .replace(/^\/data\//, "")
    .replace(/^data\//, "")
    .replace(/^\\data\\/, "");
  const candidates = [
    path.join(dataBase, stripped),
    path.join(resolveContentClipsDir(), path.basename(stripped)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function gatherClipPathCandidates(video: ContentVideo): string[] {
  const candidates: string[] = [];
  if (video.filePath) candidates.push(video.filePath);

  if (video.sourceSessionId) {
    const session = getContentSession(video.sourceSessionId);
    const meta = session?.rawInputMeta;
    if (meta && typeof meta.clipPath === "string" && meta.clipPath) {
      candidates.push(meta.clipPath);
    }
    if (meta && typeof meta.clipUrl === "string" && meta.clipUrl) {
      candidates.push(mapClipUrlForFrontend(meta.clipUrl));
    }
  }

  return [...new Set(candidates.filter(Boolean))].filter((p) => !p.startsWith("mock://"));
}

function resolveClipFileForVideo(video: ContentVideo): string | null {
  for (const candidate of gatherClipPathCandidates(video)) {
    const resolved = resolveClipVideoFilePath(candidate);
    if (resolved) return resolved;
  }
  return null;
}

function streamClipVideoFile(req: express.Request, res: express.Response, filePath: string): void {
  // Size is read fresh from disk on every request. Clip files are REPLACED in
  // place (same URL) when edited, so the browser must never reuse a cached
  // byte-size — no-store forces it to revalidate against the current file.
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.setHeader("Accept-Ranges", "bytes");

  // Pipe with an error guard so a mid-stream read failure never crashes the
  // process or triggers a double-response.
  const pipeWithGuard = (opts?: { start: number; end: number }): void => {
    const stream = opts ? fs.createReadStream(filePath, opts) : fs.createReadStream(filePath);
    stream.on("error", (err) => {
      console.error(`[clip-video] stream error for ${filePath}: ${(err as Error).message}`);
      res.destroy();
    });
    stream.pipe(res);
  };

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (end > fileSize - 1) end = fileSize - 1;

    // Defensive 416: a start beyond the current file end (classic stale-browser-
    // metadata after an edit shrank the file) must fail cleanly BEFORE any 206
    // header is written — never hand createReadStream start > end.
    if (Number.isNaN(start) || start < 0 || start >= fileSize || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${fileSize}`, "Content-Type": "video/mp4" });
      res.end();
      return;
    }

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Content-Length": end - start + 1,
      "Content-Type": "video/mp4",
    });
    pipeWithGuard({ start, end });
    return;
  }

  res.writeHead(200, { "Content-Length": fileSize, "Content-Type": "video/mp4" });
  pipeWithGuard();
}

// Phase 3b — raised from 2GB to support full-length real estate walkthroughs
// shot on-device (iPhone 1080p/4K MOV can easily hit 3-4GB for 30-60 minutes).
const MAX_UPLOAD_FILE_BYTES = 4 * 1024 * 1024 * 1024;

// Phase 5a — size-aware pre-upload disk check. Replaces the old flat 600MB
// threshold: a check that doesn't scale with the incoming file size lets a
// 4GB upload through with only 700MB free, which then fails deep into
// processing instead of at submission time. Required space = the upload
// itself + processing headroom + a reserve for the clips it will generate.
const UPLOAD_PROCESSING_HEADROOM_MB = 500;
const UPLOAD_CLIPS_HEADROOM_MB = 7 * 1024; // 7GB — worst-case reserve for generated clips

function requireDiskSpaceForUpload(): express.RequestHandler {
  return (req, res, next) => {
    const contentLength = Number(req.headers["content-length"] || 0);
    const incomingMB = contentLength > 0 ? contentLength / (1024 * 1024) : 0;
    const neededMB = incomingMB + UPLOAD_PROCESSING_HEADROOM_MB + UPLOAD_CLIPS_HEADROOM_MB;
    void getFreeDiskMB().then((freeMB) => {
      if (Number.isFinite(freeMB) && freeMB < neededMB) {
        console.warn(
          `[batch-processor] Disk space check failed: ${freeMB}MB available, ~${Math.round(neededMB)}MB required ` +
          `(${Math.round(incomingMB)}MB upload + ${UPLOAD_PROCESSING_HEADROOM_MB}MB processing + ${UPLOAD_CLIPS_HEADROOM_MB}MB clips reserve). ` +
          `Upload rejected before any bytes were written.`,
        );
        res.status(507).json({
          error:
            `Not enough disk space to process — ${freeMB}MB available, ~${Math.round(neededMB)}MB required. ` +
            `Free up space by reviewing and publishing pending clips, or contact support.`,
        });
        return;
      }
      next();
    });
  };
}

// Phase 5d — precise per-batch estimate once real file sizes are known (runs
// after multer has written the files; the header-based check above is a fast
// first-pass guard, this is the accurate second pass). Batches are gap-driven
// toward the daily 7-video target (calculateTargetClipsPerFile in
// batchProcessor.ts), not 7 clips per source file, so this estimates clip
// space for the batch as a whole rather than multiplying per file.
const CLIP_SIZE_RATIO = 0.3; // generated clips run ~30% of source bitrate (short duration, similar codec)
const ESTIMATED_TOTAL_CLIPS_PER_BATCH = 7;

function estimateBatchClipSpaceMB(files: Express.Multer.File[]): number {
  const totalSourceMB = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
  return totalSourceMB * CLIP_SIZE_RATIO * ESTIMATED_TOTAL_CLIPS_PER_BATCH;
}

// Phase 3e — upload progress tracking. The client generates an uploadId,
// passes it as a query param (available before multer/body parsing runs),
// and polls GET /api/content/upload-progress/:uploadId every 2s while the
// bytes stream in. This is intentionally server-tracked (not just
// xhr.upload.onprogress client-side) so progress is visible from any poller.
interface UploadProgressEntry {
  bytesReceived: number;
  totalBytes: number;
  startedAt: number;
  done: boolean;
}
const uploadProgressMap = new Map<string, UploadProgressEntry>();
const UPLOAD_PROGRESS_STALE_MS = 60 * 60 * 1000; // 1h — sweep abandoned entries

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of uploadProgressMap) {
    if (now - entry.startedAt > UPLOAD_PROGRESS_STALE_MS) uploadProgressMap.delete(id);
  }
}, 10 * 60 * 1000).unref();

function trackUploadProgress(): express.RequestHandler {
  return (req, res, next) => {
    const uploadId = typeof req.query.uploadId === "string" ? req.query.uploadId : null;
    if (!uploadId) {
      next();
      return;
    }
    const totalBytes = Number(req.headers["content-length"] || 0);
    const entry: UploadProgressEntry = { bytesReceived: 0, totalBytes, startedAt: Date.now(), done: false };
    uploadProgressMap.set(uploadId, entry);
    req.on("data", (chunk: Buffer) => {
      entry.bytesReceived += chunk.length;
    });
    const finish = () => {
      entry.done = true;
      entry.bytesReceived = entry.totalBytes || entry.bytesReceived;
      setTimeout(() => uploadProgressMap.delete(uploadId), 30_000);
    };
    res.on("finish", finish);
    res.on("close", finish);
    next();
  };
}

app.get("/api/content/upload-progress/:uploadId", (req, res) => {
  const entry = uploadProgressMap.get(req.params.uploadId);
  if (!entry) {
    res.status(404).json({ error: "Unknown or expired uploadId" });
    return;
  }
  const percentComplete =
    entry.totalBytes > 0 ? Math.min(100, Math.round((entry.bytesReceived / entry.totalBytes) * 100)) : 0;
  res.json({
    bytesReceived: entry.bytesReceived,
    totalBytes: entry.totalBytes,
    percentComplete,
    done: entry.done,
  });
});

const contentVideoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, resolveContentVideoUploadDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".mp4";
      cb(null, `${Date.now()}-${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

const batchVideoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, resolveContentVideoUploadDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".mp4";
      cb(null, `${Date.now()}-${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// Style-example upload (Upload & Clip → "Teach the clipper" zones). Same
// video-type restrictions as batchVideoUpload; kept separate so its route can
// stay independent of batch-session lifecycle.
const styleExampleUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, resolveContentVideoUploadDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".mp4";
      cb(null, `style-${Date.now()}-${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// Audio track upload for the clip editor's "replace audio" action. Saved to the
// shared uploads volume; its path is passed to a subsequent /edit (audio=replace).
const clipAudioUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, resolveContentVideoUploadDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".mp3";
      cb(null, `audio-${Date.now()}-${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 64 * 1024 * 1024 }, // 64MB — ample for a clip-length track
  fileFilter: (_req, file, cb) => {
    const allowed = [".mp3", ".m4a", ".aac", ".wav", ".ogg"];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// Script/notes upload for the Upload & Clip context feature. Small text-ish
// files only; the extracted text rides the batch session into the clipping prompt.
const scriptTextUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, resolveContentVideoUploadDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".txt";
      cb(null, `script-${Date.now()}-${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — scripts are text, not media
  fileFilter: (_req, file, cb) => {
    const allowed = [".txt", ".pdf", ".docx", ".doc"];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// Extract plain text from an uploaded script (.txt directly, .pdf via pdf-parse,
// .docx/.doc placeholder). The temp file is always removed — only text survives.
app.post("/api/content/extract-text", scriptTextUpload.single("file"), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file uploaded (field name: file; allowed: txt, pdf, docx, doc)." });
    return;
  }
  try {
    const ext = path.extname(file.originalname).toLowerCase();
    let text = "";
    if (ext === ".txt") {
      text = fs.readFileSync(file.path, "utf8");
    } else if (ext === ".pdf") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
        const data = await pdfParse(fs.readFileSync(file.path));
        text = data.text || "";
      } catch (pdfErr) {
        console.warn(`[extract-text] pdf-parse failed for ${file.originalname}:`, pdfErr);
        text = `[PDF: ${file.originalname} — text could not be extracted]`;
      }
    } else {
      text = `[File: ${file.originalname} — only .txt and .pdf text extraction is supported; paste key lines into the context box instead]`;
    }
    res.json({ text: text.slice(0, 10000), truncated: text.length > 10000 });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    try { fs.unlinkSync(file.path); } catch { /* best-effort temp cleanup */ }
  }
});

app.post("/api/content/clip/:clipId/audio", clipAudioUpload.single("audio"), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "No audio file uploaded (field name: audio; allowed: mp3, m4a, aac, wav, ogg)." });
    return;
  }
  // Return the server path — the client sends it back with the /edit call.
  res.json({ ok: true, audioReplacePath: req.file.path, fileName: req.file.originalname });
});

// FreeCut round-trip: Marco edits a clip in the FreeCut browser editor (external,
// client-side), exports it to disk, and re-uploads it here. The uploaded file
// REPLACES this clip's video so the existing publish flow uses the edited version.
// Non-destructive: the previous file is kept as a revertable version, mirroring
// the /trim + /edit safety pattern.
const clipVideoReplaceUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, resolveContentVideoUploadDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".mp4";
      cb(null, `freecut-${Date.now()}-${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB — a full edited export can be large
  fileFilter: (_req, file, cb) => {
    const allowed = [".mp4", ".mov", ".webm", ".mkv", ".m4v"];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

app.post(
  "/api/content/clip/:clipId/replace-upload",
  requireDiskSpaceForUpload(),
  clipVideoReplaceUpload.single("video"),
  (req, res) => {
    if (!dashboardTokenOk(req)) {
      res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
      return;
    }
    const clipId = String(req.params.clipId || "");
    const video = getContentVideo(clipId);
    if (!video) {
      res.status(404).json({ error: "Clip not found" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No video uploaded (field name: video; allowed: mp4, mov, webm, mkv, m4v)." });
      return;
    }
    // Confirm the upload is a readable video (ffprobe returns a real duration)
    // before repointing the clip at it.
    const dur = probeClipDurationSeconds(req.file.path);
    if (!dur || dur <= 0) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      res.status(422).json({ error: "Uploaded file could not be read as a video (corrupt or unsupported)." });
      return;
    }
    const oldPath = resolveClipFileForVideo(video);
    updateContentVideoFilePath(clipId, req.file.path);
    if (oldPath && path.resolve(oldPath) !== path.resolve(req.file.path)) {
      saveClipVersionKeepingOne(clipId, oldPath); // keep the pre-FreeCut version for revert
    }
    console.log(`[freecut] Clip ${clipId} replaced with uploaded edit (${req.file.originalname})`);
    res.json({ ok: true, videoUrl: `/api/content/clip/${clipId}/video?v=${Date.now()}` });
  },
);

app.post("/api/content/upload", requireDiskSpaceForUpload(), trackUploadProgress(), contentVideoUpload.single("video"), async (req, res) => {
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
    const session = await ingestContent({
      type: "video",
      path: savedPath,
      meta: { pillar, notes, originalName: req.file.originalname },
    });
    const clips = await repurposeSession(session.id);
    res.json({ session, clips, savedPath });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/content/batch-upload", requireDiskSpaceForUpload(), trackUploadProgress(), batchVideoUpload.array("videos", 20), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files?.length) {
    res.status(400).json({ error: "At least one video file required (field name: videos)" });
    return;
  }

  // Phase 5d — precise per-batch estimate now that real file sizes are known.
  const estimatedClipSpaceMB = estimateBatchClipSpaceMB(files);
  const neededMB = estimatedClipSpaceMB + UPLOAD_PROCESSING_HEADROOM_MB;
  const freeMBNow = await getFreeDiskMB();
  if (Number.isFinite(freeMBNow) && freeMBNow < neededMB) {
    for (const f of files) {
      try {
        fs.unlinkSync(f.path);
      } catch {
        /* best-effort — safety sweep will catch it if this fails */
      }
    }
    console.warn(
      `[batch-processor] Per-batch space estimate failed: ~${Math.round(neededMB)}MB needed ` +
      `(${Math.round(estimatedClipSpaceMB)}MB estimated clips + ${UPLOAD_PROCESSING_HEADROOM_MB}MB processing), ` +
      `${freeMBNow}MB available. Batch rejected, uploaded files removed.`,
    );
    res.status(507).json({
      error:
        `Not enough disk space for this batch — estimated ${Math.round(neededMB)}MB needed, ${freeMBNow}MB available. ` +
        `Review and publish pending clips to free space, or upload fewer/smaller files.`,
    });
    return;
  }

  const pillar = typeof req.body?.pillar === "string" ? req.body.pillar.trim() : "";
  if (!["education", "listings", "brand", "mixed"].includes(pillar)) {
    res.status(400).json({ error: "pillar required: education, listings, brand, or mixed" });
    return;
  }
  const sessionName =
    typeof req.body?.session_name === "string" ? req.body.session_name.trim() : "";
  const filmedBy =
    typeof req.body?.filmed_by === "string" && req.body.filmed_by.trim()
      ? req.body.filmed_by.trim()
      : "marco";
  const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : "";
  // Human direction for the clipping AI ("the good stuff starts at 3:10") and
  // optional script text — both flow into the sidecar's viral-moment prompt.
  const userContext =
    typeof req.body?.user_context === "string" ? req.body.user_context.trim().slice(0, 4000) : "";
  const scriptText =
    typeof req.body?.script_text === "string" ? req.body.script_text.trim().slice(0, 12000) : "";

  // Per-batch enhancement toggles ("1"/"0" form fields). Absent fields mean
  // "use server defaults" — only explicitly sent values are recorded.
  const flag = (name: string): boolean | undefined => {
    const v = req.body?.[name];
    if (v === "1" || v === "true") return true;
    if (v === "0" || v === "false") return false;
    return undefined;
  };
  const enhanceOptions = {
    captions: flag("enhance_captions"),
    autoZoom: flag("enhance_auto_zoom"),
    broll: flag("enhance_broll"),
  };
  const hasEnhanceOptions = Object.values(enhanceOptions).some((v) => v !== undefined);

  const batch = createBatchSession({
    sessionName: sessionName || null,
    pillar,
    filmedBy,
    status: "uploading",
    sourceFileCount: files.length,
    notes: notes || null,
    userContext: userContext || undefined,
    scriptText: scriptText || undefined,
    enhanceOptions: hasEnhanceOptions ? enhanceOptions : undefined,
  });

  for (const file of files) {
    createBatchSourceFile({
      batchSessionId: batch.id,
      originalFilename: file.originalname,
      fileSizeBytes: file.size,
      filePath: file.path,
    });
  }

  updateBatchSession(batch.id, { status: "analyzing_trends" });

  setImmediate(() => {
    processBatch(batch.id).catch((err) => {
      console.error(`[batch-upload] processBatch failed for ${batch.id}:`, err);
      updateBatchSession(batch.id, { status: "failed" });
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

// ── Style examples — "teach the clipper" upload zones (Upload & Clip panel).
// Each upload is transcribed + analyzed for style (no cutting/reframing) and
// the resulting brief automatically rides into every future batch job — see
// getStyleGuideText() / submitToOpenShorts's style_guide field.
app.post(
  "/api/content/style-examples/upload",
  requireDiskSpaceForUpload(),
  styleExampleUpload.single("video"),
  async (req, res) => {
    if (!dashboardTokenOk(req)) {
      res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
      return;
    }
    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: "A video file is required (field name: video)" });
      return;
    }
    const kind = req.body?.kind === "raw" ? "raw" : "clip";

    const example = createStyleExample({
      kind,
      originalFilename: file.originalname,
      filePath: file.path,
    });

    setImmediate(() => {
      processStyleExample(example.id).catch((err) => {
        console.error(`[style-examples] processStyleExample failed for ${example.id}:`, err);
      });
    });

    res.json({ ok: true, example });
  },
);

app.get("/api/content/style-examples", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const kindParam = typeof req.query.kind === "string" ? req.query.kind : "";
  const kind: CmStyleExampleKind | undefined = kindParam === "raw" || kindParam === "clip" ? kindParam : undefined;
  res.json({ examples: listStyleExamples(kind) });
});

app.delete("/api/content/style-examples/:id", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const ok = deleteStyleExample(String(req.params.id || ""));
  if (!ok) {
    res.status(404).json({ error: "Style example not found" });
    return;
  }
  res.json({ ok: true });
});

app.get("/api/content/batch/:batchId/status", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const batchId = String(req.params.batchId || "");
  const batch = getBatchSession(batchId);
  if (!batch) {
    res.status(404).json({ error: "Batch not found" });
    return;
  }
  const sourceFiles = listBatchSourceFiles(batchId);
  const clipsReady = countVideosByBatchAndStatus(batchId, "pending_review");
  let trendBrief: string | null = null;
  if (batch.trendBriefId) {
    const trends = getCompetitorTrendsById(batch.trendBriefId);
    trendBrief = trends?.trendBrief ?? null;
  }

  const progressMap: Record<string, number> = {
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

  const stageLabelMap: Record<string, string> = {
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
  const clips = listContentVideosWithEnhancements({ batchSessionId: batchId, limit: 200 });
  res.json({ clips });
});

app.get("/api/content/batches", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const days = Number(req.query.days) || 7;
  res.json({ batches: listBatchSessions(days) });
});

app.delete("/api/content/batch/:batchId", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const batchId = String(req.params.batchId || "");
  try {
    const result = deleteBatchSession(batchId);
    if (!result.deleted) {
      res.status(404).json({ error: "Batch not found" });
      return;
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(`[batch-delete] Failed to delete batch ${batchId}:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/content/competitor-trends/latest", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const trends = getLatestCompetitorTrends();
  res.json({ trends });
});

app.post("/api/content/competitor-trends/refresh", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  try {
    const trends = await runCompetitorScrape();
    res.json({ trends });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/content/clip/:clipId/meta", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const clipId = String(req.params.clipId || "");
  const video = getContentVideo(clipId);
  if (!video) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  const storedPath = video.filePath || "";
  const isMock = !storedPath || storedPath.startsWith("mock://");
  const resolvedPath = resolveClipFileForVideo(video);
  const fileExists = Boolean(resolvedPath);

  const session = video.sourceSessionId ? getContentSession(video.sourceSessionId) : null;
  const thumbMeta = session?.rawInputMeta?.thumbnailUrl;
  const thumbnailUrl =
    typeof thumbMeta === "string" && thumbMeta && !thumbMeta.startsWith("mock://")
      ? thumbMeta
      : null;

  res.json({
    clipId,
    hasVideo: fileExists,
    isMock,
    clipPath: fileExists ? resolvedPath : null,
    videoUrl: fileExists ? `/api/content/clip/${clipId}/video` : null,
    thumbnailUrl,
    hasPreviousVersion: Boolean(getLatestClipVersion(clipId)),
  });
});

app.get("/api/content/clip/:clipId/video", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const clipId = String(req.params.clipId || "");
  const video = getContentVideo(clipId);
  if (!video) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  const candidatePaths = gatherClipPathCandidates(video);
  const filePath = resolveClipFileForVideo(video);
  if (!filePath) {
    console.log(
      `[clip-video] No video file found for clip ${clipId}. Candidates tried:`,
      candidatePaths,
    );
    res.status(404).json({
      error: "Video file not found on disk",
      hint: "This may be a mock clip or the file was not saved correctly",
      candidatePaths,
    });
    return;
  }

  try {
    streamClipVideoFile(req, res, filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[clip-video] Error serving clip:", message);
    res.status(500).json({ error: message });
  }
});

// Retain the pre-edit clip as the (single) prior version so an edit is
// revertible. Keep-1: discard any older version first, then record this one.
function saveClipVersionKeepingOne(videoId: string, oldClipPath: string): void {
  try {
    const prior = getLatestClipVersion(videoId);
    if (prior) {
      deleteClipFile(prior.filePath);
      deleteClipVersion(prior.id);
    }
    recordClipVersion(videoId, oldClipPath);
  } catch (err) {
    // Versioning must never block an edit — fall back to reclaiming the old file.
    console.error(`[clip-version] Could not retain version for ${videoId}: ${(err as Error).message}`);
    deleteClipFile(oldClipPath);
  }
}

// Trim an already-generated clip to a new [start, end] range (seconds, relative
// to the clip's own duration) and re-render via the sidecar. Non-destructive:
// the original clip is only replaced after a confirmed-good render, and any
// failure leaves it fully intact and playable.
app.post("/api/content/clip/:clipId/trim", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const clipId = String(req.params.clipId || "");
  const video = getContentVideo(clipId);
  if (!video) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  const body = req.body as { start?: unknown; end?: unknown };
  const start = Number(body?.start);
  const end = Number(body?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    res.status(400).json({ error: "Invalid range: provide numeric start/end in seconds with 0 <= start < end." });
    return;
  }
  if (end - start < 3) {
    res.status(400).json({ error: "Trimmed length must be at least 3 seconds." });
    return;
  }

  const storedPath = video.filePath || "";
  if (!storedPath || storedPath.startsWith("mock://")) {
    res.status(400).json({ error: "This clip has no real video file to trim (mock clip or not yet rendered)." });
    return;
  }
  const currentPath = resolveClipFileForVideo(video);
  if (!currentPath) {
    res.status(410).json({ error: "Clip file is no longer available on disk — it may have been cleaned up." });
    return;
  }

  // Light Node-side disk guard; the sidecar runs the authoritative pre-check.
  const freeMB = await getFreeDiskMB();
  if (Number.isFinite(freeMB) && freeMB < 300) {
    res.status(507).json({ error: `Insufficient disk space to render a trim (${freeMB}MB free).` });
    return;
  }

  try {
    const result = await trimClipViaOpenShorts({ clipPath: currentPath, start, end });
    if (!result.newClipPath) throw new Error("Trim did not return a new file path");

    // Repoint the clip only after a confirmed-good render, then clean up the old
    // file via the existing safe cleanup pattern. Reaching here means the render
    // succeeded; any earlier failure left the original clip + DB untouched.
    updateContentVideoFilePath(clipId, result.newClipPath);
    if (path.resolve(result.newClipPath) !== path.resolve(currentPath)) {
      saveClipVersionKeepingOne(clipId, currentPath);
    }

    res.json({
      ok: true,
      newDuration: result.newDuration,
      videoUrl: `/api/content/clip/${clipId}/video?v=${Date.now()}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[clip-trim] Clip ${clipId} trim failed: ${message}`);
    res.status(502).json({ error: message }); // original clip untouched
  }
});

// Structural edit of an already-generated clip: trim ends, remove middle
// sections, mute/remove audio. Non-destructive (original replaced only after a
// confirmed render); mirrors the /trim endpoint's safety pattern.
app.post("/api/content/clip/:clipId/edit", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const clipId = String(req.params.clipId || "");
  const video = getContentVideo(clipId);
  if (!video) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  const body = req.body as {
    trim?: unknown; cuts?: unknown; audio?: unknown; captions?: unknown; audioReplacePath?: unknown;
    color?: unknown; effects?: unknown; autoTighten?: unknown; snapToScenes?: unknown;
  };
  const audio =
    body?.audio === "mute" || body?.audio === "remove" || body?.audio === "replace" ? body.audio : "keep";
  let audioReplacePath: string | undefined;
  if (audio === "replace") {
    audioReplacePath = typeof body?.audioReplacePath === "string" ? body.audioReplacePath : "";
    if (!audioReplacePath) {
      res.status(400).json({ error: "audio=replace requires an uploaded audioReplacePath (upload the track first)." });
      return;
    }
  }
  // Edited caption lines (start/end on the clip's original timeline + text).
  // Presence of this array switches the sidecar to render from the persisted
  // uncaptioned base and re-burn the re-synced text.
  let captions: Array<{ start: number; end: number; text: string }> | undefined;
  if (Array.isArray(body?.captions)) {
    captions = [];
    for (const c of body.captions as unknown[]) {
      const line = c as { start?: unknown; end?: unknown; text?: unknown };
      const s = Number(line?.start);
      const e = Number(line?.end);
      const text = typeof line?.text === "string" ? line.text : "";
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) {
        res.status(400).json({ error: "Each caption line needs numeric start < end and text." });
        return;
      }
      captions.push({ start: s, end: e, text });
    }
  }
  let trim: { start: number; end: number } | null = null;
  if (body?.trim && typeof body.trim === "object") {
    const t = body.trim as { start?: unknown; end?: unknown };
    const s = Number(t.start);
    const e = Number(t.end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s) {
      res.status(400).json({ error: "Invalid trim range: need 0 <= start < end (seconds)." });
      return;
    }
    trim = { start: s, end: e };
  }
  const cuts: Array<[number, number]> = [];
  if (Array.isArray(body?.cuts)) {
    for (const c of body.cuts as unknown[]) {
      if (!Array.isArray(c) || c.length < 2) {
        res.status(400).json({ error: "Each cut must be [start, end]." });
        return;
      }
      const cs = Number(c[0]);
      const ce = Number(c[1]);
      if (!Number.isFinite(cs) || !Number.isFinite(ce) || ce <= cs) {
        res.status(400).json({ error: "Each cut must have numeric start < end." });
        return;
      }
      cuts.push([cs, ce]);
    }
  }
  // ── Phase 2 visual/structural skills (all optional) ──────────────────────
  const COLOR_MODES = ["auto", "warm", "cool", "punch", "flat"] as const;
  const EFFECT_TYPES = ["zoom_in", "zoom_out", "punch_in"] as const;
  let color: (typeof COLOR_MODES)[number] | undefined;
  if (typeof body?.color === "string") {
    const c = body.color.toLowerCase();
    if (!(COLOR_MODES as readonly string[]).includes(c)) {
      res.status(400).json({ error: `color must be one of ${COLOR_MODES.join(", ")}.` });
      return;
    }
    color = c as (typeof COLOR_MODES)[number];
  }
  const effects: Array<{ type: "zoom_in" | "zoom_out" | "punch_in"; start: number; end: number; amount?: number }> = [];
  if (Array.isArray(body?.effects)) {
    for (const e of body.effects as unknown[]) {
      const eff = e as { type?: unknown; start?: unknown; end?: unknown; amount?: unknown };
      const type = String(eff?.type || "");
      const s = Number(eff?.start);
      const en = Number(eff?.end);
      if (!(EFFECT_TYPES as readonly string[]).includes(type) || !Number.isFinite(s) || !Number.isFinite(en) || en <= s) {
        res.status(400).json({ error: `Each effect needs type in [${EFFECT_TYPES.join(", ")}] and numeric start < end.` });
        return;
      }
      const amount = Number(eff?.amount);
      effects.push({ type: type as "zoom_in" | "zoom_out" | "punch_in", start: s, end: en, ...(Number.isFinite(amount) ? { amount } : {}) });
    }
  }
  // autoTighten: true, or { maxGap?, noiseDb? }
  let autoTighten: boolean | { maxGap?: number; noiseDb?: number } | undefined;
  if (body?.autoTighten === true) {
    autoTighten = true;
  } else if (body?.autoTighten && typeof body.autoTighten === "object") {
    const o = body.autoTighten as { maxGap?: unknown; noiseDb?: unknown };
    autoTighten = {
      ...(Number.isFinite(Number(o.maxGap)) ? { maxGap: Number(o.maxGap) } : {}),
      ...(Number.isFinite(Number(o.noiseDb)) ? { noiseDb: Number(o.noiseDb) } : {}),
    };
  }
  const snapToScenes = body?.snapToScenes === true ? true : undefined;

  const hasVisualOrTighten = Boolean(color || effects.length || autoTighten || snapToScenes);
  if (!trim && cuts.length === 0 && audio === "keep" && !captions && !hasVisualOrTighten) {
    res.status(400).json({ error: "No edits specified." });
    return;
  }

  const storedPath = video.filePath || "";
  if (!storedPath || storedPath.startsWith("mock://")) {
    res.status(400).json({ error: "This clip has no real video file to edit (mock clip or not yet rendered)." });
    return;
  }
  const currentPath = resolveClipFileForVideo(video);
  if (!currentPath) {
    res.status(410).json({ error: "Clip file is no longer available on disk — it may have been cleaned up." });
    return;
  }

  const freeMB = await getFreeDiskMB();
  if (Number.isFinite(freeMB) && freeMB < 300) {
    res.status(507).json({ error: `Insufficient disk space to render an edit (${freeMB}MB free).` });
    return;
  }

  try {
    const result = await editClipViaOpenShorts({
      clipPath: currentPath,
      editSpec: { trim, cuts, audio, audioReplacePath, captions, color, effects, autoTighten, snapToScenes },
    });
    if (!result.newClipPath) throw new Error("Edit did not return a new file path");
    updateContentVideoFilePath(clipId, result.newClipPath);
    if (path.resolve(result.newClipPath) !== path.resolve(currentPath)) {
      saveClipVersionKeepingOne(clipId, currentPath);
    }
    res.json({
      ok: true,
      newDuration: result.newDuration,
      videoUrl: `/api/content/clip/${clipId}/video?v=${Date.now()}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[clip-edit] Clip ${clipId} edit failed: ${message}`);
    res.status(502).json({ error: message }); // original clip untouched
  }
});

/* ── AI Edit: natural-language clip edits ─────────────────────────────────
   Parses an instruction like "remove the first 8 seconds" into a structural
   edit and applies it through the SAME non-destructive pipeline as /edit
   (frame-accurate re-encode via the sidecar, original kept as a revertable
   version). Common patterns are handled by regex with no LLM call; anything
   else is interpreted by Claude. */

/** Parse a time token from instruction text: "8", "8.5s", "2 minutes", "1:30". */
function parseAiEditTime(raw: string): number | null {
  const t = raw.trim();
  const mmss = t.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const num = t.match(/^(\d+(?:\.\d+)?)$/);
  if (num) return Number(num[1]);
  return null;
}

/** Regex fast-paths for the common edit phrasings. Returns null when unsure. */
function parseAiEditInstruction(
  instruction: string,
  duration: number,
): { start: number; end: number; description: string } | null {
  const s = instruction.toLowerCase();
  // Time expression: seconds ("8", "8.5 seconds", "8s"), minutes ("2 minutes"), or m:ss ("1:30")
  const T = String.raw`(\d+:\d+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(minutes?|mins?|m\b|seconds?|secs?|s\b)?`;
  const toSeconds = (value: string, unit?: string): number | null => {
    const base = parseAiEditTime(value);
    if (base == null) return null;
    if (unit && /^m/.test(unit) && !value.includes(":")) return base * 60;
    return base;
  };

  let m = s.match(new RegExp(String.raw`(?:remove|skip|cut|trim)\s+(?:the\s+)?first\s+${T}`));
  if (m) {
    const t = toSeconds(m[1], m[2]);
    if (t != null) return { start: t, end: duration, description: `Removed the first ${Math.round(t)}s` };
  }
  m = s.match(new RegExp(String.raw`(?:remove|trim|cut)\s+(?:the\s+)?last\s+${T}`));
  if (m) {
    const t = toSeconds(m[1], m[2]);
    if (t != null) return { start: 0, end: duration - t, description: `Removed the last ${Math.round(t)}s` };
  }
  m = s.match(new RegExp(String.raw`keep\s+(?:only\s+)?(?:the\s+)?first\s+${T}`));
  if (m) {
    const t = toSeconds(m[1], m[2]);
    if (t != null) return { start: 0, end: t, description: `Kept only the first ${Math.round(t)}s` };
  }
  m = s.match(new RegExp(String.raw`(?:cut|remove)\s+everything\s+after\s+${T}`));
  if (m) {
    const t = toSeconds(m[1], m[2]);
    if (t != null) return { start: 0, end: t, description: `Cut everything after ${Math.round(t)}s` };
  }
  m = s.match(new RegExp(String.raw`(?:start(?:ing)?\s+(?:at|from)|from)\s+${T}`));
  if (m) {
    const t = toSeconds(m[1], m[2]);
    if (t != null) return { start: t, end: duration, description: `Started the clip at ${Math.round(t)}s` };
  }
  return null;
}

/** Claude fallback for instructions the regexes can't parse. Conservative:
 * returns null (→ 422 to the user) rather than guessing a destructive cut. */
async function parseAiEditWithClaude(
  instruction: string,
  duration: number,
): Promise<{ action: "trim" | "cut_middle"; start: number; end: number; description: string } | null> {
  const prompt = `A video clip is exactly ${duration.toFixed(1)} seconds long. The editor's instruction: "${instruction}"

Interpret it as ONE structural edit and answer with JSON only (no markdown):
{"action": "trim" | "cut_middle" | "none", "start": <seconds>, "end": <seconds>, "description": "<one sentence, past tense>"}

- "trim": KEEP only [start, end] of the clip.
- "cut_middle": REMOVE the section [start, end] from the middle, joining what remains.
- "none": the instruction cannot be resolved to concrete timestamps from the wording alone (e.g. it refers to spoken words or visual events you cannot locate). When in doubt, use "none" — never guess.`;
  try {
    const response = await claudeContent.messages.create({
      model: CONTENT_MODELS.FAST,
      max_tokens: 300,
      system: "You convert plain-English video edit requests into exact cut timestamps. JSON only.",
      messages: [{ role: "user", content: prompt }],
    });
    const raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .replace(/```json|```/g, "")
      .trim();
    const parsed = JSON.parse(raw) as { action?: string; start?: unknown; end?: unknown; description?: string };
    if (parsed.action !== "trim" && parsed.action !== "cut_middle") return null;
    const start = Number(parsed.start);
    const end = Number(parsed.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return { action: parsed.action, start, end, description: parsed.description || instruction };
  } catch (err) {
    console.warn(`[ai-edit] Claude parse failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

app.post("/api/content/clip/:clipId/ai-edit", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const clipId = String(req.params.clipId || "");
  const instruction =
    typeof (req.body as { instruction?: unknown })?.instruction === "string"
      ? String((req.body as { instruction: string }).instruction).trim()
      : "";
  if (!instruction) {
    res.status(400).json({ error: "instruction is required" });
    return;
  }
  const video = getContentVideo(clipId);
  if (!video) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }
  const storedPath = video.filePath || "";
  if (!storedPath || storedPath.startsWith("mock://")) {
    res.status(400).json({
      error: "This clip has no real video file to edit (mock clip or not yet rendered).",
      hint: "AI editing needs a processed clip file — run a real batch through OpenShorts first.",
    });
    return;
  }
  const currentPath = resolveClipFileForVideo(video);
  if (!currentPath) {
    res.status(410).json({ error: "Clip file is no longer available on disk — it may have been cleaned up." });
    return;
  }
  const duration = probeClipDurationSeconds(currentPath);
  if (!duration || duration <= 0) {
    res.status(422).json({ error: "Could not read the clip's duration — the file may be corrupt." });
    return;
  }
  const freeMB = await getFreeDiskMB();
  if (Number.isFinite(freeMB) && freeMB < 300) {
    res.status(507).json({ error: `Insufficient disk space to render an edit (${freeMB}MB free).` });
    return;
  }

  // 1) Regex fast-paths (no LLM); 2) Claude for everything else.
  let editSpec: { trim?: { start: number; end: number }; cuts?: Array<[number, number]> } | null = null;
  let description = instruction;
  const fast = parseAiEditInstruction(instruction, duration);
  if (fast) {
    editSpec = { trim: { start: fast.start, end: fast.end } };
    description = fast.description;
  } else {
    const parsed = await parseAiEditWithClaude(instruction, duration);
    if (parsed) {
      editSpec =
        parsed.action === "cut_middle"
          ? { cuts: [[parsed.start, parsed.end]] }
          : { trim: { start: parsed.start, end: parsed.end } };
      description = parsed.description;
    }
  }
  if (!editSpec) {
    res.status(422).json({
      error:
        "Couldn't turn that instruction into a concrete cut. Try phrasing it with times, e.g. " +
        `"remove the first 8 seconds", "keep only the first 45 seconds", or "cut the section from 0:30 to 0:40".`,
    });
    return;
  }

  // Validate against the clip's real bounds; refuse no-ops and sub-3s results.
  const clamp = (v: number) => Math.min(Math.max(v, 0), duration);
  if (editSpec.trim) {
    editSpec.trim.start = clamp(editSpec.trim.start);
    editSpec.trim.end = clamp(editSpec.trim.end);
    if (editSpec.trim.end - editSpec.trim.start < 3) {
      res.status(400).json({ error: "That edit would leave less than 3 seconds of video." });
      return;
    }
    if (editSpec.trim.start === 0 && Math.abs(editSpec.trim.end - duration) < 0.05) {
      res.status(422).json({ error: "That instruction doesn't change the clip (it keeps the full length)." });
      return;
    }
  }
  if (editSpec.cuts) {
    editSpec.cuts = editSpec.cuts.map(([a, b]) => [clamp(a), clamp(b)] as [number, number]);
    const removed = editSpec.cuts.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
    if (removed < 0.2) {
      res.status(422).json({ error: "That instruction doesn't remove anything from the clip." });
      return;
    }
    if (duration - removed < 3) {
      res.status(400).json({ error: "That edit would leave less than 3 seconds of video." });
      return;
    }
  }

  try {
    const result = await editClipViaOpenShorts({ clipPath: currentPath, editSpec });
    if (!result.newClipPath) throw new Error("Edit did not return a new file path");
    updateContentVideoFilePath(clipId, result.newClipPath);
    if (path.resolve(result.newClipPath) !== path.resolve(currentPath)) {
      saveClipVersionKeepingOne(clipId, currentPath);
    }
    appendContentVideoEditHistory(clipId, {
      instruction,
      description,
      appliedAt: new Date().toISOString(),
      durationBefore: duration,
      durationAfter: result.newDuration || null,
    });
    console.log(`[ai-edit] Clip ${clipId}: ${description} (${duration.toFixed(1)}s → ${result.newDuration}s)`);
    res.json({
      ok: true,
      description,
      new_duration_seconds: result.newDuration,
      videoUrl: `/api/content/clip/${clipId}/video?v=${Date.now()}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai-edit] Clip ${clipId} edit failed: ${message}`);
    res.status(502).json({ error: message, hint: "The original clip is untouched. Check that the OpenShorts sidecar is running." });
  }
});

/* ── Export a clip as a CapCut draft project ──────────────────────────────
   Assembles the clip + its caption lines into a CapCut draft via the local
   CapCutAPI sidecar (port 9001) and streams back a ZIP. The user extracts it
   into their CapCut drafts folder and CapCut opens it as a normal project —
   CapCut itself renders the final export. Passing the user's drafts-folder
   path (optional) bakes correct absolute asset paths into the draft. */

function linesToSrt(lines: Array<{ start: number; end: number; text: string }>): string {
  const ts = (sec: number) => {
    const ms = Math.max(0, Math.round(sec * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
  };
  return lines
    .map((ln, i) => `${i + 1}\n${ts(ln.start)} --> ${ts(ln.end)}\n${ln.text}\n`)
    .join("\n");
}

app.post("/api/content/clip/:clipId/export-capcut", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const clipId = String(req.params.clipId || "");
  const video = getContentVideo(clipId);
  if (!video) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }
  const storedPath = video.filePath || "";
  if (!storedPath || storedPath.startsWith("mock://")) {
    res.status(400).json({ error: "This clip has no real video file to export (mock clip or not yet rendered)." });
    return;
  }
  const clipPath = resolveClipFileForVideo(video);
  if (!clipPath) {
    res.status(410).json({ error: "Clip file is no longer available on disk." });
    return;
  }
  const draftFolder =
    typeof (req.body as { draft_folder?: unknown })?.draft_folder === "string"
      ? String((req.body as { draft_folder: string }).draft_folder).trim()
      : "";

  const CAPCUT_BASE = process.env.CAPCUTAPI_URL || "http://127.0.0.1:9001";
  const CAPCUT_DIR = process.env.CAPCUTAPI_DIR || "/app/services/capcutapi";
  // The CapCut service downloads the clip over HTTP from this same app.
  const selfPort = process.env.PORT || "3000";
  const tokenQs = process.env.DASHBOARD_TOKEN ? `?token=${encodeURIComponent(process.env.DASHBOARD_TOKEN)}` : "";
  const videoUrl = `http://127.0.0.1:${selfPort}/api/content/clip/${clipId}/video${tokenQs}`;

  // Caption lines (same sibling convention as the caption editor).
  const dir = path.dirname(clipPath);
  let stem = path.basename(clipPath).replace(/\.[^.]+$/, "");
  stem = stem.replace(/_(edit|trim)_[0-9a-f]+$/, "").replace(/_(captioned|vertical)$/, "");
  const linesPath = path.join(dir, `${stem}_base.lines.json`);
  let captionLines: Array<{ start: number; end: number; text: string }> = [];
  try {
    if (fs.existsSync(linesPath)) {
      const parsed = JSON.parse(fs.readFileSync(linesPath, "utf8"));
      if (Array.isArray(parsed)) captionLines = parsed;
    }
  } catch {
    /* captions optional — export the video alone */
  }

  const call = async (endpoint: string, body: Record<string, unknown>, timeout = 60000) => {
    const r = await axios.post(`${CAPCUT_BASE}/${endpoint}`, body, { timeout });
    if (!r.data?.success) throw new Error(r.data?.error || `${endpoint} failed`);
    return r.data.output;
  };

  let draftId = "";
  try {
    const created = await call("create_draft", { width: 1080, height: 1920 });
    draftId = String(created?.draft_id || "");
    if (!draftId) throw new Error("create_draft returned no draft_id");

    await call("add_video", { video_url: videoUrl, draft_id: draftId, width: 1080, height: 1920 }, 120000);

    if (captionLines.length) {
      // Upstream bug: /add_subtitle crashes when `font` is omitted — always send one.
      await call("add_subtitle", {
        srt: linesToSrt(captionLines),
        draft_id: draftId,
        font: "HarmonyOS_Sans_SC_Bold",
        bold: true,
        font_size: 8,
        font_color: "#FFFFFF",
        border_width: 20,
        border_color: "#000000",
        transform_y: -0.7,
      }, 60000);
    }

    // Synchronous: returns after assets are downloaded into the draft folder.
    await call("save_draft", draftFolder ? { draft_id: draftId, draft_folder: draftFolder } : { draft_id: draftId }, 300000);

    const draftDir = path.join(CAPCUT_DIR, draftId);
    if (!fs.existsSync(path.join(draftDir, "draft_info.json"))) {
      throw new Error("Draft folder was not materialized (check the capcutapi service log)");
    }

    const zipBase = path.join(os.tmpdir(), `${draftId}`);
    execFileSync("python3", [
      "-c",
      "import shutil, sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2], sys.argv[3])",
      zipBase,
      CAPCUT_DIR,
      draftId,
    ], { timeout: 120000 });
    const zipPath = `${zipBase}.zip`;

    res.download(zipPath, `capcut-draft-${clipId.slice(0, 8)}.zip`, () => {
      // Cleanup both the zip and the draft folder after the response finishes.
      try { fs.unlinkSync(zipPath); } catch { /* best-effort */ }
      try { fs.rmSync(path.join(CAPCUT_DIR, draftId), { recursive: true, force: true }); } catch { /* best-effort */ }
    });
  } catch (err) {
    if (draftId) {
      try { fs.rmSync(path.join(CAPCUT_DIR, draftId), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[capcut-export] Clip ${clipId} export failed: ${message}`);
    res.status(502).json({
      error: message,
      hint: "The CapCut export service may be offline or the clip file unreadable. The clip itself is untouched.",
    });
  }
});

// Current line-level captions for the editor to display + edit. Reads the
// persisted _base.lines.json sibling; editable only for clips generated with
// caption-editing support (i.e. that have a persisted base).
app.get("/api/content/clip/:clipId/captions", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const clipId = String(req.params.clipId || "");
  const video = getContentVideo(clipId);
  if (!video) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }
  const clipPath = resolveClipFileForVideo(video);
  if (!clipPath) {
    res.json({ editable: false, captions: [], reason: "Clip file is not available on disk." });
    return;
  }
  const dir = path.dirname(clipPath);
  let stem = path.basename(clipPath).replace(/\.[^.]+$/, "");
  stem = stem.replace(/_(edit|trim)_[0-9a-f]+$/, "").replace(/_(captioned|vertical)$/, "");
  const linesPath = path.join(dir, `${stem}_base.lines.json`);
  try {
    if (fs.existsSync(linesPath)) {
      const parsed = JSON.parse(fs.readFileSync(linesPath, "utf8"));
      res.json({ editable: true, captions: Array.isArray(parsed) ? parsed : [] });
      return;
    }
  } catch (err) {
    console.warn(`[clip-captions] Could not read ${linesPath}: ${(err as Error).message}`);
  }
  res.json({ editable: false, captions: [], reason: "This clip was generated before caption-editing support." });
});

// Revert a clip to its retained prior version (revert-once). Repoints filePath
// to the previous file and discards the unwanted current render.
app.post("/api/content/clip/:clipId/revert", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const clipId = String(req.params.clipId || "");
  const video = getContentVideo(clipId);
  if (!video) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }
  const prior = getLatestClipVersion(clipId);
  if (!prior) {
    res.status(400).json({ error: "No previous version to revert to." });
    return;
  }
  const priorAbs = resolveClipVideoFilePath(prior.filePath) || prior.filePath;
  if (!fs.existsSync(priorAbs)) {
    deleteClipVersion(prior.id); // stale pointer — clean it up
    res.status(410).json({ error: "The previous version file is no longer available on disk." });
    return;
  }
  const currentPath = resolveClipFileForVideo(video);
  updateContentVideoFilePath(clipId, prior.filePath);
  deleteClipVersion(prior.id);
  // Discard the reverted-away render (only if it's a different file).
  if (currentPath && path.resolve(currentPath) !== path.resolve(priorAbs)) {
    deleteClipFile(currentPath);
  }
  res.json({ ok: true, videoUrl: `/api/content/clip/${clipId}/video?v=${Date.now()}` });
});

// Read the real playback duration of a clip file straight from the container
// via ffprobe. Duration is NOT stored in content_videos, so ffprobe (the same
// tool the render pipeline relies on) is the honest source. Returns null on any
// failure so callers degrade gracefully rather than reporting a wrong number.
function probeClipDurationSeconds(filePath: string): number | null {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${JSON.stringify(filePath)}`,
      { encoding: "utf8", timeout: 10000 },
    ).trim();
    const seconds = Number.parseFloat(out);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.round(seconds * 10) / 10; // 0.1s precision — enough for "delete the last two seconds"
  } catch {
    return null;
  }
}

// Build the per-clip context the chat agent reasons over (copy fields + caption
// lines with timings, for locating moments like "around 0:14").
function buildClipEditContext(video: ContentVideo): ClipEditContext {
  let captions: Array<{ start: number; end: number; text: string }> = [];
  let captionsEditable = false;
  const clipPath = resolveClipFileForVideo(video);
  if (clipPath) {
    const dir = path.dirname(clipPath);
    let stem = path.basename(clipPath).replace(/\.[^.]+$/, "");
    stem = stem.replace(/_(edit|trim)_[0-9a-f]+$/, "").replace(/_(captioned|vertical)$/, "");
    const linesPath = path.join(dir, `${stem}_base.lines.json`);
    try {
      if (fs.existsSync(linesPath)) {
        const parsed = JSON.parse(fs.readFileSync(linesPath, "utf8"));
        if (Array.isArray(parsed)) {
          captions = parsed;
          captionsEditable = true;
        }
      }
    } catch {
      /* ignore — non-editable captions */
    }
  }
  return {
    clipId: video.id,
    hook: video.hook || "",
    caption: video.caption || "",
    hashtags: video.hashtags || [],
    score: video.trendAlignmentScore || 0,
    durationSeconds: clipPath ? probeClipDurationSeconds(clipPath) : null,
    hasPreviousVersion: Boolean(getLatestClipVersion(video.id)),
    captions,
    captionsEditable,
  };
}

// Conversational clip editing — one turn. Returns the agent reply, plus a
// structured proposal to confirm (video edits) or the applied copy change.
app.post("/api/content/clip/:clipId/edit-chat", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const clipId = String(req.params.clipId || "");
  const video = getContentVideo(clipId);
  if (!video) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  try {
    const history = listClipChatMessages(clipId, 20);
    const result = await runClipEditChat({ message, history, context: buildClipEditContext(video) });
    insertClipChatMessage(clipId, "user", message);
    insertClipChatMessage(clipId, "assistant", result.reply);
    res.json({
      reply: result.reply,
      proposal: result.proposal, // { summary, spec } | null — UI confirms before /edit
      copyUpdated: result.copyUpdated, // { field, value } | null — already applied
    });
  } catch (err) {
    const message2 = err instanceof Error ? err.message : String(err);
    console.error(`[clip-edit-chat] ${clipId}: ${message2}`);
    res.status(502).json({ error: message2 });
  }
});

app.get("/api/content/clip/:clipId/edit-chat", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const clipId = String(req.params.clipId || "");
  res.json({ messages: listClipChatMessages(clipId, 40) });
});

app.patch("/api/content/clip/:clipId/metadata", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const clipId = String(req.params.clipId || "");
  const video = getContentVideo(clipId);
  if (!video) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }
  const enhancement = getClipEnhancementByVideoId(clipId);
  const body = req.body as Record<string, unknown>;

  const videoPatch: Parameters<typeof updateContentVideo>[1] = {};
  if (typeof body.hook === "string") videoPatch.hook = body.hook;
  if (typeof body.caption === "string") videoPatch.caption = body.caption;
  if (typeof body.title === "string") videoPatch.title = body.title;
  if (Array.isArray(body.hashtags)) {
    videoPatch.hashtags = body.hashtags.map(String);
  }
  if (Array.isArray(body.platform_targets)) {
    videoPatch.platformTargets = body.platform_targets.map(String);
    const first = body.platform_targets[0];
    if (typeof first === "string") {
      videoPatch.platformTarget = first as import("./core/contentDb.js").ContentPlatformTarget;
    }
  }
  updateContentVideo(clipId, videoPatch);

  if (enhancement) {
    updateClipEnhancement(enhancement.id, {
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

  const updated = getContentVideo(clipId);
  const updatedEnhancement = getClipEnhancementByVideoId(clipId);
  res.json({ video: updated, enhancement: updatedEnhancement });
});

function getNextOptimalPostTimeCst(): string {
  const now = new Date();
  const target = new Date(now);
  target.setHours(19, 0, 0, 0);
  if (now >= target) target.setDate(target.getDate() + 1);
  return target.toISOString();
}

app.get("/api/content/publishing-queue", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const limit = Number(req.query.limit) || 50;
  const clips = listPublishingQueue(limit);
  res.json({ clips });
});

app.post("/api/content/clip/:clipId/send-to-publisher", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  try {
    const clipId = String(req.params.clipId || "");
    const video = getContentVideo(clipId);
    if (!video) {
      res.status(404).json({ error: "Clip not found" });
      return;
    }
    if (video.status !== "pending_review" && video.status !== "approved") {
      res.status(400).json({ error: "Clip must be pending_review or approved" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const overrideCompliance = Boolean(body.override_compliance);
    if (video.complianceFlagged && !overrideCompliance) {
      res.status(400).json({
        error: "Clip has compliance flags. Review before sending.",
        flags: video.complianceNotes,
      });
      return;
    }

    const enhancement = getClipEnhancementByVideoId(clipId);
    const scheduledFor =
      typeof body.scheduled_for === "string" && body.scheduled_for.trim()
        ? body.scheduled_for.trim()
        : enhancement?.optimalPostTimeTiktok ?? getNextOptimalPostTimeCst();

    const platforms = Array.isArray(body.platforms)
      ? body.platforms.map(String)
      : enhancement?.platformTargets?.length
        ? enhancement.platformTargets
        : [video.platformTarget];

    const now = new Date().toISOString();
    updateContentVideo(clipId, {
      status: "approved",
      approvedAt: now,
      scheduledFor,
      platformTargets: platforms,
    });
    // Feed the human approval signal back to the Brain (what KIND of clip
    // Marco keeps) — best-effort, never blocks the publish action.
    try {
      recordClipDecision(clipId, "approved");
    } catch (err) {
      console.warn("[send-to-publisher] could not record clip decision:", err);
    }

    const publishEntries: Array<{ platform: string; scheduledFor: string }> = [];
    for (const platform of platforms) {
      insertPublishLog({
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
    ensureDailyTargets(scheduleDate);
    incrementDailyTarget(scheduleDate, "videos_published", 1);

    res.json({
      ok: true,
      clipId,
      status: "approved",
      scheduledFor,
      platforms,
      publishEntries,
    });
  } catch (err) {
    console.error("[send-to-publisher] Error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  }
});

app.get("/api/content/competitor-profiles", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json({ profiles: listAllCompetitorProfiles() });
});

app.post("/api/content/competitor-profiles", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const tiktokHandle =
    typeof req.body?.tiktok_handle === "string" ? req.body.tiktok_handle.trim() : "";
  const displayName =
    typeof req.body?.display_name === "string" ? req.body.display_name.trim() : "";
  const profileType =
    typeof req.body?.profile_type === "string" ? req.body.profile_type.trim() : "";
  if (!tiktokHandle || !displayName || !profileType) {
    res.status(400).json({ error: "tiktok_handle, display_name, and profile_type required" });
    return;
  }
  const profile = insertCompetitorProfile({ tiktokHandle, displayName, profileType });
  res.json({ profile });
});

app.patch("/api/content/competitor-profiles/:id", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "");
  const active = req.body?.active;
  const profile = updateCompetitorProfile(id, {
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
  const a = getLatestYoutubeAnalysis();
  if (!a) {
    res.json({
      analysis: null,
      message:
        "No YouTube analysis yet. It runs automatically on Sunday nights or you can trigger it manually.",
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
  void runYouTubeCompetitorAnalysis(contentManagerBrain).catch((err) => {
    console.error("[youtube-intel] manual run failed:", err);
  });
  res.json({
    ok: true,
    message: "YouTube transcript analysis started. Check back in 2-3 minutes.",
  });
});

// Live progress for the YouTube analysis run (polled by the UI progress bar).
app.get("/api/content/youtube-intel/progress", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json(getYouTubeIntelProgress());
});

app.get("/api/content/youtube-profiles", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json({ profiles: listAllYoutubeProfiles() });
});

app.post("/api/content/youtube-profiles", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const youtubeChannelUrl =
    typeof req.body?.youtube_channel_url === "string" ? req.body.youtube_channel_url.trim() : "";
  const channelName =
    typeof req.body?.channel_name === "string" ? req.body.channel_name.trim() : "";
  const profileType =
    typeof req.body?.profile_type === "string" ? req.body.profile_type.trim() : "competitor";
  if (!youtubeChannelUrl) {
    res.status(400).json({ error: "youtube_channel_url required" });
    return;
  }
  const profile = insertYoutubeProfile({
    youtubeChannelUrl,
    channelName: channelName || undefined,
    profileType,
  });
  res.json({ profile });
});

app.patch("/api/content/youtube-profiles/:id", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "");
  const active = req.body?.active;
  const profile = updateYoutubeProfile(id, {
    active:
      active === 0 || active === false ? false : active === 1 || active === true ? true : undefined,
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
  res.json({ transcripts: listYoutubeTranscripts({ channelName, limit }) });
});

app.get("/api/content/youtube-transcripts/:videoId", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const transcript = getYoutubeTranscript(String(req.params.videoId || ""));
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
  res.json({ pending: listPendingComplianceQueue() });
});

app.get("/api/content/report/daily", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  res.json(getDailyReport(date));
});

app.get("/api/content/report/weekly", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json(getWeeklyReport());
});

app.post("/api/content/sync", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  try {
    const summary = await runPerformanceSync();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Real autonomous-agent (content-brain cycles) status for the Overview page —
// reads the persisted run state, computes the next scheduled cycle, and never
// 500s (falls back to a sane payload).
app.get("/api/content/agent-status", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  try {
    const CYCLE_HOURS = [6, 12, 18, 22]; // America/Chicago cycle times
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    }).formatToParts(now);
    const gp = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    let h = gp("hour");
    if (h === 24) h = 0;
    const curMin = h * 60 + gp("minute");
    const curSec = gp("second");
    const cycleMins = CYCLE_HOURS.map((x) => x * 60);
    const nextMin = cycleMins.find((m) => m > curMin);
    const deltaMin = nextMin == null ? 1440 - curMin + cycleMins[0] : nextMin - curMin;
    const msUntilNext = Math.max(0, deltaMin * 60000 - curSec * 1000);
    const nextRunAt = new Date(now.getTime() + msUntilNext).toISOString();

    const last = getLatestAgentRun();
    let health: "green" | "amber" | "red" = "amber";
    if (last) {
      if (last.status === "failure") {
        health = "red";
      } else {
        const ageMs = now.getTime() - new Date(last.ranAt).getTime();
        health = ageMs <= 26 * 3600 * 1000 ? "green" : "amber";
      }
    }

    res.json({
      lastRunAt: last?.ranAt ?? null,
      lastRunStatus: last?.status ?? null,
      lastRunCycle: last?.cycle ?? null,
      summary: last?.summary ?? null,
      nextRunAt,
      msUntilNext,
      health,
      scheduleHours: CYCLE_HOURS,
    });
  } catch (err) {
    res.json({
      lastRunAt: null,
      lastRunStatus: null,
      summary: null,
      nextRunAt: null,
      msUntilNext: null,
      health: "amber",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get("/api/content-brain/status", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const today = todayDateCst();
  res.json({
    latestBriefing: getLatestBriefing(),
    todayStrategy: getDailyStrategy(today),
    dailyTargets: ensureDailyTargets(today),
    performanceModel: getPerformanceModel(),
  });
});

app.get("/api/content-brain/strategy", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const strategy = getDailyStrategy(todayDateCst());
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
  res.json({ entries: listLearningLogs({ limit: days * 4, days }) });
});

app.get("/api/content-brain/performance-model", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const model = getPerformanceModel();
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
  res.json({ briefings: listBriefings({ briefingType: type, limit }) });
});

app.get("/api/content-brain/benchmark-trajectory", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json(computeBenchmarkTrajectory());
});

app.post("/api/content-brain/ask", express.json(), async (req, res) => {
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
    const { response, sessionId: sid } = await contentManagerBrain.chatWithSession(question, sessionId);
    res.json({ response, sessionId: sid, answer: response, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/content-brain/sessions", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json({ sessions: listActiveChatSessions(10) });
});

app.get("/api/content-brain/sessions/:sessionId/messages", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const sessionId = String(req.params.sessionId || "");
  res.json({ messages: listChatMessages(sessionId) });
});

app.post("/api/content-brain/sessions/new", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json({ sessionId: getOrCreateSession() });
});

// Clear a general Content Manager chat session (deletes its persisted history)
// and hand back a fresh session id. Only affects cm_chat_* — the per-clip edit
// chat (cm_clip_chat) is a separate feature and is untouched.
app.post("/api/content-brain/sessions/:sessionId/clear", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const sessionId = String(req.params.sessionId || "");
  if (sessionId) deleteChatSession(sessionId);
  res.json({ ok: true, sessionId: getOrCreateSession() });
});

app.get("/api/content-brain/self-evaluation", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json({ evaluations: listSelfEvaluations(4) });
});

app.get("/api/content-brain/accuracy", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const rows = listStrategyAccuracy(14).map((r) => ({
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
  res.json({ experiments: listExperiments(50) });
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
    patterns: listCombinationPatterns({ pillar, minSamples, limit, order: "desc" }),
  });
});

app.get("/api/content-brain/momentum", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const model = getPerformanceModel();
  const seasonal = getSeasonalWeek(getCurrentWeekNumber());
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

app.post("/api/content-brain/run-cycle", express.json(), async (req, res) => {
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
    if (cycle === "morning") await contentManagerBrain.runMorningCycle();
    else if (cycle === "midday") await contentManagerBrain.runMiddayCycle();
    else if (cycle === "evening") await contentManagerBrain.runEveningCycle();
    else if (cycle === "monday_recording_plan") {
      const tasks = await generateWeeklyRecordingPlan(getWeekStart(), contentManagerBrain);
      res.json({ ok: true, log: `[cm-brain] Recording plan: ${tasks.length} tasks created`, tasks });
      return;
    } else await contentManagerBrain.runNightCycle();
    res.json({ ok: true, log: `[cm-brain] ${cycle} cycle completed manually` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/content-brain/cut-list", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json({ items: listCutList(true) });
});

app.get("/api/content-brain/hook-library", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const minUses = Number(req.query.min_uses) || 3;
  const limit = Number(req.query.limit) || 20;
  res.json({ hooks: listHookLibrary({ minUses, limit, order: "desc" }) });
});

app.get("/api/content/competitive-analysis/latest", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const analysis = getLatestAnalysis();
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
    recommendations: getActiveStrategyRecommendations(),
  });
});

app.post("/api/content/competitive-analysis/run", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  runFullCompetitiveAnalysis(contentManagerBrain)
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
    ? listStrategyRecommendations({ status, limit })
    : getActiveStrategyRecommendations().slice(0, limit);
  res.json({ recommendations });
});

app.patch("/api/content/strategy-recommendations/:id", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "");
  const body = req.body as Record<string, unknown>;
  const updated = updateStrategyRecommendation(id, {
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
  const rec = getStrategyRecommendationById(id);
  if (!rec) {
    res.status(404).json({ error: "Recommendation not found" });
    return;
  }
  try {
    const task = await generateRecordingTask(rec, contentManagerBrain);
    res.json({ task });
  } catch (err) {
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
  const today = todayDateCst();
  const end = new Date(`${today}T12:00:00`);
  end.setDate(end.getDate() + days);
  const endStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(end);
  const tasks = listRecordingTasks({
    status,
    dueAfter: today,
    dueBefore: endStr,
    limit: 100,
  });
  res.json({ tasks });
});

// Generate (or regenerate) a fresh recording plan for a single day. Hitting
// this again replaces the prior daily plan with a genuinely different one.
app.post("/api/content/recording-tasks/generate-day", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const dateStr = typeof body.date === "string" && body.date ? body.date : todayDateCst();
  try {
    const tasks = await generateDailyRecordingPlan(dateStr, contentManagerBrain);
    res.json({ tasks, date: dateStr });
  } catch (err) {
    console.error("[content] daily recording plan failed", err);
    res.status(500).json({ error: "Failed to generate daily plan" });
  }
});

app.post("/api/content/recording-tasks", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const hooks = Array.isArray(body.suggested_hooks) ? body.suggested_hooks.map(String) : [];
  const task = insertRecordingTask({
    dueDate: String(body.due_date || todayDateCst()),
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

app.patch("/api/content/recording-tasks/:id", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "");
  const body = req.body as Record<string, unknown>;
  const status = body.status ? String(body.status) : undefined;
  if (status === "filmed" || status === "uploaded") {
    markRecordingTaskFiled(
      id,
      body.upload_batch_session_id ? String(body.upload_batch_session_id) : undefined,
    );
    res.json({ ok: true });
    return;
  }
  const updated = updateRecordingTask(id, { status });
  if (!updated) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json({ task: updated });
});

// Google Drive auto-pull status for the Upload & Clip page indicator.
app.get("/api/content/drive/status", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json(getDriveStatus());
});

// Manual "poll now" trigger (used for the setup test — the scheduler still runs
// every 30 min on its own). Fire-and-forget so the request returns immediately.
app.post("/api/content/drive/poll", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  if (!driveConfigured()) {
    res.status(400).json({ error: "Google Drive not connected — set the GOOGLE_DRIVE_CREDENTIALS secret." });
    return;
  }
  // Manual "poll now" forces a single pull (bypasses the once-a-day throttle) so
  // setup/testing doesn't have to wait for the daily slot. Still only ONE file
  // (the oldest unprocessed), never re-processing anything already done.
  void pollGoogleDrive({ force: true }).catch((err) => console.error("[drive-pull] manual poll failed:", err));
  res.json({ ok: true, message: "Pulling the oldest unprocessed video now — it'll appear in the Review Queue shortly." });
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
  res.json(getCalendarDayData(date));
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
  res.json(getCalendarMonthData(year, month));
});

app.get("/api/content/sprint-progress", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json(getSprintProgress());
});

/**
 * Per-lead engagement metrics for the CRM lead table's Sort By and Columns.
 *
 * These live in four different subsystems (lead scores, favourites, listing
 * alerts / market reports and their send log), none of which belong in the
 * dashboard snapshot — so they are served here as one map the table joins on
 * by lead id, loaded only when a sort or column actually needs them.
 *
 * `unavailable` is the honest half. Brivity's table also sorts on IDX website
 * behaviour — visits, page views, average viewed price, last visit, mobile app
 * adoption, CMA status — and this system has no site-visit tracking connected,
 * so those fields have NO data to sort on. They are named here with the reason
 * rather than offered as controls that would silently order every row the same.
 */
/**
 * The CRM's shared vocabulary: pipeline stages and appointment types.
 *
 * Served rather than hard-coded in the page for one reason. This repo has
 * already been bitten once by two copies of the same list drifting apart —
 * `TASK_TYPES` in server.ts against `TYPES` in core/tasks.ts, where a type in
 * only one silently became "other" somewhere between the API and the write.
 * Stages carry the same hazard and a worse consequence: a lead's stage is what
 * the pipeline counts run on.
 *
 * The page keeps a baked-in copy purely as a first-paint fallback, and this is
 * what it corrects itself to.
 */
app.get("/api/crm/vocabulary", (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json({
    ok: true,
    stageGroups: CRM_STAGE_GROUPS,
    stages: CRM_STAGES,
    /* Old values still stored on rows, and what each displays as. Nothing
       rewrites them — a stored value must never become unreadable. */
    stageLegacy: CRM_STAGE_LEGACY,
    appointmentTypeGroups: APPOINTMENT_TYPE_GROUPS,
    appointmentOutcomes: [
      { value: "none", label: "No outcome yet" },
      { value: "held", label: "Held" },
      { value: "no_show", label: "No Show" },
      { value: "rescheduled", label: "Rescheduled" },
    ],
    /* The managed lists. Seeded from the Brivity export so a source that exists
       in the account being migrated from can be picked here on day one, rather
       than only appearing once someone has typed it onto a contact. */
    sources: listVocabulary("source"),
    tags: listVocabulary("tag"),
    vocabularyStats: vocabularyStats(),
  });
});

/** Add a custom source or tag to the managed list. */
app.post("/api/crm/vocabulary/:kind", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const kind = req.params.kind === "sources" ? "source" : req.params.kind === "tags" ? "tag" : null;
  if (!kind) { res.status(400).json({ error: "kind must be sources or tags" }); return; }
  const name = String((req.body || {}).name || "").trim();
  if (!name) { res.status(400).json({ error: "A name is required" }); return; }
  if (name.length > 80) { res.status(400).json({ error: "Keep it under 80 characters" }); return; }
  const added = addVocabulary(kind, name, sessionUserSync(req)?.email || undefined);
  if (!added) { res.status(409).json({ error: `"${name}" is already on the list` }); return; }
  res.json({ ok: true, name: added, list: listVocabulary(kind) });
});

/** Remove a custom source or tag. Seeded entries are refused, with the reason. */
app.delete("/api/crm/vocabulary/:kind/:name", (req, res) => {
  if (!dashboardTokenOk(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  const kind = req.params.kind === "sources" ? "source" : req.params.kind === "tags" ? "tag" : null;
  if (!kind) { res.status(400).json({ error: "kind must be sources or tags" }); return; }
  const name = decodeURIComponent(req.params.name || "");
  if (!removeVocabulary(kind, name)) {
    res.status(400).json({
      error: `"${name}" came from the Brivity import and cannot be removed — ` +
        `contacts still carry it, and deleting it here would not change theirs.`,
    });
    return;
  }
  res.json({ ok: true, list: listVocabulary(kind) });
});

app.get("/api/crm/lead-metrics", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const metrics: Record<string, Record<string, unknown>> = {};
  const touch = (id: string) => (metrics[id] = metrics[id] || {});

  try {
    const { getLatestScoresForAllLeads } = await import("./core/leadScoreStore.js");
    for (const [leadId, entry] of getLatestScoresForAllLeads()) {
      const row = touch(leadId);
      row.hotScore = entry.score;
      row.hotTier = entry.tier;
    }
  } catch (err) {
    console.warn("[lead-metrics] scores unavailable:", err);
  }

  try {
    const { favoriteSummaryByLead } = await import("./core/favoritesStore.js");
    for (const [leadId, f] of favoriteSummaryByLead()) {
      const row = touch(leadId);
      row.favorites = f.favorites;
      row.avgFavPrice = f.avgFavPrice;
    }
  } catch (err) {
    console.warn("[lead-metrics] favourites unavailable:", err);
  }

  try {
    const { outreachSummaryByLead } = await import("./core/outreachStore.js");
    for (const [leadId, o] of outreachSummaryByLead()) {
      const row = touch(leadId);
      row.listingAlerts = o.listingAlerts;
      row.marketReports = o.marketReports;
      row.lastSentAt = o.lastSentAt;
      row.lastOpenedAlertAt = o.lastOpenedAlertAt;
      row.lastOpenedReportAt = o.lastOpenedReportAt;
    }
  } catch (err) {
    console.warn("[lead-metrics] outreach unavailable:", err);
  }

  /* ── the facts the Filter Leads panel runs on ─────────────────────────
     All of these are per-lead and all come from stores this system already
     writes. They ride along with the metrics rather than becoming six more
     endpoints: the filter panel needs every one of them at once, and six
     round trips would show the operator a panel that fills in piecemeal. */

  try {
    const cma = await import("./core/cmaStore.js");
    for (const sess of cma.listSessions({ limit: 500 })) {
      if (!sess.leadId) continue;
      const row = touch(sess.leadId);
      row.cmaCount = Number(row.cmaCount || 0) + 1;
      if (sess.status === "published") row.cmaPublished = Number(row.cmaPublished || 0) + 1;
    }
  } catch (err) {
    console.warn("[lead-metrics] CMAs unavailable:", err);
  }

  try {
    const outreach = await import("./core/outreachStore.js");
    /* "Last Market Report View" is the client OPENING the report page, which
       this system measures itself with its own view counter — not an email
       open, which Gmail does not report. */
    for (const r of outreach.listReports()) {
      if (!r.lastViewedAt) continue;
      const row = touch(r.leadId);
      const cur = (row.lastReportViewAt as string) || null;
      if (!cur || r.lastViewedAt > cur) row.lastReportViewAt = r.lastViewedAt;
    }
  } catch (err) {
    console.warn("[lead-metrics] report views unavailable:", err);
  }

  try {
    const cr = await import("./core/contactRecordStore.js");
    const snap = await getDashboardSnapshot();
    for (const lead of snap.leads) {
      const phones = cr.listPhones(lead.id);
      const agreements = cr.listAgreements(lead.id);
      const team = cr.listAssignments(lead.id);
      if (!phones.length && !agreements.length && !team.length) continue;
      const row = touch(lead.id);
      if (phones.length) {
        /* DNC is a legal flag a human set on a row. It is never inferred, and
           a number nobody has checked is "not marked", not "cleared to call". */
        row.phoneCount = phones.length;
        row.phoneDnc = phones.some((p) => p.dnc);
        row.phoneAllDnc = phones.every((p) => p.dnc);
      }
      if (agreements.length) {
        row.agreementTypes = Array.from(new Set(agreements.map((a) => a.kind)));
        /* Active vs expired is derived from the agreement's OWN dates, not from
           a status column it does not have: expired means an expiration date
           that has passed. Anything else stays "active" only if the row says so. */
        const today = new Date().toISOString().slice(0, 10);
        row.agreementStatuses = Array.from(
          new Set(
            agreements.map((a) =>
              !a.isActive ? "inactive" : a.expirationDate && a.expirationDate < today ? "expired" : "active",
            ),
          ),
        );
      }
      if (team.length) row.collaborators = team.map((t) => t.userId);
    }
  } catch (err) {
    console.warn("[lead-metrics] contact record facets unavailable:", err);
  }

  try {
    const { getTasks } = await import("./core/tasks.js");
    const now = Date.now();
    for (const t of getTasks()) {
      if (!t.leadId || t.type !== "appointment") continue;
      const row = touch(t.leadId);
      const st = (row.appointmentStatuses as string[]) || [];
      const status = t.appointmentStatus || "scheduled";
      if (st.indexOf(status) < 0) st.push(status);
      row.appointmentStatuses = st;
      if (t.appointmentType) {
        const ty = (row.appointmentTypes as string[]) || [];
        if (ty.indexOf(t.appointmentType) < 0) ty.push(t.appointmentType);
        row.appointmentTypes = ty;
      }
      /* Only a recorded outcome counts. An appointment nobody has closed out
         has no outcome, which is different from "none" meaning it went
         nowhere — so the absent case simply does not appear. */
      if (t.outcome) {
        const oc = (row.appointmentOutcomes as string[]) || [];
        if (oc.indexOf(t.outcome) < 0) oc.push(t.outcome);
        row.appointmentOutcomes = oc;
      }
      const due = t.dueDate ? Date.parse(t.dueDate) : NaN;
      if (Number.isFinite(due)) {
        row.appointmentCount = Number(row.appointmentCount || 0) + 1;
        if (due >= now) {
          const cur = (row.nextAppointmentAt as string) || null;
          if (!cur || t.dueDate! < cur) row.nextAppointmentAt = t.dueDate;
        } else {
          const cur = (row.lastAppointmentAt as string) || null;
          if (!cur || t.dueDate! > cur) row.lastAppointmentAt = t.dueDate;
        }
      }
    }
  } catch (err) {
    console.warn("[lead-metrics] appointments unavailable:", err);
  }

  try {
    const sms = await import("./core/smsStore.js");
    const db = sms.getSmsDb();
    for (const r of db
      .prepare(`SELECT lead_id, direction, COUNT(*) n FROM sms_threads GROUP BY lead_id, direction`)
      .all() as Array<{ lead_id: string; direction: string; n: number }>) {
      if (!r.lead_id) continue;
      const row = touch(String(r.lead_id));
      if (String(r.direction) === "outbound") row.textsSent = Number(r.n) || 0;
      else row.textsReceived = Number(r.n) || 0;
    }
  } catch (err) {
    console.warn("[lead-metrics] SMS counts unavailable:", err);
  }

  res.json({
    metrics,
    count: Object.keys(metrics).length,
    unavailable: [
      { field: "homeApp", label: "Home App", reason: "There is no client mobile app, so there is no adoption to report." },
      { field: "lastVisit", label: "Last Visit", reason: "No website visit tracking is connected." },
      { field: "visits", label: "Visits", reason: "No website visit tracking is connected." },
      { field: "views", label: "Views", reason: "No website visit tracking is connected." },
      { field: "avgViewPrice", label: "Avg. View Price", reason: "Needs viewed-listing history, which the site does not send." },
      { field: "lastViewed", label: "Last Viewed", reason: "Needs viewed-listing history, which the site does not send." },
      /* The CMA entry that used to sit here is gone — CMAs are real now and
         `cmaCount` above is a live number. */
      { field: "phoneLineType", label: "Landline / VoIP / mobile",
        reason: "Detecting a line type needs a carrier lookup (Twilio Lookup line-type intelligence), which is a paid per-number API and is not enabled on this account. Nothing here guesses it from the area code." },
      { field: "dncRegistry", label: "National DNC registry",
        reason: "The DNC flag on a phone row is set by a human and is trusted as such. This system does not subscribe to the federal registry, so an unmarked number means 'nobody has checked', not 'cleared to call'." },
    ],
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   CONTENT PLANNER — the editorial calendar at /content-planner.
   Distinct from /api/content/calendar/* above, which reports on clips that
   already exist. These routes own INTENT: planned items, the unscheduled
   backlog, who owns each one, and what timezone the times mean.
   ═══════════════════════════════════════════════════════════════════════ */

/** Roster + palette + platform list + settings: everything the page boots from. */
app.get("/api/planner/bootstrap", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const planner = await import("./core/contentPlanner.js");
  const tax = await import("./core/plannerTaxonomy.js");
  const settings = planner.getSettings();
  res.json({
    settings,
    team: tax.listMembers(),
    hiddenMembers: tax.hiddenMembers(),
    categories: tax.listCategories(),
    platforms: tax.listPlatforms(),
    palette: tax.paletteWithText(),
    backlogStatuses: planner.BACKLOG_STATUSES.map((s) => ({ id: s, label: planner.BACKLOG_STATUS_LABELS[s] })),
    counts: planner.plannerCounts(),
    /**
     * Reference clocks only. These never touch a card's date: the Philippines
     * clock is fixed because that is the half of the team it exists for, and
     * the US one is swappable purely so whoever is looking sees their own.
     */
    clocks: {
      phtTz: "Asia/Manila",
      usTz: settings.usClockTz,
      usOptions: ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"],
    },
  });
});

/** The three editable vocabularies, on their own so the drawer can refresh alone. */
app.get("/api/planner/taxonomy", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const tax = await import("./core/plannerTaxonomy.js");
  res.json({
    categories: tax.listCategories(),
    platforms: tax.listPlatforms(),
    team: tax.listMembers(),
    hiddenMembers: tax.hiddenMembers(),
    palette: tax.paletteWithText(),
  });
});

app.get("/api/planner/items", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const planner = await import("./core/contentPlanner.js");
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
    return;
  }
  res.json({
    from,
    to,
    settings: planner.getSettings(),
    items: planner.scheduledBetween(from, to),
    counts: planner.plannerCounts(),
  });
});

app.get("/api/planner/backlog", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const planner = await import("./core/contentPlanner.js");
  const items = planner.backlogItems();
  const columns = planner.BACKLOG_STATUSES.map((status) => ({
    id: status,
    label: planner.BACKLOG_STATUS_LABELS[status],
    items: items.filter((i) => i.backlogStatus === status),
  }));
  res.json({ count: items.length, items, columns });
});

app.post("/api/planner/items", express.json({ limit: "256kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const planner = await import("./core/contentPlanner.js");
  const body = (req.body || {}) as Record<string, unknown>;
  const title = String(body.title || "").trim();
  if (!title) {
    res.status(400).json({ error: "A title is required" });
    return;
  }
  const cat = await resolvePlannerCategory(body.categoryId);
  const { item } = planner.createItem({
    title,
    hook: typeof body.hook === "string" ? body.hook : "",
    caption: typeof body.caption === "string" ? body.caption : "",
    script: typeof body.script === "string" ? body.script : "",
    color: cat ? cat.colorHex : typeof body.color === "string" ? body.color : undefined,
    categoryId: cat ? cat.id : null,
    platforms: Array.isArray(body.platforms) ? (body.platforms as string[]) : [],
    assignedUsers: Array.isArray(body.assignedUsers) ? (body.assignedUsers as Array<{ userId: string; role: string }>) : [],
    assetDriveUrl: typeof body.assetDriveUrl === "string" ? body.assetDriveUrl : null,
    date: typeof body.date === "string" ? body.date : null,
    time: typeof body.time === "string" ? body.time : null,
    authoredTz: typeof body.authoredTz === "string" ? body.authoredTz : undefined,
    backlogStatus: typeof body.backlogStatus === "string" ? (body.backlogStatus as never) : undefined,
    notes: typeof body.notes === "string" ? body.notes : "",
    createdBy: typeof body.actor === "string" ? body.actor : null,
  });
  await notifyPlannerAssignees(item.assignedUsers.map((a) => a.userId), item.title, item.id, typeof body.actor === "string" ? body.actor : "");
  res.json({ ok: true, item: planner.viewItem(item) });
});

app.patch("/api/planner/items/:id", express.json({ limit: "256kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const planner = await import("./core/contentPlanner.js");
  const before = planner.getItem(String(req.params.id));
  if (!before) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  const body = (req.body || {}) as Record<string, unknown>;
  // A category carries its colour: setting one must repaint the card, or the
  // grid and the taxonomy drawer disagree about what colour that category is.
  const cat = body.categoryId === undefined ? null : await resolvePlannerCategory(body.categoryId);
  const result = planner.updateItem(String(req.params.id), {
    title: typeof body.title === "string" ? body.title : undefined,
    hook: typeof body.hook === "string" ? body.hook : undefined,
    caption: typeof body.caption === "string" ? body.caption : undefined,
    script: typeof body.script === "string" ? body.script : undefined,
    color: cat ? cat.colorHex : typeof body.color === "string" ? body.color : undefined,
    categoryId: body.categoryId === undefined ? undefined : cat ? cat.id : null,
    platforms: Array.isArray(body.platforms) ? (body.platforms as string[]) : undefined,
    assignedUsers: Array.isArray(body.assignedUsers)
      ? (body.assignedUsers as Array<{ userId: string; role: string }>)
      : undefined,
    assetDriveUrl: body.assetDriveUrl === undefined ? undefined : (body.assetDriveUrl as string | null),
    isCompleted: typeof body.isCompleted === "boolean" ? body.isCompleted : undefined,
    backlogStatus: typeof body.backlogStatus === "string" ? (body.backlogStatus as never) : undefined,
    sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : undefined,
    notes: typeof body.notes === "string" ? body.notes : undefined,
    date: body.date === undefined ? undefined : (body.date as string | null),
    time: typeof body.time === "string" ? body.time : undefined,
    authoredTz: typeof body.authoredTz === "string" ? body.authoredTz : undefined,
    actor: typeof body.actor === "string" ? body.actor : undefined,
  });
  if (!result) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  const priorIds = before.assignedUsers.map((a) => a.userId);
  const newlyAssigned = result.item.assignedUsers.map((a) => a.userId).filter((u) => !priorIds.includes(u));
  await notifyPlannerAssignees(newlyAssigned, result.item.title, result.item.id, typeof body.actor === "string" ? body.actor : "");
  res.json({ ok: true, item: planner.viewItem(result.item) });
});

/**
 * Delete a content item, and say plainly what happens to its tasks.
 *
 * `tasks=keep` (the default) leaves them on the Task Command board, unlinked —
 * work somebody may already have started does not evaporate because the post it
 * came from was cancelled. `tasks=delete` removes them too. The caller must
 * choose; nothing is guessed.
 */
app.delete("/api/planner/items/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const planner = await import("./core/contentPlanner.js");
  const id = String(req.params.id);
  const mode = String(req.query.tasks || "keep") === "delete" ? "delete" : "keep";
  const linked = getCommandTasks().filter((t) => t.contentSlotId === id);
  let tasksDeleted = 0;
  let tasksKept = 0;
  for (const t of linked) {
    if (mode === "delete") {
      if (deleteCommandTask(t.id)) tasksDeleted++;
    } else {
      // Unlink rather than leave a dangling reference to a card that is gone.
      updateCommandTask(t.id, { contentSlotId: undefined });
      tasksKept++;
    }
  }
  const ok = planner.deleteItem(id, String(req.query.actor || "system"));
  res.status(ok ? 200 : 404).json(ok ? { ok: true, tasksDeleted, tasksKept } : { error: "No such item" });
});

/* ── Notebook: long-form notes living in the scratchpad ── */

app.get("/api/planner/notes", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const notes = await import("./core/plannerNotes.js");
  res.json({ notes: notes.listNotes() });
});

app.post("/api/planner/notes", express.json({ limit: "2mb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const notes = await import("./core/plannerNotes.js");
  const body = (req.body || {}) as Record<string, unknown>;
  const note = notes.createNote({
    title: typeof body.title === "string" ? body.title : undefined,
    contentHtml: typeof body.contentHtml === "string" ? body.contentHtml : undefined,
  });
  res.json({ ok: true, note, notes: notes.listNotes() });
});

app.patch("/api/planner/notes/:id", express.json({ limit: "2mb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const notes = await import("./core/plannerNotes.js");
  const body = (req.body || {}) as Record<string, unknown>;
  const note = notes.updateNote(String(req.params.id), {
    title: typeof body.title === "string" ? body.title : undefined,
    contentHtml: typeof body.contentHtml === "string" ? body.contentHtml : undefined,
    isPinned: typeof body.isPinned === "boolean" ? body.isPinned : undefined,
  });
  if (!note) {
    res.status(404).json({ error: "No such note" });
    return;
  }
  res.json({ ok: true, note });
});

app.delete("/api/planner/notes/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const notes = await import("./core/plannerNotes.js");
  const ok = notes.deleteNote(String(req.params.id));
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "No such note" });
});

/**
 * What a drop WOULD do. The Domino preview overlay calls this on hover so the
 * operator sees the ripple before committing to it — nothing is written.
 */
app.post("/api/planner/reschedule/preview", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const planner = await import("./core/contentPlanner.js");
  const body = (req.body || {}) as Record<string, unknown>;
  const plan = planner.planReschedule({
    itemId: String(body.itemId || ""),
    toDate: String(body.toDate || ""),
    time: typeof body.time === "string" ? body.time : null,
    mode: body.mode === "DIRECT" ? "DIRECT" : body.mode === "DOMINO" ? "DOMINO" : undefined,
  });
  if (!plan) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  res.json({ ok: true, plan });
});

app.post("/api/planner/reschedule", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const planner = await import("./core/contentPlanner.js");
  const body = (req.body || {}) as Record<string, unknown>;
  const toDate = String(body.toDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    res.status(400).json({ error: "toDate must be YYYY-MM-DD" });
    return;
  }
  const plan = planner.planReschedule({
    itemId: String(body.itemId || ""),
    toDate,
    time: typeof body.time === "string" ? body.time : null,
    mode: body.mode === "DIRECT" ? "DIRECT" : body.mode === "DOMINO" ? "DOMINO" : undefined,
  });
  if (!plan) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  const updated = planner.applyReschedule(plan, String(body.actor || "system"));
  res.json({ ok: true, plan, updated, counts: planner.plannerCounts() });
});

/** Reverse drag: a scheduled card goes back to the scratchpad, keeping its content. */
app.post("/api/planner/items/:id/unschedule", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const planner = await import("./core/contentPlanner.js");
  const body = (req.body || {}) as Record<string, unknown>;
  const result = planner.updateItem(String(req.params.id), {
    date: null,
    backlogStatus: typeof body.backlogStatus === "string" ? (body.backlogStatus as never) : undefined,
    actor: typeof body.actor === "string" ? body.actor : undefined,
  });
  if (!result) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  res.json({ ok: true, item: planner.viewItem(result.item) });
});

app.get("/api/planner/settings", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const planner = await import("./core/contentPlanner.js");
  res.json(planner.getSettings());
});

app.put("/api/planner/settings", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const planner = await import("./core/contentPlanner.js");
  const { isValidTimeZone } = await import("./core/zonedTime.js");
  const body = (req.body || {}) as Record<string, unknown>;
  for (const key of ["authoringTz", "usClockTz"]) {
    const v = body[key];
    if (v !== undefined && (typeof v !== "string" || !isValidTimeZone(v))) {
      res.status(400).json({ error: `${key} must be a valid IANA timezone (e.g. America/Chicago)` });
      return;
    }
  }
  if (body.weekStart !== undefined && body.weekStart !== "SUNDAY" && body.weekStart !== "MONDAY") {
    res.status(400).json({ error: "weekStart must be SUNDAY or MONDAY" });
    return;
  }
  const settings = planner.saveSettings({
    authoringTz: typeof body.authoringTz === "string" ? body.authoringTz : undefined,
    usClockTz: typeof body.usClockTz === "string" ? body.usClockTz : undefined,
    weekStart: body.weekStart === "SUNDAY" || body.weekStart === "MONDAY" ? body.weekStart : undefined,
    dragMode: body.dragMode === "DOMINO" || body.dragMode === "DIRECT" ? body.dragMode : undefined,
  });
  res.json({ ok: true, settings });
});

/* ── master taxonomy: categories, platforms, team members ──────────────────
   Every delete here goes through the same contract: content that references
   the thing being removed must be told where to go, or the request is refused
   with the count so the UI can ask. Nothing is orphaned quietly. */

/** Categories and platforms are looked up by id; a bad id is a 400, not a guess. */
async function resolvePlannerCategory(raw: unknown): Promise<{ id: string; colorHex: string } | null> {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const tax = await import("./core/plannerTaxonomy.js");
  const cat = tax.getCategory(raw.trim());
  return cat ? { id: cat.id, colorHex: cat.colorHex } : null;
}

/** Turn a TaxonomyError into its own status; anything else is a real 500. */
function sendTaxonomyError(res: express.Response, err: unknown): void {
  const e = err as { status?: number; message?: string; details?: Record<string, unknown> };
  if (e && typeof e.status === "number") {
    res.status(e.status).json({ error: e.message, ...(e.details || {}) });
    return;
  }
  console.error("[planner taxonomy]", err);
  res.status(500).json({ error: (e && e.message) || "Taxonomy update failed" });
}

app.post("/api/planner/categories", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const tax = await import("./core/plannerTaxonomy.js");
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    const category = tax.createCategory({
      name: String(body.name || ""),
      colorHex: String(body.colorHex || tax.PALETTE_20[0].hex),
    });
    res.json({ ok: true, category, categories: tax.listCategories() });
  } catch (err) {
    sendTaxonomyError(res, err);
  }
});

app.patch("/api/planner/categories/:id", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const tax = await import("./core/plannerTaxonomy.js");
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    const category = tax.updateCategory(String(req.params.id), {
      name: typeof body.name === "string" ? body.name : undefined,
      colorHex: typeof body.colorHex === "string" ? body.colorHex : undefined,
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : undefined,
    });
    if (!category) {
      res.status(404).json({ error: "No such category" });
      return;
    }
    // Recolouring a category repaints every card carrying it, in one write.
    if (typeof body.colorHex === "string") {
      const { getPlannerDb } = await import("./core/contentPlanner.js");
      getPlannerDb()
        .prepare(`UPDATE planner_items SET color=?, updated_at=? WHERE category_id=?`)
        .run(category.colorHex, new Date().toISOString(), category.id);
    }
    res.json({ ok: true, category, categories: tax.listCategories() });
  } catch (err) {
    sendTaxonomyError(res, err);
  }
});

app.delete("/api/planner/categories/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const tax = await import("./core/plannerTaxonomy.js");
  try {
    const out = tax.deleteCategory(String(req.params.id), req.query.reassignTo ? String(req.query.reassignTo) : null);
    if (!out.deleted) {
      res.status(404).json({ error: "No such category" });
      return;
    }
    res.json({ ok: true, ...out, categories: tax.listCategories() });
  } catch (err) {
    sendTaxonomyError(res, err);
  }
});

app.post("/api/planner/platforms", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const tax = await import("./core/plannerTaxonomy.js");
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    const platform = tax.createPlatform({
      name: String(body.name || ""),
      iconKey: typeof body.iconKey === "string" ? body.iconKey : undefined,
      activeStatus: typeof body.activeStatus === "boolean" ? body.activeStatus : undefined,
    });
    res.json({ ok: true, platform, platforms: tax.listPlatforms() });
  } catch (err) {
    sendTaxonomyError(res, err);
  }
});

app.patch("/api/planner/platforms/:id", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const tax = await import("./core/plannerTaxonomy.js");
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    const platform = tax.updatePlatform(String(req.params.id), {
      name: typeof body.name === "string" ? body.name : undefined,
      iconKey: typeof body.iconKey === "string" ? body.iconKey : undefined,
      activeStatus: typeof body.activeStatus === "boolean" ? body.activeStatus : undefined,
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : undefined,
    });
    if (!platform) {
      res.status(404).json({ error: "No such platform" });
      return;
    }
    res.json({ ok: true, platform, platforms: tax.listPlatforms() });
  } catch (err) {
    sendTaxonomyError(res, err);
  }
});

app.delete("/api/planner/platforms/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const tax = await import("./core/plannerTaxonomy.js");
  try {
    const out = tax.deletePlatform(String(req.params.id), req.query.reassignTo ? String(req.query.reassignTo) : null);
    if (!out.deleted) {
      res.status(404).json({ error: "No such platform" });
      return;
    }
    res.json({ ok: true, ...out, platforms: tax.listPlatforms() });
  } catch (err) {
    sendTaxonomyError(res, err);
  }
});

app.post("/api/planner/members", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const tax = await import("./core/plannerTaxonomy.js");
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    const member = tax.createMember({
      fullName: String(body.fullName || ""),
      role: typeof body.role === "string" ? body.role : undefined,
      avatarInitials: typeof body.avatarInitials === "string" ? body.avatarInitials : undefined,
      badgeColor: typeof body.badgeColor === "string" ? body.badgeColor : undefined,
    });
    res.json({ ok: true, member, team: tax.listMembers() });
  } catch (err) {
    sendTaxonomyError(res, err);
  }
});

app.patch("/api/planner/members/:id", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const tax = await import("./core/plannerTaxonomy.js");
  const body = (req.body || {}) as Record<string, unknown>;
  try {
    if (body.restore === true) {
      tax.restoreMember(String(req.params.id));
      res.json({ ok: true, team: tax.listMembers(), hiddenMembers: tax.hiddenMembers() });
      return;
    }
    const member = tax.updateMember(String(req.params.id), {
      fullName: typeof body.fullName === "string" ? body.fullName : undefined,
      role: typeof body.role === "string" ? body.role : undefined,
      avatarInitials: typeof body.avatarInitials === "string" ? body.avatarInitials : undefined,
      badgeColor: typeof body.badgeColor === "string" ? body.badgeColor : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
    });
    if (!member) {
      res.status(404).json({ error: "No such team member" });
      return;
    }
    res.json({ ok: true, member, team: tax.listMembers() });
  } catch (err) {
    sendTaxonomyError(res, err);
  }
});

/**
 * Remove a member from the planner. `mergeInto` is the deduplication path:
 * their content is reassigned first, then the record goes. A member derived
 * from the roster or the CRM is HIDDEN here, never deleted there — removing a
 * duplicate off a content calendar must not sign anybody out of the app.
 */
app.delete("/api/planner/members/:id", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const tax = await import("./core/plannerTaxonomy.js");
  try {
    const out = tax.deleteMember(String(req.params.id), req.query.mergeInto ? String(req.query.mergeInto) : null);
    if (!out.deleted) {
      res.status(404).json({ error: "No such team member" });
      return;
    }
    res.json({ ok: true, ...out, team: tax.listMembers(), hiddenMembers: tax.hiddenMembers() });
  } catch (err) {
    sendTaxonomyError(res, err);
  }
});

app.get("/api/planner/activity", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const planner = await import("./core/contentPlanner.js");
  res.json({ activity: planner.listActivity(Number(req.query.limit) || 50) });
});

/**
 * AI hook assist. Real call to the same Anthropic model the rest of the app
 * uses — and when no key is configured it says exactly that instead of
 * returning a canned line dressed up as a suggestion.
 */
app.post("/api/planner/hook-assist", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const { complete, isAnthropicApiKeyConfigured } = await import("./integrations/llm/index.js");
  if (!isAnthropicApiKeyConfigured()) {
    res.status(503).json({
      error: "Hook assist needs the ANTHROPIC_API_KEY secret — it is not set, so there is nothing to ask.",
    });
    return;
  }
  const body = (req.body || {}) as Record<string, unknown>;
  const title = String(body.title || "").trim();
  const platforms = Array.isArray(body.platforms) ? (body.platforms as string[]).join(", ") : "";
  try {
    const text = await complete(
      `Write 3 short scroll-stopping opening hooks for a real-estate social post.\n` +
        `Topic: ${title || "(no title yet)"}\nPlatforms: ${platforms || "(unspecified)"}\n` +
        `Caption so far: ${String(body.caption || "").slice(0, 400)}\n` +
        `Return them as three plain lines, no numbering, no preamble, under 15 words each.`,
      "You write hooks for Marco Puga, a San Antonio real-estate agent. Direct, specific, no hype words.",
    );
    const hooks = String(text || "")
      .split("\n")
      .map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 3);
    res.json({ ok: true, hooks });
  } catch (err) {
    res.status(502).json({ error: `Hook assist failed: ${(err as Error)?.message || err}` });
  }
});

/**
 * An assignment raises a real notification on the Task Command board — the
 * same feed assignments from the task board land in — so "notify on assign"
 * means the person actually sees it, not just a row in a log table.
 */
async function notifyPlannerAssignees(userIds: string[], title: string, itemId: string, actor: string): Promise<void> {
  if (!userIds.length) return;
  try {
    const { addNotification } = await import("./core/teamStore.js");
    // The taxonomy name, not the roster one: a member renamed or merged in the
    // planner must be named here the way the calendar names them.
    const { memberName } = await import("./core/plannerTaxonomy.js");
    for (const userId of userIds) {
      addNotification({
        user: userId,
        type: "assignment",
        title: "Assigned a content item",
        body: `${actor ? memberName(actor) + " assigned" : "You were assigned"} "${title}" on the content calendar.`,
        taskId: itemId,
        from: actor || undefined,
      });
    }
  } catch (err) {
    console.warn("[planner] assignment notification failed:", err);
  }
}

/** Legacy listing status change — maps active/off_market to new intake (uses propertyInquired as address). */
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
  const address =
    (typeof req.body?.address === "string" && req.body.address.trim()) ||
    lead.propertyInquired?.trim() ||
    "Unknown address";
  try {
    const mapped = statusRaw === "off_market" ? "off_market" : "active";
    const result = await handleListingStatusUpdate(leadId, address, mapped, "manual");
    res.status(200).json({ success: true, ...result });
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
  filter.tagsExclude = arr("tagsExclude");
  if (typeof body.hasEmail === "boolean") filter.hasEmail = body.hasEmail;
  if (typeof body.hasPhone === "boolean") filter.hasPhone = body.hasPhone;
  if (typeof body.hasAddress === "boolean") filter.hasAddress = body.hasAddress;
  if (typeof body.autoPlan === "string" && body.autoPlan.trim()) filter.autoPlan = body.autoPlan.trim();
  const month = (key: "birthdayMonth" | "anniversaryMonth") => {
    const n = Math.round(Number(body[key]));
    if (Number.isFinite(n) && n >= 1 && n <= 12) filter[key] = n;
  };
  month("birthdayMonth");
  month("anniversaryMonth");
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
  /* Never ship the hash. This endpoint was returning every account's scrypt
     hash to anyone who asked, unauthenticated, until 2026-08-22. */
  res.status(200).json({ users: getUsers().map(({ passwordHash, ...safe }) => { void passwordHash; return safe; }) });
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
  void currentSessionUser(req).then((actor) => {
    void import("./core/authStore.js").then(({ recordAudit }) => {
      const change = updates.active !== undefined ? (updates.active ? "reactivated" : "deactivated") : "updated";
      recordAudit({ userId: actor?.id, userName: actor?.name, action: "team." + change, detail: updated.name, req });
    });
  });
  res.status(200).json({ ok: true, user: updated });
});

app.delete("/api/users/:id", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  const target = getUserById(id);
  const ok = deleteUser(id);
  if (!ok) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  void currentSessionUser(req).then((actor) => {
    void import("./core/authStore.js").then(({ recordAudit }) => {
      recordAudit({ userId: actor?.id, userName: actor?.name, action: "team.delete", detail: target?.name, req });
    });
  });
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

/**
 * Settings-screen payload: plans + triggers with LIVE enrolled counts, computed
 * from actual lead enrollments (and transaction enrollments for deal plans) —
 * Brivity shows these so you can confirm a trigger is actually firing.
 */
app.get("/api/auto-plans/settings", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const plans = getAutoPlans();
  const triggers = getAutoPlanTriggers();
  const leads = await listAllLeads();
  const byPlan = new Map<string, number>();
  const byTrigger = new Map<string, number>();
  for (const lead of leads) {
    for (const enr of lead.autoPlanEnrollments || []) {
      if (enr.status === "active") byPlan.set(enr.planId, (byPlan.get(enr.planId) || 0) + 1);
      if (enr.enrolledVia && enr.enrolledVia !== "manual") {
        byTrigger.set(enr.enrolledVia, (byTrigger.get(enr.enrolledVia) || 0) + 1);
      }
    }
  }
  for (const tx of getAllTransactions()) {
    for (const enr of tx.autoPlans || []) {
      if (enr.status === "active") byPlan.set(enr.planId, (byPlan.get(enr.planId) || 0) + 1);
    }
  }
  res.status(200).json({
    plans: plans.map((p) => ({ ...p, enrolled: byPlan.get(p.id) || 0 })),
    triggers: triggers.map((t) => ({ ...t, enrolled: byTrigger.get(t.id) || 0 })),
  });
});

app.post("/api/auto-plans/:id/duplicate", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const plan = duplicateAutoPlan(String(req.params.id || "").trim());
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }
  res.status(201).json({ plan });
});

app.get("/api/auto-plan-triggers", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.status(200).json({ triggers: getAutoPlanTriggers() });
});

app.post("/api/auto-plan-triggers", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  const plan = planId ? getAutoPlanById(planId) : null;
  if (!plan) {
    res.status(400).json({ error: "planId must reference an existing plan" });
    return;
  }
  if (plan.planType === "transaction") {
    res.status(400).json({ error: "Triggers enroll PEOPLE — a transaction plan cannot be a trigger target" });
    return;
  }
  const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const trigger = createAutoPlanTrigger({
    intent: clean(body.intent),
    status: clean(body.status),
    source: clean(body.source),
    tag: clean(body.tag),
    planId,
    active: body.active !== false,
  });
  res.status(201).json({ trigger });
});

app.patch("/api/auto-plan-triggers/:id", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  for (const k of ["intent", "status", "source", "tag"] as const) {
    if (body[k] !== undefined) patch[k] = clean(body[k]);
  }
  if (typeof body.planId === "string" && body.planId.trim()) {
    if (!getAutoPlanById(body.planId.trim())) {
      res.status(400).json({ error: "planId must reference an existing plan" });
      return;
    }
    patch.planId = body.planId.trim();
  }
  if (typeof body.active === "boolean") patch.active = body.active;
  const trigger = updateAutoPlanTrigger(String(req.params.id || "").trim(), patch);
  if (!trigger) {
    res.status(404).json({ error: "Trigger not found" });
    return;
  }
  res.status(200).json({ trigger });
});

app.delete("/api/auto-plan-triggers/:id", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  if (!deleteAutoPlanTrigger(String(req.params.id || "").trim())) {
    res.status(404).json({ error: "Trigger not found" });
    return;
  }
  res.status(200).json({ success: true });
});

/**
 * Everything the plan/step editors need to populate their dropdowns, in one
 * request: merge fields for Insert Placeholder, roles for Send From /
 * Assign To, and the saved email templates. One endpoint rather than three
 * because the editor opens as a unit and three round trips would show a
 * modal with half its options missing.
 */
app.get("/api/auto-plans/meta", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  let templates: Array<{ id: string; name: string; subject: string }> = [];
  try {
    const { getEmailTemplates } = await import("./core/emailStore.js");
    templates = getEmailTemplates().filter((t) => t.isActive !== false).map((t) => ({ id: t.id, name: t.name, subject: t.subject }));
  } catch {
    templates = []; // an unreachable template store must not break the editor
  }
  res.json({
    ok: true,
    mergeFields: MERGE_FIELDS,
    roles: AUTO_PLAN_ROLES,
    team: listTeamMembers().map((m) => ({ id: m.id, name: m.name, role: m.role })),
    templates,
    offsetUnits: ["minutes", "hours", "days"],
    recurrences: ["never", "daily", "weekly", "monthly", "yearly"],
    maxRecurringRuns: MAX_RECURRING_RUNS,
  });
});

/**
 * "AI: Help Me Write" on the email/text/task step editors.
 *
 * Drafts step COPY, not a message to a specific person — a plan step is
 * written once for hundreds of contacts — so the prompt asks for merge-field
 * placeholders rather than invented names, and the house style rules apply
 * (this text goes to real clients under Marco's name).
 */
app.post("/api/auto-plans/draft-step", express.json({ limit: "32kb" }), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const kind = body.kind === "email" || body.kind === "text" || body.kind === "task" ? body.kind : null;
  const about = typeof body.about === "string" ? body.about.trim().slice(0, 600) : "";
  if (!kind || !about) {
    res.status(400).json({ error: "kind (email|text|task) and about are required" });
    return;
  }
  try {
    const { complete, isAnthropicApiKeyConfigured } = await import("./integrations/llm/index.js");
    if (!isAnthropicApiKeyConfigured()) {
      res.status(503).json({ error: "AI drafting is unavailable — ANTHROPIC_API_KEY is not set." });
      return;
    }
    const { HARVEY_HOUSE_STYLE, stripAiTypography } = await import("./core/houseStyle.js");
    const limits =
      kind === "text"
        ? "Under 320 characters, no links, no emoji. It is an SMS from a real agent."
        : kind === "email"
          ? "Return the body only, no subject line, no signature block."
          : "One line naming the action, specific enough that a teammate could do it without context.";
    const placeholders = MERGE_FIELDS.map((f) => `{{${f.key}}}`).join(", ");
    const prompt = [
      `Write the ${kind} step of a real-estate follow-up Auto Plan for Marco Puga, a San Antonio agent.`,
      `The step is about: ${about}`,
      limits,
      `This one piece of copy is sent to MANY different contacts, so never invent a name, address, or price.`,
      `Where a personal detail belongs, use one of these placeholders exactly: ${placeholders}`,
      `Return only the copy itself, with nothing before or after it.`,
      HARVEY_HOUSE_STYLE,
    ].join("\n\n");
    const draft = await complete(prompt, "");
    res.json({ ok: true, draft: stripAiTypography(String(draft || "").trim()) });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
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
    planType: body.planType === "transaction" ? "transaction" : "people",
    steps: Array.isArray(body.steps) ? (body.steps as AutoPlan["steps"]) : [],
    active: body.active !== false,
    autoPauseOnReply: body.autoPauseOnReply !== false,
    autoPauseOnStatus: typeof body.autoPauseOnStatus === "string" ? body.autoPauseOnStatus : null,
    completionStatus: typeof body.completionStatus === "string" ? body.completionStatus : null,
    archived: body.archived === true,
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
  if (body.planType === "people" || body.planType === "transaction") updates.planType = body.planType;
  if (typeof body.autoPauseOnReply === "boolean") updates.autoPauseOnReply = body.autoPauseOnReply;
  if (body.autoPauseOnStatus !== undefined) updates.autoPauseOnStatus = typeof body.autoPauseOnStatus === "string" ? body.autoPauseOnStatus : null;
  if (body.completionStatus !== undefined) updates.completionStatus = typeof body.completionStatus === "string" ? body.completionStatus : null;
  if (typeof body.archived === "boolean") updates.archived = body.archived;
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
  /* Dynamic, matching how every other caller reaches emailStore — it opens a
     SQLite handle on first import and the engine may run before anything else
     has needed it. */
  const { getEmailTemplate } = await import("./core/emailStore.js");
  const plans = getAutoPlans();
  const planById = new Map(plans.map((p) => [p.id, p]));
  const leads = await listAllLeads();
  const now = Date.now();
  let processed = 0;
  let stepsExecuted = 0;
  const completionStatusByLead = new Map<string, string>();

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
      if (!plan || !plan.active || plan.archived || plan.planType === "transaction") {
        nextEnrollments.push(enr);
        continue;
      }
      processed++;
      const enrolledMs = new Date(enr.enrolledAt).getTime();
      const completed = new Set(enr.completedSteps);
      const completedAt: Record<string, string> = { ...(enr.completedAt || {}) };
      const lastRunAt: Record<string, string> = { ...(enr.lastRunAt || {}) };
      const runCount: Record<string, number> = { ...(enr.runCount || {}) };

      for (const step of plan.steps) {
        const repeatMs = recurrenceMs(step.recurrence);
        const isRecurring = step.type === "task" && repeatMs !== null;
        if (completed.has(step.id)) continue;
        /* Anchor resolution (Brivity's "After [...]" dropdown): a chained step
           counts from when its referenced step actually completed — and is
           simply not due yet while that step is unfinished. "Make Contingent"
           is the same mechanism stated explicitly in the UI. */
        let dueMs: number;
        if (step.anchor === "birthday" || step.anchor === "home_anniversary") {
          /* Specific Dates: pinned to a real date on the contact, never
             retroactive — the first occurrence at or after enrollment. */
          const specific = specificDateDueMs(step, lead, enrolledMs);
          if (specific === null) continue; // no such date on this contact
          dueMs = specific;
        } else {
          let baseMs = enrolledMs;
          if (step.anchor === "prev_step" && step.afterStepId) {
            const prevDone = completedAt[step.afterStepId];
            if (!prevDone) continue;
            baseMs = new Date(prevDone).getTime();
          }
          dueMs = baseMs + offsetMs(step);
        }
        if (isRecurring) {
          /* A repeating step is never "done": it re-arms off its own last run
             until the run cap stops it. */
          const runs = runCount[step.id] || 0;
          if (runs >= MAX_RECURRING_RUNS) {
            completed.add(step.id);
            completedAt[step.id] = new Date().toISOString();
            changed = true;
            newActivity.push({
              type: "auto_plan",
              description: `Auto Plan step stopped repeating after ${MAX_RECURRING_RUNS} runs: ${(step.content || "").slice(0, 80)}`,
              timestamp: new Date().toISOString(),
            });
            continue;
          }
          const last = lastRunAt[step.id];
          if (last) dueMs = new Date(last).getTime() + (repeatMs as number);
        }
        if (dueMs > now) continue;
        const stamp = new Date().toISOString();
        /* Merge fields resolve against THIS contact. An unresolvable
           placeholder blocks the send further down rather than shipping
           "Hi {{recipient_first_name}}" to a real client. */
        const merged = applyMergeFields(step.content || "", lead, { name: "Marco Puga", phone: process.env.HARVEY_OWNER_NUMBER });
        const content = merged.text;
        if (step.type === "text") {
          if (!isSendable(merged)) {
            /* Same shape as the missing-phone path: a visible task, never a
               silent skip and never a half-filled text to a real person. */
            createTask({
              title: `Auto Plan text held back — ${describeMergeProblem(merged)}`,
              description: `Plan "${plan.name}" could not fill every placeholder for ${lead.name || lead.username || lead.id}. Message as written: ${step.content}`,
              type: "follow_up",
              priority: "high",
              status: "pending",
              dueDate: stamp.slice(0, 10),
              leadId: lead.id,
              leadName: lead.name || lead.username || undefined,
              assignedUserName: resolveSender(step.sendFrom, lead).name,
              source: "auto_plan",
            });
            newActivity.push({ type: "auto_plan", description: `Auto Plan text HELD BACK — ${describeMergeProblem(merged)} (task created)`, timestamp: stamp });
            completed.add(step.id);
            completedAt[step.id] = stamp;
            stepsExecuted++;
            changed = true;
            continue;
          }
          if (!lead.phone) {
            /* Brivity surfaces this as an Auto Plan error; the honest move here
               is a visible task for a human, never a silent skip and never a
               fake "sent". The step is marked done so the plan continues. */
            createTask({
              title: `Auto Plan text needs a phone number: ${lead.name || lead.username || lead.id}`,
              description: `Plan "${plan.name}" tried to text this contact but no phone is on file. Message: ${content}`,
              type: "follow_up",
              priority: "high",
              status: "pending",
              dueDate: stamp.slice(0, 10),
              leadId: lead.id,
              leadName: lead.name || lead.username || undefined,
              assignedUserName: "Marco Puga",
              source: "auto_plan",
            });
            newActivity.push({ type: "auto_plan", description: `Auto Plan text SKIPPED — no phone on file (task created): ${content}`, timestamp: stamp });
          } else {
            const sender = resolveSender(step.sendFrom, lead);
            await sendLeadText(lead.id, content);
            newActivity.push({
              type: "text_sent",
              description: `Auto Plan text (from ${sender.name}${sender.fallbackFrom ? `, standing in for ${sender.fallbackFrom}` : ""}): ${content}`,
              timestamp: stamp,
            });
          }
        } else if (step.type === "email") {
          /* A saved template supplies the body/subject when the step points at
             one, so a plan does not carry a stale copy of it. */
          const tpl = step.templateId ? getEmailTemplate(step.templateId) : null;
          const bodySource = tpl?.body || step.content || "";
          const mergedBody = applyMergeFields(bodySource, lead, { name: "Marco Puga", phone: process.env.HARVEY_OWNER_NUMBER });
          const mergedSubject = applyMergeFields(step.subject || tpl?.subject || "", lead, { name: "Marco Puga" });
          const sender = resolveSender(step.sendFrom, lead);
          const recipients = [
            ...(step.cc || []).map((a) => `cc ${a}`),
            ...(step.bcc || []).map((a) => `bcc ${a}`),
          ];
          const suffix = [
            `from ${sender.name}${sender.fallbackFrom ? `, standing in for ${sender.fallbackFrom}` : ""}`,
            recipients.length ? recipients.join(", ") : "",
            tpl ? `template "${tpl.name}"` : "",
          ].filter(Boolean).join("; ");
          if (!isSendable(mergedBody) || !isSendable(mergedSubject)) {
            const why = describeMergeProblem(isSendable(mergedBody) ? mergedSubject : mergedBody);
            createTask({
              title: `Auto Plan email held back — ${why}`,
              description: `Plan "${plan.name}" could not fill every placeholder for ${lead.name || lead.username || lead.id}. Subject: ${step.subject || ""}. Body as written: ${bodySource}`,
              type: "follow_up",
              priority: "high",
              status: "pending",
              dueDate: stamp.slice(0, 10),
              leadId: lead.id,
              leadName: lead.name || lead.username || undefined,
              assignedUserName: sender.name,
              source: "auto_plan",
            });
            newActivity.push({ type: "auto_plan", description: `Auto Plan email HELD BACK — ${why} (task created)`, timestamp: stamp });
          } else if (!lead.email) {
            /* Same shape as the missing-phone path: a task, never a silent
               skip. A plan cannot email a contact with no address. */
            createTask({
              title: `Auto Plan email needs an address: ${lead.name || lead.username || lead.id}`,
              description: `Plan "${plan.name}" tried to email this contact but no email is on file. Subject: ${mergedSubject.text}`,
              type: "follow_up",
              priority: "high",
              status: "pending",
              dueDate: stamp.slice(0, 10),
              leadId: lead.id,
              leadName: lead.name || lead.username || undefined,
              assignedUserName: sender.name,
              source: "auto_plan",
            });
            newActivity.push({ type: "auto_plan", description: `Auto Plan email SKIPPED — no email on file (task created): ${mergedSubject.text}`, timestamp: stamp });
          } else {
            const subj = mergedSubject.text ? `${mergedSubject.text} — ` : "";
            const { sendEmail: sendRealEmail } = await import("./integrations/gmail/index.js");
            try {
              /* Actually delivers now that SMTP app-password sending exists.
                 A throw here is a real failure — recorded as such, with a task
                 so a human picks it up, rather than swallowed. */
              const sent = await sendRealEmail({
                to: lead.email,
                subject: mergedSubject.text || "(no subject)",
                body: mergedBody.text,
                html: true,
                cc: step.cc,
                bcc: step.bcc,
              });
              newActivity.push({
                type: "email_sent",
                description: `Auto Plan email sent (${suffix}) id=${sent.messageId}: ${subj}${mergedBody.text.slice(0, 200)}`,
                timestamp: stamp,
              });
            } catch (sendErr) {
              const why = sendErr instanceof Error ? sendErr.message : String(sendErr);
              createTask({
                title: `Auto Plan email failed to send: ${lead.name || lead.username || lead.id}`,
                description: `Plan "${plan.name}" could not send. Reason: ${why}\n\nSubject: ${mergedSubject.text}\n\n${mergedBody.text}`,
                type: "follow_up",
                priority: "high",
                status: "pending",
                dueDate: stamp.slice(0, 10),
                leadId: lead.id,
                leadName: lead.name || lead.username || undefined,
                assignedUserName: sender.name,
                source: "auto_plan",
              });
              newActivity.push({
                type: "auto_plan",
                description: `Auto Plan email FAILED (${why}) — task created: ${subj}`,
                timestamp: stamp,
              });
            }
          }
        } else {
          const assignee = resolveSender(step.assignedTo, lead);
          const who = assignee.name;
          const dueDate = stamp.slice(0, 10);
          /* Brivity's 1 (highest) – 9 (lowest) mapped onto the task store's
             four levels, so an Auto Plan task triages like any other. */
          const pr = step.taskPriority;
          const priority: TaskPriority =
            pr === undefined ? "normal" : pr <= 2 ? "urgent" : pr <= 4 ? "high" : pr <= 6 ? "normal" : "low";
          const body = [
            `Auto Plan (${plan.name}): ${content}`,
            step.instructions ? `\nInstructions: ${step.instructions}` : "",
            step.notes ? `\nNotes to log on completion: ${step.notes}` : "",
            assignee.fallbackFrom ? `\nAssigned to ${who} standing in for ${assignee.fallbackFrom}.` : "",
          ].filter(Boolean).join("");
          createTask({
            title: content.length > 120 ? content.slice(0, 117) + "…" : content,
            description: body,
            type: "follow_up",
            priority,
            status: "pending",
            dueDate,
            leadId: lead.id,
            leadName: lead.name || lead.username || lead.phone || undefined,
            assignedUserId: assignee.userId,
            assignedUserName: who,
            source: "auto_plan",
          });
          newActivity.push({
            type: "task",
            description: `Auto Plan task for ${who}: ${content}`,
            timestamp: stamp,
          });
          /* Brivity's "Notes can post to the timeline on completion" — logged
             at creation here, because nothing in this codebase observes a task
             being ticked. Stated as scheduled, not as done. */
          if (step.notes) {
            newActivity.push({
              type: "note",
              description: `Auto Plan note (with task "${content.slice(0, 60)}"): ${applyMergeFields(step.notes, lead).text}`,
              timestamp: stamp,
            });
          }
        }
        if (repeatMs !== null && step.type === "task") {
          lastRunAt[step.id] = stamp;
          runCount[step.id] = (runCount[step.id] || 0) + 1;
        } else {
          completed.add(step.id);
          completedAt[step.id] = stamp;
        }
        stepsExecuted++;
        changed = true;
      }

      /* A recurring step is never complete, so a plan containing a live one is
         never complete either — otherwise the completion status would fire
         while the step is still running. */
      const allDone = plan.steps.every((s) => completed.has(s.id));
      /* enr.status is "active" here — non-active enrollments were pushed through above. */
      if (allDone && plan.completionStatus) {
        /* Brivity's "auto change lead's status when the plan is completed". */
        completionStatusByLead.set(lead.id, plan.completionStatus);
        changed = true;
      }
      nextEnrollments.push({
        ...enr,
        completedSteps: [...completed],
        completedAt,
        lastRunAt,
        runCount,
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
      const completion = completionStatusByLead.get(lead.id);
      if (completion) {
        /* Separate write so the status change goes through the ordinary organic
           path — trigger evaluation included, exactly like a hand edit. */
        await updateLeadCrmFields({ leadId: lead.id, crmStatus: completion as CrmStatusValue });
      }
    }
  }

  return { processed, stepsExecuted };
}

/**
 * Transaction Plans engine — Brivity's second flavor: the same step machinery
 * running against a DEAL, timed off the deal's real dates ("3 days before Close
 * Date"), not days-since-enrollment. Steps become tasks (and texts when the
 * deal is linked to a lead with a phone). Email steps become tasks too, stated
 * plainly in the task body: the Gmail send path is not connected, and a task a
 * human sees beats an email that silently never sends.
 */
export async function executeDueTransactionPlanSteps(): Promise<{ processed: number; stepsExecuted: number }> {
  const plans = getAutoPlans();
  const planById = new Map(plans.map((p) => [p.id, p]));
  const now = Date.now();
  let processed = 0;
  let stepsExecuted = 0;

  for (const tx of getAllTransactions()) {
    const enrollments = tx.autoPlans || [];
    if (!enrollments.length) continue;
    let changed = false;
    const nextEnrollments: typeof enrollments = [];

    for (const enr of enrollments) {
      if (enr.status !== "active") {
        nextEnrollments.push(enr);
        continue;
      }
      const plan = planById.get(enr.planId);
      if (!plan || !plan.active || plan.archived || plan.planType !== "transaction") {
        nextEnrollments.push(enr);
        continue;
      }
      processed++;
      const completed = new Set(enr.completedSteps);
      const completedAt: Record<string, string> = { ...(enr.completedAt || {}) };

      for (const step of plan.steps) {
        if (completed.has(step.id)) continue;
        let baseIso: string | undefined;
        switch (step.anchor) {
          case "contract_date": baseIso = tx.contractDate; break;
          case "closing_date": baseIso = tx.closingDate; break;
          case "expiration": baseIso = tx.expiration; break;
          case "inspection_date": baseIso = tx.inspectionDate; break;
          case "prev_step": baseIso = step.afterStepId ? completedAt[step.afterStepId] : undefined; break;
          default: baseIso = enr.enrolledAt;
        }
        /* A date the deal does not have yet is not an error — the step simply
           waits until someone fills the date in. That is how "3 days before
           close" behaves on a deal with no close date. */
        if (!baseIso) continue;
        /* Shared with the People engine so a "30 minutes after" step means the
           same thing on both surfaces. */
        const dueMs = new Date(baseIso).getTime() + offsetMs(step);
        if (Number.isNaN(dueMs) || dueMs > now) continue;
        const stamp = new Date().toISOString();
        const content = (step.content || "").replace(/\[address\]/g, tx.address);

        if (step.type === "text" && tx.leadId) {
          const lead = await getLeadById(tx.leadId);
          if (lead?.phone) {
            await sendLeadText(lead.id, content);
          } else {
            createTask({
              title: `Transaction plan text needs a phone: ${tx.address}`,
              description: `Plan "${plan.name}" step could not text (no linked phone). Message: ${content}`,
              type: "follow_up", priority: "high", status: "pending",
              dueDate: stamp.slice(0, 10), assignedUserName: "Marco Puga", source: "auto_plan",
            });
          }
        } else {
          const label = step.type === "email"
            ? `SEND EMAIL (email automation not connected — send by hand): ${step.subject ? step.subject + " — " : ""}${content}`
            : step.type === "text"
              ? `SEND TEXT (deal has no linked lead): ${content}`
              : content;
          createTask({
            title: (step.type === "task" ? content : label).slice(0, 120) || `Transaction plan step — ${tx.address}`,
            description: `Transaction plan "${plan.name}" — ${tx.address}: ${label}${step.instructions ? "\nInstructions: " + step.instructions : ""}`,
            type: "follow_up",
            priority: step.taskPriority && step.taskPriority <= 3 ? "high" : "normal",
            status: "pending",
            dueDate: stamp.slice(0, 10),
            assignedUserName: step.assignedTo || "Marco Puga",
            source: "auto_plan",
          });
        }
        completed.add(step.id);
        completedAt[step.id] = stamp;
        stepsExecuted++;
        changed = true;
      }

      const allDone = plan.steps.every((st) => completed.has(st.id));
      nextEnrollments.push({
        ...enr,
        completedSteps: [...completed],
        completedAt,
        status: allDone ? "completed" : enr.status,
      });
    }

    if (changed) {
      updateTransaction(String(tx.id), { autoPlans: nextEnrollments });
    }
  }

  return { processed, stepsExecuted };
}

app.post("/api/transactions/:id/auto-plans/:planId", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const tx = getTransaction(String(req.params.id || "").trim());
  const plan = getAutoPlanById(String(req.params.planId || "").trim());
  if (!tx || !plan) {
    res.status(404).json({ error: !tx ? "Transaction not found" : "Plan not found" });
    return;
  }
  if (plan.planType !== "transaction") {
    res.status(400).json({ error: "That is a People plan — enroll contacts in it, not deals" });
    return;
  }
  const rest = (tx.autoPlans || []).filter((e) => e.planId !== plan.id);
  const updated = updateTransaction(String(tx.id), {
    autoPlans: [...rest, {
      planId: plan.id, planName: plan.name, enrolledAt: new Date().toISOString(),
      completedSteps: [], status: "active" as const,
    }],
  });
  res.status(200).json({ transaction: updated });
});

app.delete("/api/transactions/:id/auto-plans/:planId", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const tx = getTransaction(String(req.params.id || "").trim());
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  const planId = String(req.params.planId || "").trim();
  const updated = updateTransaction(String(tx.id), {
    autoPlans: (tx.autoPlans || []).filter((e) => e.planId !== planId),
  });
  res.status(200).json({ transaction: updated });
});

app.post("/api/auto-plans/execute-due-steps", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  try {
    const people = await executeDueAutoPlanSteps();
    const transactions = await executeDueTransactionPlanSteps();
    res.status(200).json({
      processed: people.processed + transactions.processed,
      stepsExecuted: people.stepsExecuted + transactions.stepsExecuted,
      people,
      transactions,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/* ===================== Tasks ===================== */

const TASK_PRIORITIES = new Set<TaskPriority>(["low", "normal", "high", "urgent"]);
const TASK_STATUSES = new Set<TaskStatus>(CRM_TASK_STATUSES);
const COMMAND_STATUS_SET = new Set<CommandTaskStatus>(COMMAND_TASK_STATUSES);
/* Must match TYPES in core/tasks.ts — this Set is what the API accepts, that
   one is what survives a write, and a type in only one of them silently
   becomes "other" somewhere along the way. */
const TASK_TYPES = new Set<TaskType>([
  "call", "text", "email", "appointment", "follow_up", "other",
  "to_do", "mail", "social_media", "door_knock",
]);
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
    ...taskExtras(body),
  };
}

/**
 * The Add Task / Add Appointment fields that are not part of the original
 * task shape. Split out so the POST and the PATCH cannot drift apart.
 */
function taskExtras(body: Record<string, unknown>): Partial<Task> {
  const out: Partial<Task> = {};
  /* A key the caller did not send is OMITTED, never set to undefined. The
     PATCH route merges this object over the stored task, so an explicit
     `undefined` would erase a field the edit never mentioned — which is how
     patching an appointment's outcome silently wiped its type. */
  const str = (k: keyof Task & string, max: number): void => {
    const v = body[k];
    if (typeof v !== "string") return;
    const trimmed = v.trim();
    (out as Record<string, unknown>)[k] = trimmed ? trimmed.slice(0, max) : undefined;
  };
  str("location", 400);
  str("instructions", 4000);
  str("taskNotes", 4000);
  str("appointmentType", 120);
  if (body.recurring === true) out.recurring = true;
  else if (body.recurring === false) out.recurring = undefined;
  if (typeof body.recurringInterval === "string" && body.recurringInterval.trim()) {
    out.recurringInterval = body.recurringInterval.trim().slice(0, 40);
  }
  if (typeof body.appointmentStatus === "string" &&
      ["scheduled", "completed", "cancelled"].includes(body.appointmentStatus)) {
    out.appointmentStatus = body.appointmentStatus as Task["appointmentStatus"];
  }
  if (typeof body.outcome === "string" &&
      ["none", "held", "no_show", "rescheduled"].includes(body.outcome)) {
    out.outcome = body.outcome as Task["outcome"];
  }
  if (body.contingent && typeof body.contingent === "object") {
    const c = body.contingent as Record<string, unknown>;
    const days = typeof c.days === "number" ? Math.round(c.days) : NaN;
    if (Number.isFinite(days) && days >= 0 && days <= 3650 &&
        (c.direction === "before" || c.direction === "after") &&
        typeof c.event === "string") {
      out.contingent = { days, direction: c.direction, event: c.event as import("./core/types.js").ContingentEvent };
    }
  }
  return out;
}

/**
 * Turn a contingent rule into a real due date using the contact's own dates.
 *
 * Returns `{ dueDate: null, reason }` when the contact has no such date on
 * file. That case is a 400 rather than a silent fallback to today: "three
 * days before their anniversary" for somebody with no anniversary recorded is
 * a task nobody can date, and quietly dating it today would put it on the
 * board as due now.
 */
async function resolveTaskContingency(
  leadId: string | undefined,
  rule: NonNullable<Task["contingent"]>,
): Promise<{ dueDate: string | null; reason?: string }> {
  if (!leadId) return { dueDate: null, reason: "A contingent due date needs a contact to measure from." };
  const { getLeadById } = await import("./core/db.js");
  const lead = await getLeadById(leadId);
  if (!lead) return { dueDate: null, reason: "Lead not found" };
  const { resolveContingentDue } = await import("./core/tasks.js");
  const due = resolveContingentDue(rule, {
    birthday: lead.birthday ?? null,
    homeAnniversary: lead.homeAnniversary ?? null,
    /* This system stores no licence or organization dates on a contact, so
       those three rules cannot resolve. Saying which one is missing is more
       useful than a generic failure. */
    licensedSince: null,
    organizationStartDate: null,
    organizationEndDate: null,
  });
  if (due) return { dueDate: due };
  const LABEL: Record<string, string> = {
    birthday: "a birthday",
    anniversary: "a home anniversary",
    licensed_since: "a licensed-since date",
    organization_start_date: "an organization start date",
    organization_end_date: "an organization end date",
  };
  const known = rule.event === "birthday" || rule.event === "anniversary";
  return {
    dueDate: null,
    reason: known
      ? `This contact has no ${LABEL[rule.event]} on file, so the task cannot be dated from it. Add one on the record, or pick a date.`
      : `Nothing on a contact records ${LABEL[rule.event]} in this system, so that rule cannot be used. Pick a date instead.`,
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
/* Replaced by isRecurringInterval in core/types.ts: two of the cadences carry
   a number inside the string, which a Set cannot express. */

function parseRecurringInterval(raw: unknown): CommandTaskRecurringInterval | undefined {
  return isRecurringInterval(raw) ? raw : undefined;
}

/** Validate a "HH:MM" 24-hour time-of-day; returns undefined if malformed/empty. */
function parseDueTime(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw.trim());
  if (!m) return undefined;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** Normalize a reminder-offsets array to sorted unique minutes (0–1440). */
function parseReminderMinutes(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const mins = Array.from(
    new Set(
      raw
        .map((n) => Math.round(Number(n)))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 1440),
    ),
  ).sort((a, b) => a - b);
  return mins.length ? mins : [];
}

/** Normalize a task checklist from client JSON: capped, trimmed, ids guaranteed. */
function parseChecklist(raw: unknown): CommandTaskChecklistItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items: CommandTaskChecklistItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const text = typeof e.text === "string" ? e.text.trim().slice(0, 500) : "";
    if (!text) continue;
    items.push({
      id: typeof e.id === "string" && e.id.trim() ? e.id.trim().slice(0, 64) : `ck_${items.length}_${Date.now().toString(36)}`,
      text,
      done: e.done === true,
      // Preserved so a save from either UI does not sever the tracker↔task link.
      taskId: typeof e.taskId === "string" && e.taskId.trim() ? e.taskId.trim().slice(0, 64) : undefined,
    });
    if (items.length >= 100) break;
  }
  return items;
}

function commandTaskCounts() {
  const all = getCommandTasks();
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

const COMMAND_STATUS_SORT: Record<CommandTaskStatus, number> = {
  overdue: 0,
  due_soon: 1,
  in_progress: 2,
  pending: 3,
  on_hold: 4,
  done: 5,
};

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
  // Scoped read for a Content Planner card's task drawer. Filtering on the
  // existing endpoint rather than adding a parallel one is the whole point:
  // the card and the Task Command board are looking at the same rows.
  const contentSlotId = typeof req.query.contentSlotId === "string" ? req.query.contentSlotId : undefined;
  if (contentSlotId) {
    tasks = tasks.filter((t) => t.contentSlotId === contentSlotId);
  }
  if (assignedTo) {
    tasks = tasks.filter((t) => t.assignedTo === assignedTo);
  }

  tasks.sort((a, b) => {
    const sa = COMMAND_STATUS_SORT[a.status] ?? 2;
    const sb = COMMAND_STATUS_SORT[b.status] ?? 2;
    if (sa !== sb) return sa - sb;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  res.json({ tasks, counts: commandTaskCounts() });
});

/**
 * Command time zone. One zone for the whole team so day boundaries, deadline
 * labels and task rollover agree no matter where the viewer is sitting.
 */
app.get("/api/settings/command", (_req, res) => {
  res.json({ ok: true, settings: getCommandSettings() });
});

app.put("/api/settings/command", express.json({ limit: "16kb" }), async (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const tz = typeof body.timeZone === "string" ? body.timeZone.trim() : "";
  if (!isValidTimeZone(tz)) {
    res.status(400).json({ ok: false, error: "Unknown or missing time zone" });
    return;
  }
  const by = typeof body.updatedBy === "string" ? body.updatedBy : undefined;
  const settings = setCommandTimeZone(tz, by);
  try {
    const { recordAudit } = await import("./core/authStore.js");
    recordAudit({
      userName: by,
      action: "command.timezone.set",
      detail: `Command time zone set to ${settings.timeZone}`,
      req,
    });
  } catch {
    /* audit is best-effort; the setting is already saved */
  }
  res.json({ ok: true, settings });
});

/** Per-user dashboard widget layout. */
/* ===== Buyers & Sellers Tracker ===== */

/** Pipeline vocabulary, so the UI never hardcodes stage lists. */
app.get("/api/tracker/schema", (_req, res) => {
  res.json({
    ok: true,
    statuses: TRACKER_STATUSES,
    buyerStages: BUYER_STAGES,
    sellerStages: SELLER_STAGES,
  });
});

app.get("/api/tracker/records", (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const csv = (v: string | undefined) =>
    v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
  const filter: TrackerFilter = {
    side: q.side === "buyer" || q.side === "seller" ? q.side : undefined,
    status: csv(q.status) as TrackerFilter["status"],
    buyerStage: csv(q.buyerStage) as TrackerFilter["buyerStage"],
    sellerStage: csv(q.sellerStage) as TrackerFilter["sellerStage"],
    source: csv(q.source),
    assignedTo: q.assignedTo || undefined,
    q: q.q || undefined,
    addedFrom: q.addedFrom || undefined,
    addedTo: q.addedTo || undefined,
    interactionFrom: q.interactionFrom || undefined,
    interactionTo: q.interactionTo || undefined,
  };
  // Linked tasks are the source of truth for those checklist items, so reflect
  // their current state rather than serving a stale copy.
  res.json({ ok: true, records: applyTaskStateAll(listTrackerRecords(filter)) });
});

app.get("/api/tracker/counts", (_req, res) => {
  res.json({ ok: true, counts: trackerCounts() });
});

app.get("/api/tracker/records/:id", (req, res) => {
  const raw = getTrackerRecord(String(req.params.id));
  if (!raw) { res.status(404).json({ ok: false, error: "Not found" }); return; }
  const rec = applyTaskState(raw);
  res.json({ ok: true, record: rec, tasks: linkedTasks(rec) });
});

app.post("/api/tracker/records", express.json({ limit: "256kb" }), (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) { res.status(400).json({ ok: false, error: "name is required" }); return; }
  res.json({ ok: true, record: createTrackerRecord({ ...(body as object), name } as never) });
});

app.patch("/api/tracker/records/:id", express.json({ limit: "256kb" }), (req, res) => {
  const body = { ...(req.body && typeof req.body === "object" ? req.body : {}) } as Record<string, unknown>;
  const id = String(req.params.id);
  const before = getTrackerRecord(id);
  if (!before) { res.status(404).json({ ok: false, error: "Not found" }); return; }
  // Sanitise here too, so a client cannot write arbitrary shapes into the
  // checklist column — and so taskId survives the round trip.
  if ("checklist" in body) body.checklist = parseChecklist(body.checklist) ?? [];
  const rec = updateTrackerRecord(id, body as never);
  if (!rec) { res.status(404).json({ ok: false, error: "Not found" }); return; }
  // Ticking an item that has a task completes the task, not just the checkbox.
  /*
   * Compare against the state the user was actually looking at, not the raw
   * stored row. When a task is completed on the board the tracker's stored
   * `done` stays false and only the read overlay shows it ticked — so a raw
   * comparison saw "false -> false" when someone unticked it, and silently left
   * the task closed.
   */
  const synced = "checklist" in body
    ? syncChecklistToTasks(applyTaskState(before).checklist, rec.checklist)
    : 0;
  const fresh = applyTaskState(rec);
  // Return the linked-task state alongside, so the drawer's chips do not sit
  // stale showing "open" for a task the save just completed.
  res.json({ ok: true, record: fresh, tasks: linkedTasks(fresh), tasksUpdated: synced });
});

/** Push checklist items onto the Task Command board as real tasks. */
app.post("/api/tracker/records/:id/tasks", express.json({ limit: "16kb" }), (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const itemIds = Array.isArray(body.itemIds)
    ? body.itemIds.filter((x): x is string => typeof x === "string")
    : undefined;
  const column = COMMAND_COLUMNS.has(body.column as CommandTaskColumn)
    ? (body.column as CommandTaskColumn)
    : "today";
  const out = pushChecklistToTasks(String(req.params.id), itemIds, column);
  if (!out) { res.status(404).json({ ok: false, error: "Not found" }); return; }
  res.json({
    ok: true,
    record: applyTaskState(out.record),
    tasks: linkedTasks(out.record),
    created: out.created.length,
    alreadyLinked: out.skipped,
  });
});

/** Break the link without deleting the task. */
app.delete("/api/tracker/records/:id/tasks/:itemId", (req, res) => {
  const rec = unlinkChecklistItem(String(req.params.id), String(req.params.itemId));
  if (!rec) { res.status(404).json({ ok: false, error: "Not found" }); return; }
  res.json({ ok: true, record: applyTaskState(rec), tasks: linkedTasks(rec) });
});

/** Move one side of a record along its pipeline. */
app.post("/api/tracker/records/:id/stage", express.json({ limit: "16kb" }), (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const side = body.side === "seller" ? "seller" : "buyer";
  const stage = body.stage === null ? null : String(body.stage || "");
  const meta = body.meta && typeof body.meta === "object" ? (body.meta as never) : undefined;
  const rec = setTrackerStage(String(req.params.id), side, stage, meta);
  if (!rec) { res.status(404).json({ ok: false, error: "Not found" }); return; }
  res.json({ ok: true, record: rec });
});

/**
 * Move many records to the same stage at once — the bulk lever for the
 * ~991 records real DM signal cannot reach, and for advancing anyone past
 * Contacted (which needs an actual call/showing, so it is a manual decision).
 */
app.post("/api/tracker/records/bulk-stage", express.json({ limit: "64kb" }), (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === "string").slice(0, 500)
    : [];
  const side = body.side === "seller" ? "seller" : "buyer";
  const stage = body.stage === null ? null : String(body.stage || "");
  if (!ids.length) { res.status(400).json({ ok: false, error: "ids is required" }); return; }
  const moved: string[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const rec = setTrackerStage(id, side, stage);
    if (rec) moved.push(id);
    else notFound.push(id);
  }
  res.json({ ok: true, moved: moved.length, notFound: notFound.length, movedIds: moved });
});

app.delete("/api/tracker/records/:id", (req, res) => {
  res.json({ ok: true, deleted: deleteTrackerRecord(String(req.params.id)) });
});

/**
 * Backfill from CRM leads. Defaults to a dry run so the mapping can be inspected
 * before anything is written; pass {"apply":true} to commit.
 */
app.post("/api/tracker/backfill", express.json({ limit: "16kb" }), async (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const apply = body.apply === true;
  try {
    const leads = await listAllLeads();
    const result = backfillTrackerFromLeads(leads, !apply, {
      refreshIdentity: body.refreshIdentity === true,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * Stage the tracker from real DM engagement (see core/trackerEngagement.ts).
 * Only moves Unstaged -> Contacted, and only where a lead's own funnel state
 * shows a genuine two-way exchange happened. Dry-run by default.
 */
app.post("/api/tracker/stage-from-engagement", express.json({ limit: "16kb" }), async (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const apply = body.apply === true;
  try {
    const { stageTrackerFromEngagement } = await import("./core/trackerEngagement.js");
    const leads = await listAllLeads();
    const result = stageTrackerFromEngagement(leads, { dryRun: !apply });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.get("/api/settings/layout", (req, res) => {
  const user = String(req.query.user || "").trim();
  if (!user) { res.status(400).json({ ok: false, error: "user required" }); return; }
  const { layout, gridOn } = getUserLayout(user);
  res.json({ ok: true, layout, gridOn });
});

app.put("/api/settings/layout", express.json({ limit: "64kb" }), (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const user = typeof body.user === "string" ? body.user.trim() : "";
  if (!user) { res.status(400).json({ ok: false, error: "user required" }); return; }
  try {
    const gridOn = typeof body.gridOn === "boolean" ? body.gridOn : undefined;
    const saved = setUserLayout(user, body.layout, gridOn);
    res.json({ ok: true, ...saved });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/* Per-user table preferences (CRM Columns picker + Sort By). Persisted
   server-side per user so each agent's list layout follows them across
   devices, the way Brivity does it. */
app.get("/api/settings/table-prefs", async (req, res) => {
  const user = String(req.query.user || "").trim();
  if (!user) { res.status(400).json({ ok: false, error: "user required" }); return; }
  const { getUserTablePrefs } = await import("./core/userPrefs.js");
  res.json({ ok: true, tables: getUserTablePrefs(user) });
});

app.put("/api/settings/table-prefs", express.json({ limit: "32kb" }), async (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const user = typeof body.user === "string" ? body.user.trim() : "";
  const table = typeof body.table === "string" ? body.table.trim() : "";
  if (!user || !table) { res.status(400).json({ ok: false, error: "user and table required" }); return; }
  try {
    const { setUserTablePrefs } = await import("./core/userPrefs.js");
    const saved = setUserTablePrefs(user, table, body.prefs);
    res.json({ ok: true, prefs: saved });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * The next instance of a completed recurring task.
 *
 * The interval is applied to the task's OWN due date, not to today: a weekly
 * task finished three days late is still due on its original weekly cadence,
 * and dating the successor from the completion would let a slipping task drift
 * further every cycle. A task with no due date has nothing to advance from, so
 * it is dated from today instead.
 */
function spawnNextRecurrence(done: CommandTask): CommandTask | null {
  /* Every cadence the picker offers has to advance a real date here. An
     interval this function does not recognise returns null and the task
     SILENTLY NEVER RECURS — which is what "Every 3 Months" and "Yearly" did
     before 2026-08-25: the word was stored and nothing ever came back. */
  const interval = String(done.recurringInterval || "");
  const DAYS: Record<string, number> = { daily: 1, every_3_days: 3, every_5_days: 5, weekly: 7, biweekly: 14 };
  const MONTHS: Record<string, number> = { monthly: 1, every_3_months: 3, every_6_months: 6, yearly: 12 };
  const everyN = /^every_(\d{1,3})_days$/.exec(interval);
  const dow = /^day_of_week_([0-6])$/.exec(interval);
  if (!(interval in DAYS) && !(interval in MONTHS) && !everyN && !dow) return null;

  const base = done.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(done.dueDate)
    ? new Date(`${done.dueDate}T00:00:00Z`)
    : new Date();
  const next = new Date(base.getTime());
  if (interval in MONTHS) {
    /* setUTCMonth overflows a short month — 31 Jan + 1 month lands on 2 or 3
       March. Clamp to the last day of the target month instead, so a task due
       on the 31st stays end-of-month rather than skipping one. */
    const day = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + MONTHS[interval]);
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, lastDay));
  } else if (dow) {
    /* Next occurrence of that weekday, always at least 7 days out so the
       successor never lands on the day just completed. */
    const target = Number(dow[1]);
    let delta = (target - next.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    next.setUTCDate(next.getUTCDate() + delta);
  } else {
    next.setUTCDate(next.getUTCDate() + (everyN ? Number(everyN[1]) : DAYS[interval]));
  }
  const dueDate = next.toISOString().slice(0, 10);

  try {
    const spawned = createCommandTask({
      title: done.title,
      description: done.description,
      // A fresh cycle starts with its checklist unticked — carrying the ticks
      // over would show the next instance as already part-done.
      checklist: (done.checklist || []).map((c) => ({ ...c, done: false, taskId: undefined })),
      column: done.column,
      status: "pending",
      color: done.color,
      recurring: true,
      recurringInterval: done.recurringInterval,
      assignedTo: done.assignedTo,
      dueDate,
      dueTime: done.dueTime,
      reminderMinutes: done.reminderMinutes,
      tags: done.tags,
      createdBy: done.createdBy,
      contentSlotId: done.contentSlotId,
    });
    console.log("[Tasks] Recurring task regenerated:", spawned.title, "due", dueDate);
    return spawned;
  } catch (err) {
    // A failed respawn must never fail the completion the user actually asked
    // for; the task they ticked stays done either way.
    console.error("[Tasks] Could not regenerate recurring task:", err);
    return null;
  }
}

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
    checklist: parseChecklist(body.checklist),
    column: column as CommandTaskColumn,
    status: COMMAND_STATUS_SET.has(body.status as CommandTaskStatus)
      ? (body.status as CommandTaskStatus)
      : "pending",
    color,
    recurring: body.recurring === true,
    recurringInterval: parseRecurringInterval(body.recurringInterval),
    assignedTo: typeof body.assignedTo === "string" ? body.assignedTo : "carlos",
    dueDate: typeof body.dueDate === "string" ? body.dueDate.slice(0, 10) : undefined,
    dueTime: parseDueTime(body.dueTime),
    reminderMinutes: parseReminderMinutes(body.reminderMinutes),
    tags: Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === "string")
      : undefined,
    createdBy: typeof body.createdBy === "string" ? body.createdBy : "carlos",
    sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : undefined,
    // Raised from a Content Planner slot. Everything else about the task is
    // identical to one typed on the board — same store, same notification,
    // same reminder engine — which is the point: there is one task system.
    contentSlotId: typeof body.contentSlotId === "string" && body.contentSlotId ? body.contentSlotId : undefined,
  });
  // Assigning someone else's task notifies them (Notifications tab + popup)
  // and emails them from Marco's Gmail. The email is fire-and-forget so a
  // slow or down Gmail can never delay or fail task creation.
  if (task.assignedTo && task.createdBy && task.assignedTo !== task.createdBy) {
    try {
      addNotification({
        user: task.assignedTo,
        type: "assignment",
        title: `${task.createdBy} assigned you a task`,
        body: task.title + (task.dueDate ? ` — due ${task.dueDate}${task.dueTime ? " " + task.dueTime : ""}` : ""),
        taskId: task.id,
        from: task.createdBy,
      });
    } catch (err) { console.error("[team] assignment notification failed:", err); }
    void sendAssignmentEmail(task, task.createdBy);
  }
  console.log("[Tasks] Created:", task.title, "column:", task.column);
  res.json({ task });
});

app.patch("/api/tasks/:id", express.json({ limit: "1mb" }), (req, res) => {
  const id = String(req.params.id || "").trim();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Partial<CommandTask>;
  const updates: Partial<CommandTask> = {};
  if (typeof body.title === "string") updates.title = body.title.trim();
  if (typeof body.description === "string") updates.description = body.description;
  if ("checklist" in body) updates.checklist = parseChecklist(body.checklist);
  if (body.column && COMMAND_COLUMNS.has(body.column)) updates.column = body.column;
  if (body.status && COMMAND_STATUS_SET.has(body.status as CommandTaskStatus)) {
    updates.status = body.status as CommandTaskStatus;
    updates.previousStatus = undefined;
  }
  if (body.color && COMMAND_COLORS.has(body.color)) updates.color = body.color;
  if (typeof body.recurring === "boolean") updates.recurring = body.recurring;
  const recurringInterval = parseRecurringInterval(body.recurringInterval);
  if (recurringInterval) {
    updates.recurringInterval = recurringInterval;
  }
  if (typeof body.assignedTo === "string") updates.assignedTo = body.assignedTo;
  if (typeof body.dueDate === "string") updates.dueDate = body.dueDate.slice(0, 10);
  if ("dueTime" in body) updates.dueTime = parseDueTime(body.dueTime);
  if ("reminderMinutes" in body) updates.reminderMinutes = parseReminderMinutes(body.reminderMinutes);
  if (Number.isFinite(Number((body as Record<string, unknown>).sortOrder))) {
    updates.sortOrder = Number((body as Record<string, unknown>).sortOrder);
  }
  if (Array.isArray(body.tags)) {
    updates.tags = body.tags.filter((t): t is string => typeof t === "string");
  }
  if (typeof (body as Record<string, unknown>).contentSlotId === "string") {
    updates.contentSlotId = String((body as Record<string, unknown>).contentSlotId) || undefined;
  }
  const before = getCommandTasks().find((t) => t.id === id);
  const prevAssignee = before?.assignedTo;
  const task = updateCommandTask(id, updates);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  /*
   * Recurrence, which until now was a flag that did nothing. `recurring` and
   * `recurringInterval` have been stored and round-tripped since the task board
   * was built, but no code ever acted on them: marking a weekly task done just
   * ended it. Completing one now spawns the next instance, dated one interval
   * on from the due date it actually had (falling back to today when it had
   * none). Deliberately narrow: it fires only on the pending -> done edge, so
   * re-saving an already-done task cannot mint duplicates, and the new task is
   * created through the same createCommandTask path as any other.
   */
  let recurredTask: CommandTask | null = null;
  if (
    task.recurring &&
    task.recurringInterval &&
    task.status === "done" &&
    before &&
    before.status !== "done"
  ) {
    recurredTask = spawnNextRecurrence(task);
  }
  // Reassignment notifies — and emails — the new assignee, same as a fresh
  // assignment: being handed an existing task is still being handed a task.
  if (updates.assignedTo && updates.assignedTo !== prevAssignee && task.createdBy !== updates.assignedTo) {
    try {
      addNotification({
        user: updates.assignedTo,
        type: "assignment",
        title: `${task.createdBy || "A teammate"} assigned you a task`,
        body: task.title + (task.dueDate ? ` — due ${task.dueDate}${task.dueTime ? " " + task.dueTime : ""}` : ""),
        taskId: task.id,
        from: task.createdBy,
      });
    } catch (err) { console.error("[team] reassignment notification failed:", err); }
    void sendAssignmentEmail(task, task.createdBy);
  }
  console.log("[Tasks] Updated:", task.title, "status:", task.status, "column:", task.column);
  res.json({ task, recurred: recurredTask });
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

/* ——— Web Push: always-on task reminders ———
   The browser subscribes with the VAPID public key; the server delivers push
   notifications at each task's reminder moments even when the app is closed. */
app.get("/api/push/public-key", (_req, res) => {
  try {
    res.json({ publicKey: getVapidPublicKey() });
  } catch (err) {
    console.error("[push] public-key error:", err);
    res.status(500).json({ error: "push unavailable" });
  }
});

app.post("/api/push/subscribe", express.json({ limit: "64kb" }), (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const sub = (body.subscription && typeof body.subscription === "object"
    ? body.subscription
    : body) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const person = typeof body.person === "string" ? body.person.toLowerCase() : "everyone";
  const ok = addSubscription(sub, person);
  if (!ok) {
    res.status(400).json({ error: "Invalid subscription" });
    return;
  }
  console.log("[push] subscribed:", person);
  res.json({ success: true });
});

app.post("/api/push/unsubscribe", express.json({ limit: "64kb" }), (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  if (!endpoint) {
    res.status(400).json({ error: "endpoint required" });
    return;
  }
  removeSubscription(endpoint);
  res.json({ success: true });
});

/* ——— Scheduled sending (3.2): queue a text or email for later ———
   Two ways in — the user picks a time in the CRM, or Harvey queues it from a
   plain-language time. Both land in the same queue and the same sender. */

/** Resolve the destination for a channel, so callers never guess. */
async function resolveScheduleTarget(
  leadId: string,
  channel: ScheduledChannel,
): Promise<{ to: string; name: string } | { error: string }> {
  const lead = await getLeadById(leadId);
  if (!lead) return { error: "Lead not found" };
  const name = lead.name || lead.username || "Lead";
  if (channel === "sms") {
    if (!lead.phone) return { error: `${name} has no phone number on file` };
    return { to: lead.phone, name };
  }
  if (!lead.email) return { error: `${name} has no email address on file` };
  return { to: lead.email, name };
}

app.get("/api/scheduled", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const leadId = typeof req.query.leadId === "string" ? req.query.leadId : undefined;
  res.json({
    messages: listScheduled({
      status: status as never,
      leadId,
      limit: Number(req.query.limit) || 200,
    }),
    counts: scheduledCounts(),
    // Surfaced so the UI can warn BEFORE queueing into a channel that can't
    // deliver, rather than letting it fail silently an hour later.
    capability: { sms: await canSendOn("sms"), email: await canSendOn("email") },
  });
});

app.post("/api/scheduled", express.json({ limit: "256kb" }), async (req, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const leadId = String(b.leadId || "").trim();
  const channel = b.channel === "email" ? "email" : "sms";
  const body = String(b.body || "").trim();
  if (!leadId || !body) {
    res.status(400).json({ error: "leadId and body are required" });
    return;
  }

  // Accept either an explicit ISO instant or plain language ("Tuesday
  // morning"). Ambiguous phrasing is rejected rather than guessed — the cost
  // of a wrong guess is a real text to a real client at the wrong hour.
  const when = String(b.sendAt || b.when || "").trim();
  const parsed = when ? parseSendTime(when) : suggestNextGoodTime();
  if (!parsed) {
    res.status(400).json({
      error: `Couldn't understand the send time "${when}"`,
      hint: 'Try "tomorrow at 9am", "Tuesday morning", "in 2 hours", or an exact date.',
    });
    return;
  }

  const target = await resolveScheduleTarget(leadId, channel);
  if ("error" in target) {
    res.status(400).json({ error: target.error });
    return;
  }

  const msg = scheduleMessage({
    leadId,
    leadName: target.name,
    channel,
    to: target.to,
    subject: typeof b.subject === "string" ? b.subject : undefined,
    body,
    sendAt: parsed.sendAt,
    createdBy: typeof b.createdBy === "string" ? b.createdBy : "marco",
    requestedTime: when || undefined,
  });

  const capability = await canSendOn(channel);
  res.json({
    message: msg,
    interpreted: parsed.interpreted,
    // Queued is not the same as deliverable. Say so up front.
    warning: capability.ok ? undefined : capability.reason,
  });
});

/**
 * Dry-run a send time. Writes nothing — it exists so the composer can echo
 * "Sends Tue, Aug 4, 9:00 AM CDT" while you type, using the SAME parser the
 * real queue uses. Finding out how a phrase was read by having a client
 * receive a text at the wrong hour is not an acceptable feedback loop.
 */
app.post("/api/scheduled/preview", express.json({ limit: "16kb" }), async (req, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const when = String(b.when || "").trim();
  const channel: ScheduledChannel = b.channel === "email" ? "email" : "sms";
  const parsed = when ? parseSendTime(when) : suggestNextGoodTime();
  if (!parsed) {
    res.json({
      ok: false,
      error: `Couldn't read "${when}" — try "tomorrow at 9am" or "Tuesday morning".`,
    });
    return;
  }
  const capability = await canSendOn(channel);
  res.json({
    ok: true,
    sendAt: parsed.sendAt,
    interpreted: parsed.interpreted,
    warning: capability.ok ? undefined : capability.reason,
  });
});

app.delete("/api/scheduled/:id", (req, res) => {
  const ok = cancelScheduled(String(req.params.id || ""));
  if (!ok) {
    res.status(404).json({ error: "Not found, or it already went out" });
    return;
  }
  res.json({ canceled: true });
});

app.patch("/api/scheduled/:id", express.json({ limit: "64kb" }), (req, res) => {
  const when = String((req.body || {}).sendAt || (req.body || {}).when || "").trim();
  const parsed = when ? parseSendTime(when) : null;
  if (!parsed) {
    res.status(400).json({ error: `Couldn't understand the send time "${when}"` });
    return;
  }
  if (!rescheduleMessage(String(req.params.id || ""), parsed.sendAt)) {
    res.status(404).json({ error: "Not found, or it already went out" });
    return;
  }
  res.json({ message: getScheduled(String(req.params.id)), interpreted: parsed.interpreted });
});

/* ——— 3.3 AI suggested replies ———
   Suggestion only: neither endpoint sends anything. The draft lands in the
   composer and a human decides. Both read the contact's whole record, not
   just the last message. */

app.post("/api/leads/:id/suggest-reply", express.json({ limit: "64kb" }), async (req, res) => {
  const lead = await getLeadById(String(req.params.id || "").trim());
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const b = (req.body || {}) as Record<string, unknown>;
  try {
    const out = await suggestReply(lead, {
      channel: b.channel === "email" ? "email" : "sms",
      draft: typeof b.draft === "string" ? b.draft : undefined,
    });
    res.json(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[suggest-reply] failed:", message);
    // Say what actually broke — a silent empty suggestion looks like the
    // model had nothing to say, which is a very different problem from the
    // API key being unset.
    res.status(502).json({ error: message });
  }
});

app.post("/api/leads/:id/complete-reply", express.json({ limit: "64kb" }), async (req, res) => {
  const lead = await getLeadById(String(req.params.id || "").trim());
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const b = (req.body || {}) as Record<string, unknown>;
  const draft = typeof b.draft === "string" ? b.draft : "";
  try {
    const completion = await completeReply(lead, draft, {
      channel: b.channel === "email" ? "email" : "sms",
    });
    res.json({ completion });
  } catch (err) {
    // Ghost text is an enhancement; if it fails the user just keeps typing.
    // Never surface an error dialog for a prediction nobody asked for.
    console.error("[complete-reply] failed:", err);
    res.json({ completion: "" });
  }
});

/**
 * Draft for a thread with no linked lead (group threads, demo rows).
 * Refusing these was wrong — the conversation itself is the most useful
 * input, and it's already on screen. Degraded but genuinely useful.
 */
app.post("/api/suggest-reply", express.json({ limit: "256kb" }), async (req, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const messages = Array.isArray(b.messages)
    ? (b.messages as unknown[])
        .map((m) => {
          const x = (m || {}) as Record<string, unknown>;
          return {
            role: x.role === "assistant" ? "assistant" : "user",
            text: String(x.text || ""),
            at: String(x.at || ""),
          };
        })
        .filter((m) => m.text.trim())
    : [];
  if (!messages.length) {
    res.status(400).json({ error: "Nothing to work from — this conversation has no messages." });
    return;
  }
  try {
    res.json(
      await suggestReplyFromThread(String(b.contactName || ""), messages as never, {
        channel: b.channel === "email" ? "email" : "sms",
        draft: typeof b.draft === "string" ? b.draft : undefined,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[suggest-reply/thread] failed:", message);
    res.status(502).json({ error: message });
  }
});

app.post("/api/complete-reply", express.json({ limit: "256kb" }), async (req, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const messages = Array.isArray(b.messages)
    ? (b.messages as unknown[])
        .map((m) => {
          const x = (m || {}) as Record<string, unknown>;
          return {
            role: x.role === "assistant" ? "assistant" : "user",
            text: String(x.text || ""),
            at: String(x.at || ""),
          };
        })
        .filter((m) => m.text.trim())
    : [];
  try {
    const completion = await completeReplyFromThread(
      String(b.contactName || ""),
      messages as never,
      typeof b.draft === "string" ? b.draft : "",
      { channel: b.channel === "email" ? "email" : "sms" },
    );
    res.json({ completion });
  } catch (err) {
    // Ghost text is an enhancement; failing silently is correct here.
    console.error("[complete-reply/thread] failed:", err);
    res.json({ completion: "" });
  }
});

/* ——— 3.4 Knowledge Center: SOPs + internal documentation ———
   Same documents back this API and Harvey's knowledge tools, so answers and
   the page can never disagree. */

app.get("/api/knowledge", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q) {
    res.json({ query: q, results: searchDocs(q, 10), categories: listCategories() });
    return;
  }
  res.json({
    docs: listDocs(typeof req.query.category === "string" ? req.query.category : undefined)
      .map(({ body, ...rest }) => ({ ...rest, excerpt: body.replace(/[#*`]/g, "").replace(/\s+/g, " ").trim().slice(0, 160) })),
    categories: listCategories(),
    stats: knowledgeStats(),
  });
});

app.get("/api/knowledge/:id", (req, res) => {
  const doc = getDoc(String(req.params.id || ""));
  if (!doc) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ doc });
});

app.post("/api/knowledge", express.json({ limit: "1mb" }), (req, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const title = String(b.title || "").trim();
  const body = String(b.body || "");
  if (!title || !body.trim()) { res.status(400).json({ error: "title and body are required" }); return; }
  res.json({
    doc: createDoc({
      title, body,
      category: typeof b.category === "string" ? b.category : undefined,
      tags: Array.isArray(b.tags) ? (b.tags as string[]) : [],
      updatedBy: typeof b.updatedBy === "string" ? b.updatedBy : undefined,
    }),
  });
});

app.patch("/api/knowledge/:id", express.json({ limit: "1mb" }), (req, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const doc = updateDoc(String(req.params.id || ""), {
    title: typeof b.title === "string" ? b.title : undefined,
    body: typeof b.body === "string" ? b.body : undefined,
    category: typeof b.category === "string" ? b.category : undefined,
    tags: Array.isArray(b.tags) ? (b.tags as string[]) : undefined,
    updatedBy: typeof b.updatedBy === "string" ? b.updatedBy : undefined,
  });
  if (!doc) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ doc });
});

app.delete("/api/knowledge/:id", (req, res) => {
  if (!deleteDoc(String(req.params.id || ""))) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ deleted: true });
});

app.get("/knowledge", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "knowledge.html"));
});

/* ——— 5. Social analytics ———
   Per-platform metrics plus a combined roll-up. TikTok is live from the
   existing Apify pull; the other platforms report `not_connected` until
   ZERNIO_API_KEY is set. Nothing here fabricates a number. */

app.get("/api/analytics/social", async (_req, res) => {
  try {
    res.json(await getSocialAnalytics());
  } catch (err) {
    console.error("[analytics] failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/analytics", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(publicDir, "analytics.html"));
});

/* ——— 1.2 Browser control: the extension's endpoints ———
   The extension polls; the server never reaches into a browser. Both routes
   authenticate on the pairing token and fail closed when it isn't set. */

app.post("/api/browser/poll", express.json({ limit: "64kb" }), async (req, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  /* Which ACCOUNT this token belongs to, not merely whether it is valid: the
     device is filed under that account and can only ever be driven from it. */
  const account = browserAccountForToken(String(b.token || ""));
  if (!account) {
    res.status(401).json({ error: "Bad or missing pairing token" });
    return;
  }
  const page = (b.page && typeof b.page === "object" ? b.page : {}) as { url?: string; title?: string };
  // The extension asks the server to hold the request open until there's
  // something to do. Without a waitMs this behaves exactly as before, so an
  // older extension build keeps working against a newer server.
  const result = await recordBrowserPoll(b.enabled === true, page, {
    account,
    waitMs: Number(b.waitMs) || 0,
    armLock: typeof b.armLock === "boolean" ? b.armLock : undefined,
    deviceId: typeof b.deviceId === "string" ? b.deviceId : undefined,
    deviceName: typeof b.deviceName === "string" ? b.deviceName : undefined,
    onAbort: (cancel) => {
      // A parked poll whose client hung up (laptop slept, wifi dropped) must
      // not keep a timer and a resolver alive for the full window.
      req.on("close", () => { if (!res.writableEnded) cancel(); });
    },
  });
  if (res.writableEnded) return;
  res.json(result);
});

// 6mb, not the old 1mb: a screenshot rides back in this body as base64 and a
// dense page can clear a megabyte on its own.
app.post("/api/browser/result", express.json({ limit: "6mb" }), (req, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  if (!browserTokenMatches(String(b.token || ""))) {
    res.status(401).json({ error: "Bad or missing pairing token" });
    return;
  }
  const accepted = submitBrowserResult({
    id: String(b.id || ""),
    ok: b.ok === true,
    data: b.data,
    error: typeof b.error === "string" ? b.error : undefined,
    url: typeof b.url === "string" ? b.url : undefined,
    title: typeof b.title === "string" ? b.title : undefined,
    meta: b.meta && typeof b.meta === "object" ? (b.meta as Record<string, unknown>) : undefined,
    image: b.image && typeof b.image === "object"
      ? (b.image as { media_type: string; data: string })
      : undefined,
  });
  res.json({ accepted });
});

/** Status for the popup and for the app UI. Token-gated: it reveals the URL
 *  of whatever tab the operator is looking at. */
/**
 * Operator command endpoint: run one browser action and wait for its result.
 *
 * Exists because the bus was previously only drivable from inside Harvey's
 * agent loop — fine for chat, useless for an operator (or an operator's agent)
 * doing precise, step-at-a-time work like editing a third-party dashboard,
 * where each next click depends on reading the last screenshot rather than on
 * an LLM's paraphrase of it.
 *
 * Gated on the SAME pairing token as the bus itself: whoever holds that token
 * already controls the paired browser by definition (they could impersonate
 * the extension via /poll + /result), so this adds capability for the token
 * holder and attack surface for nobody.
 */
app.post("/api/browser/command", express.json({ limit: "256kb" }), async (req, res) => {
  const token = String(req.get("X-Browser-Token") || req.query.token || "");
  const cmdAccount = browserAccountForToken(token);
  if (!cmdAccount) {
    res.status(401).json({ error: "Bad or missing pairing token" });
    return;
  }
  const b = (req.body || {}) as { command?: Record<string, unknown>; device?: string; timeoutMs?: number };
  if (!b.command || typeof b.command !== "object" || typeof b.command.action !== "string") {
    res.status(400).json({ error: "Body must be { command: { action, ... }, device?, timeoutMs? }" });
    return;
  }
  try {
    const result = await runBrowserCommandDirect(
      b.command as Parameters<typeof runBrowserCommandDirect>[0],
      {
        device: typeof b.device === "string" && b.device ? b.device : undefined,
        account: cmdAccount.id,
        timeoutMs: Math.min(Math.max(Number(b.timeoutMs) || 30_000, 5_000), 120_000),
      },
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Talk to Harvey from the extension's side panel.
 *
 * This is the same Harvey as `/api/jarvis/chat` — same brain, same tools, same
 * memory — reached with the PAIRING token instead of the dashboard token, so
 * the extension needs exactly one secret and the person installing it never
 * has to be handed a second one.
 *
 * Two things it does that the dashboard route cannot:
 *   - Every browser action Harvey takes during the turn is scoped to the
 *     account that owns this token, so Carlos asking Harvey to open a listing
 *     drives Carlos's browser and never Marco's.
 *   - The conversation is keyed per account AND per browser, so two people
 *     talking to Harvey at the same time hold two separate threads.
 */
app.post("/api/browser/chat", express.json({ limit: "256kb" }), async (req, res) => {
  const token = String(req.get("X-Browser-Token") || req.query.token || "");
  const account = browserAccountForToken(token);
  if (!account) {
    res.status(401).json({ configured: browserControlConfigured(), error: "Bad or missing pairing token" });
    return;
  }
  const b = (req.body || {}) as Record<string, unknown>;
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "Missing message" });
    return;
  }
  const deviceId = typeof b.deviceId === "string" && b.deviceId.trim() ? b.deviceId.trim() : "panel";
  /* Session id carries the account so two people never share a thread, and
     the device so the same person's laptop and desktop stay separate. */
  const sessionId = `ext-${account.id}-${deviceId}`.slice(0, 128);

  try {
    const result = await withBrowserAccount(account.id, () =>
      runHarveyChat({
        message,
        sessionId,
        deps: harveyDeps(),
        fullMode: true,
      }),
    );
    res.json({
      speech: result.speech,
      sessionId: result.sessionId,
      account: { id: account.id, name: account.name },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[browser/chat]", msg);
    res.status(500).json({ error: msg });
  }
});

/**
 * MLS feed health. Ungated like /api/browser/status's configuration half: it
 * exposes whether a feed is connected and how stale it is, never listing data.
 */
/* ── Luxury content shortlist: the rolling 5–7 $1M+ homes worth filming ─── */
app.get("/api/luxury/shortlist", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { getLuxuryShortlist } = await import("./agents/luxuryContent/index.js");
  res.json(getLuxuryShortlist());
});

app.post("/api/luxury/run", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { runLuxurySweep } = await import("./agents/luxuryContent/index.js");
  const result = await runLuxurySweep();
  res.status(result.error && !result.candidatesSeen ? 422 : 200).json(result);
});

/** Operator verdicts: filmed and dismissed never resurface; shortlist/candidate restore. */
app.post("/api/luxury/:key/status", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const status = String((req.body as Record<string, unknown>)?.status || "");
  if (!["filmed", "dismissed", "shortlist", "candidate"].includes(status)) {
    res.status(400).json({ error: "status must be filmed, dismissed, shortlist, or candidate" });
    return;
  }
  const { setLuxuryStatus } = await import("./agents/luxuryContent/index.js");
  const ok = setLuxuryStatus(String(req.params.key || ""), status as "filmed" | "dismissed" | "shortlist" | "candidate");
  if (!ok) {
    res.status(404).json({ error: "No luxury candidate with that listing key" });
    return;
  }
  res.json({ ok: true });
});

app.get("/api/mls/status", async (_req, res) => {
  const { mlsStatus } = await import("./agents/mlsSync/index.js");
  res.json(mlsStatus());
});

/** Prove the credentials by actually calling SimplyRETS, not by checking env vars. */
app.get("/api/mls/ping", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { mlsPing } = await import("./integrations/simplyrets/index.js");
  res.json(await mlsPing());
});

app.post("/api/mls/sync", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { runMlsSync } = await import("./agents/mlsSync/index.js");
  res.json(await runMlsSync());
});

app.get("/api/mls/listings", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { searchListings } = await import("./core/listingsStore.js");
  const q = req.query as Record<string, string | undefined>;
  res.json(
    searchListings({
      q: q.q,
      city: q.city,
      status: q.status,
      propertyType: q.propertyType,
      minPrice: q.minPrice ? Number(q.minPrice) : undefined,
      maxPrice: q.maxPrice ? Number(q.maxPrice) : undefined,
      minBeds: q.minBeds ? Number(q.minBeds) : undefined,
      minBaths: q.minBaths ? Number(q.minBaths) : undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    }),
  );
});

/**
 * One listing, in full, for the detail page behind a click in the MLS tab.
 *
 * The search endpoint returns the card-sized subset (one photo, price, specs).
 * A detail view needs the rest, and the rest is already on disk: the sync
 * stores the whole SimplyRETS payload in `raw`, so every photo, the school
 * district, the HOA line and the remarks are there without a second API call
 * to the feed. This reads them out rather than re-fetching, which is what
 * makes the page open instantly and still work while the feed is down.
 *
 * `raw` itself is deliberately NOT returned. It carries fields this app has no
 * license to redisplay and would grow the response tenfold; the endpoint picks
 * out the parts the page actually renders and names them.
 */
app.get("/api/mls/listing/:key", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { getListing } = await import("./core/listingsStore.js");
  const key = String(req.params.key || "").trim();
  if (!key) {
    res.status(400).json({ error: "Missing listing key" });
    return;
  }
  const found = getListing(key);
  if (!found) {
    /* 404 rather than an empty shell: a listing that fell out of the feed
       (sold, withdrawn, expired) is a different thing from one with no photos,
       and the page says so instead of rendering a blank card. */
    res.status(404).json({ error: "That listing is no longer in the feed." });
    return;
  }
  const { raw, ...listing } = found;
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const prop = (p.property && typeof p.property === "object" ? p.property : {}) as Record<string, unknown>;
  const geo = (p.geo && typeof p.geo === "object" ? p.geo : {}) as Record<string, unknown>;
  const school = (p.school && typeof p.school === "object" ? p.school : {}) as Record<string, unknown>;
  const agent = (p.agent && typeof p.agent === "object" ? p.agent : {}) as Record<string, unknown>;
  const photos = Array.isArray(p.photos) ? p.photos.filter((x): x is string => typeof x === "string") : [];

  const s = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const t = String(v).trim();
    return t ? t : null;
  };
  const n = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };

  res.json({
    ...listing,
    /* Every photo, not just the cover. Capped: some listings carry 60+ and the
       page lazy-loads anyway, but an unbounded array is an unbounded response. */
    photos: photos.slice(0, 60),
    detail: {
      garage: n(prop.garageSpaces),
      stories: n(prop.stories),
      pool: s(prop.pool),
      heating: s(prop.heating),
      cooling: s(prop.cooling),
      roof: s(prop.roof),
      style: s(prop.style),
      construction: s(prop.construction),
      flooring: s(prop.flooring),
      laundry: s(prop.laundryFeatures),
      interiorFeatures: s(prop.interiorFeatures),
      exteriorFeatures: s(prop.exteriorFeatures),
      subType: s(prop.subType),
      area: s(prop.area),
      acres: n(prop.acres),
      taxes: n(p.tax && typeof p.tax === "object" ? (p.tax as Record<string, unknown>).taxAnnualAmount : null),
      taxYear: n(p.tax && typeof p.tax === "object" ? (p.tax as Record<string, unknown>).taxYear : null),
      schoolDistrict: s(school.district),
      elementary: s(school.elementarySchool),
      middle: s(school.middleSchool),
      high: s(school.highSchool),
      lat: n(geo.lat),
      lng: n(geo.lng),
      county: s(geo.county),
      agentPhone: s(agent.contact),
      daysOnMarket: n(p.mls && typeof p.mls === "object" ? (p.mls as Record<string, unknown>).daysOnMarket : null),
    },
  });
});

/**
 * Live MLS context for one lead, for the CRM profile drawer.
 *
 * Three separate things, kept separate on purpose:
 *   `listing`     — the property we are CERTAIN they asked about, read live, so
 *                   a price cut or a move to Pending shows in the drawer rather
 *                   than in a stale field somebody typed weeks ago.
 *   `suggestions` — active homes fitting their criteria. Explicitly NOT theirs.
 *   `market`      — inventory for their city. Asking prices only; this feed has
 *                   no solds, and the UI has to say so.
 *
 * `source: "linked" | "matched" | "none"` is returned so the drawer can show
 * where the property came from. A match derived from free text is a different
 * claim from one an agent confirmed, and collapsing the two would make a wrong
 * match invisible.
 */
app.get("/api/leads/:id/mls", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { isMlsFeedConfigured } = await import("./integrations/simplyrets/index.js");
  if (!isMlsFeedConfigured()) {
    res.json({ configured: false, listing: null, source: "none", suggestions: [], market: null });
    return;
  }
  const { findLeadById } = await import("./core/db.js");
  const lead = await findLeadById(String(req.params.id));
  if (!lead) {
    res.status(404).json({ error: "No such lead" });
    return;
  }
  const { liveListingForLead, listingsForCriteria, marketForLead } = await import(
    "./core/listingMatch.js"
  );
  try {
    const { listing, source } = liveListingForLead(lead);
    /* `getListing` carries the untouched SimplyRETS record — several KB of
       agent phone numbers, HOA fields and remarks per lead. The drawer shows
       an address, a price and a status, so send that. */
    const slim = (l: NonNullable<typeof listing>) => ({
      listingKey: l.listingKey,
      mlsNumber: l.mlsNumber,
      status: l.status,
      listPrice: l.listPrice,
      street: l.street,
      city: l.city,
      beds: l.beds,
      baths: l.baths,
      livingArea: l.livingArea,
    });
    res.json({
      configured: true,
      listing: listing ? slim(listing) : null,
      source,
      suggestions: listingsForCriteria(lead, 3).map(slim),
      market: marketForLead(lead),
    });
  } catch (err) {
    /* The drawer must still open if the mirror is mid-write or missing. */
    console.error("[LeadMLS] lookup failed:", err);
    res.status(500).json({ error: "MLS lookup failed" });
  }
});

app.get("/api/browser/status", (req, res) => {
  const token = String(req.get("X-Browser-Token") || req.query.token || "");
  const account = browserAccountForToken(token);
  if (!account) {
    // Configuration state is safe to expose unauthenticated; the live page is not.
    res.status(401).json({ configured: browserControlConfigured(), error: "Bad or missing pairing token" });
    return;
  }
  /* Scoped to the caller's own account: someone holding Carlos's token must
     not be able to enumerate Marco's machines or see what page he is on. */
  res.json({
    ...browserStatus(account.id),
    account: { id: account.id, name: account.name },
    recent: recentBrowserActivity(10),
  });
});

/**
 * Download the extension as a folder you can actually point Chrome at.
 *
 * "Load unpacked" needs a real directory on the operator's own machine, and
 * the source only ever existed in the repo — cloning it is not a reasonable
 * first step for the person installing this. So the server hands back the
 * same files it ships with, zipped.
 *
 * Deliberately ungated: it contains no secrets. The pairing token is typed in
 * afterwards, and without it the extension can do nothing at all. Gating this
 * behind auth would only mean the person installing it can't get it.
 */
const extensionDir = path.join(publicDir, "extension");

function collectExtensionFiles(dir: string, prefix = ""): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...collectExtensionFiles(full, rel));
    else if (entry.isFile()) out.push({ name: rel, data: fs.readFileSync(full) });
  }
  return out;
}

app.get("/api/browser/extension.zip", (_req, res) => {
  try {
    const files = collectExtensionFiles(extensionDir);
    if (!files.length) throw new Error("extension folder is empty");
    // Sanity-check rather than shipping a zip that Chrome will reject with an
    // unhelpful error — a missing manifest is the one failure worth naming.
    // Flat entries, no wrapping folder: both Windows "Extract All" and macOS
    // Archive Utility then create one folder named after the zip with
    // manifest.json directly inside — which is exactly what Load unpacked wants.
    if (!files.some((f) => f.name === "manifest.json")) throw new Error("manifest.json missing");
    const zip = buildZip(files);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="harvey-browser-control.zip"');
    res.setHeader("Content-Length", String(zip.length));
    res.end(zip);
  } catch (e) {
    console.error("[browser] extension zip failed:", e);
    res.status(500).json({ error: "Could not build the extension download: " + (e as Error).message });
  }
});

/**
 * Test-only hook for driving a platform tool over HTTP.
 *
 * The browser-control queue is in-process memory, so a test can't call the
 * tool from outside the server and still share the bus with the extension's
 * poll/result endpoints. This exists so the extension can be verified against
 * the REAL endpoints rather than a re-implementation of them.
 *
 * Gated on BROWSER_CONTROL_TEST_HOOK, which is never set in production — if
 * it's unset the route is not registered at all, so there is no surface.
 */
if (process.env.BROWSER_CONTROL_TEST_HOOK === "1") {
  console.warn("[test] platform-tool HTTP hook is ENABLED — this must never be on in production");
  app.post("/__test/tool", express.json({ limit: "256kb" }), async (req, res) => {
    const b = (req.body || {}) as { tool?: string; input?: Record<string, unknown> };
    try {
      /* Route through the HULL dispatcher, not the platform one: it is the
         entry point Harvey actually uses, and it is where web_search and
         read_web_page live. Testing a narrower path than production runs is
         how a tool passes its tests and fails in the operator's hands. */
      const { executeHullTool } = await import("./hull/tools.js");
      res.json(await executeHullTool(String(b.tool || ""), b.input || {}));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/* ——— Team collaboration: notifications, chat, presence (task command center) ——— */

/** Who can sign in. Email addresses are intentionally omitted — see teamRoster.ts. */
app.get("/api/team/roster", (_req, res) => {
  res.json({ members: listTeamMembers() });
});

app.get("/api/team/notifications", (req, res) => {
  const user = String(req.query.user || "").toLowerCase();
  if (!user) { res.status(400).json({ error: "user required" }); return; }
  touchPresence(user);
  res.json({ notifications: getNotifications(user), presence: getPresence(), unreadChats: chatUnreadCounts(user) });
});

app.post("/api/team/notifications/read", express.json({ limit: "64kb" }), (req, res) => {
  const body = (req.body || {}) as { user?: string; ids?: string[] };
  if (!body.user) { res.status(400).json({ error: "user required" }); return; }
  res.json({ marked: markNotificationsRead(body.user, body.ids) });
});

app.get("/api/team/chat", (req, res) => {
  const me = String(req.query.me || "").toLowerCase();
  const withUser = String(req.query.with || "").toLowerCase();
  if (!me || !withUser) { res.status(400).json({ error: "me and with required" }); return; }
  touchPresence(me);
  res.json({ messages: getChat(me, withUser) });
});

app.post("/api/team/chat", express.json({ limit: "64kb" }), (req, res) => {
  const body = (req.body || {}) as { from?: string; to?: string; text?: string };
  if (!body.from || !body.to || !String(body.text || "").trim()) {
    res.status(400).json({ error: "from, to, text required" });
    return;
  }
  touchPresence(body.from);
  res.json({ message: addChatMessage(body.from, body.to, String(body.text).trim()) });
});

app.post("/api/team/chat/read", express.json({ limit: "64kb" }), (req, res) => {
  const body = (req.body || {}) as { me?: string; with?: string };
  if (!body.me || !body.with) { res.status(400).json({ error: "me and with required" }); return; }
  res.json({ marked: markChatRead(body.me, body.with) });
});

app.get("/api/team/presence", (_req, res) => {
  res.json({ presence: getPresence() });
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
  void (async () => {
    /* A contingent task arrives with a RULE and no date. Resolve it here so
       everything downstream — the board, the reminder engine, the deadline
       sweep — still sees an ordinary dated task. */
    const extras = taskExtras(body);
    if (extras.contingent && !(typeof body.dueDate === "string" && body.dueDate.trim())) {
      const leadId = typeof body.leadId === "string" ? body.leadId.trim() : undefined;
      const resolved = await resolveTaskContingency(leadId, extras.contingent);
      if (!resolved.dueDate) {
        res.status(400).json({ error: resolved.reason || "That contingent rule cannot be dated." });
        return;
      }
      body.dueDate = resolved.dueDate;
    }
    const data = normalizeTaskInput(body);
    if (!data) {
      res.status(400).json({ error: "Missing title or dueDate" });
      return;
    }
    const task = createTask(data);
    res.status(201).json({ task });
  })();
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
  if (TASK_STATUSES.has(body.status as TaskStatus)) {
    updates.status = body.status as TaskStatus;
    updates.previousStatus = undefined;
  }
  if (TASK_TYPES.has(body.type as TaskType)) updates.type = body.type as TaskType;
  if (typeof body.leadId === "string") updates.leadId = body.leadId.trim() || undefined;
  if (typeof body.leadName === "string") updates.leadName = body.leadName;
  if (typeof body.assignedUserId === "string") updates.assignedUserId = body.assignedUserId;
  if (typeof body.assignedUserName === "string") updates.assignedUserName = body.assignedUserName;
  if (typeof body.reminderMinutes === "number") updates.reminderMinutes = body.reminderMinutes;
  // Same extras as the POST, so an edit cannot quietly drop what a create kept.
  Object.assign(updates, taskExtras(body));
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
  const dealId = String(req.params.id || "").trim();
  const ok = deleteDeal(dealId);
  if (!ok) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }
  const actor = await currentSessionUser(req);
  const { recordAudit } = await import("./core/authStore.js");
  recordAudit({ userId: actor?.id, userName: actor?.name, action: "deal.delete", detail: dealId, req });
  res.status(200).json({ ok: true });
});

/* ===================== Transactions (SQLite) ===================== */

function parseTransactionBody(body: Record<string, unknown>): Partial<Transaction> {
  const out: Partial<Transaction> = {};
  if (typeof body.address === "string") out.address = body.address.trim();
  if (typeof body.dealType === "string" && TX_DEAL_TYPES.has(body.dealType)) out.dealType = body.dealType as Transaction["dealType"];
  if (body.parties && typeof body.parties === "object" && !Array.isArray(body.parties)) {
    out.parties = body.parties as Transaction["parties"];
  }
  if (typeof body.price === "number") out.price = body.price;
  if (typeof body.status === "string" && TX_STATUSES.has(body.status)) out.status = body.status as Transaction["status"];
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
  /* The Brivity-carried fields the CRM's inline editor writes back. `null`
     clears (an expiration that was renegotiated away must be deletable), a
     missing key leaves the stored value alone. */
  if (typeof body.mls === "string") out.mls = body.mls.trim() || undefined;
  if (typeof body.agent === "string") out.agent = body.agent.trim() || undefined;
  if (typeof body.listPrice === "number") out.listPrice = body.listPrice;
  if (typeof body.gci === "number") out.gci = body.gci;
  if (typeof body.expiration === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.expiration)) out.expiration = body.expiration;
  if (body.expiration === null) out.expiration = undefined;
  /* Brivity transaction-page dates — same contract as expiration: valid ISO
     sets, null clears, absent leaves alone. */
  for (const k of ["dateListed", "dateCanceled", "depositDue", "additionalDepositDue", "escrowSigningDate"] as const) {
    const v = body[k];
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) out[k] = v;
    if (v === null) out[k] = undefined;
  }
  if (typeof body.source === "string") out.source = body.source.trim() || undefined;
  return out;
}

const TX_DEAL_TYPES = new Set(["buyer", "seller", "dual", "tenant", "landlord", "referral"]);
const TX_STATUSES = new Set([
  "active", "under_contract", "pending", "closed", "fell_through", "cancelled",
  "pipeline", "coming_soon", "expired", "withdrawn", "archived",
]);

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
    mls: parsed.mls,
    agent: parsed.agent,
    listPrice: parsed.listPrice,
    gci: parsed.gci,
    source: parsed.source,
    expiration: parsed.expiration,
    dateListed: parsed.dateListed,
    dateCanceled: parsed.dateCanceled,
    depositDue: parsed.depositDue,
    additionalDepositDue: parsed.additionalDepositDue,
    escrowSigningDate: parsed.escrowSigningDate,
  });
  res.status(201).json({ transaction: tx });
});

/**
 * When the transaction data was last refreshed, and from what.
 *
 * Registered BEFORE `/api/transactions/:id` — Express matches in order, and
 * otherwise "import-status" is read as a transaction id and 404s.
 */
app.get("/api/transactions/import-status", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const all = getAllTransactions();
  const last = getLastTransactionImport();
  const imported = all.filter((t) => !!t.importedAt).length;
  res.json({
    ok: true,
    total: all.length,
    imported,
    manual: all.length - imported,
    lastImport: last,
    /* Stated rather than implied: Brivity exposes no transaction API, so this
       data is only ever as fresh as the last export somebody uploaded. */
    live: false,
    note: last
      ? `Last imported ${last.importedAt} from ${last.filename || "a CSV"}.`
      : "No import has ever run — any transactions here were entered by hand.",
  });
});

/**
 * Run the staleness check on demand. The scheduler already runs it twice a day;
 * this exists so the reminder can be tested, and so Harvey can be asked
 * "is the transaction data due a refresh?" without waiting for a tick.
 */
app.post("/api/transactions/import-reminder/run", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  try {
    res.json({ ok: true, ...checkTransactionImportReminder() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/* Registered BEFORE /api/transactions/:id — the literal path must win, or
   Express hands "sheet-sync" to the :id route and answers 404. */
/**
 * Automated sheet sync — the no-download version of the CSV import above.
 * Brivity cannot export transactions (see core/transactionSheetSync.ts for
 * the research), so the team's Google Sheet is the source and the server
 * pulls it itself. GET = status, POST = run now ({"dryRun":true} to preview).
 */
app.get("/api/transactions/sheet-sync", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json(sheetSyncStatus());
});

app.post("/api/transactions/sheet-sync", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const result = await runSheetSync({ apply: body.dryRun === true ? false : true });
  res.status(result.ok ? 200 : 422).json(result);
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
  if (body.status === "closed" || tx.status === "closed") {
    void tryRecordCommissionForClosedDeal(tx);
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

/**
 * Import a Brivity transaction export.
 *
 * Brivity has no transaction API (see the header of core/transactionImport.ts
 * for the probe that established that), so this is how transaction data
 * actually gets in. Dry run by default: POST the CSV, read the plan, then
 * repeat with {"apply":true}. The body is the raw CSV text so Harvey and a
 * future scheduled job can call it exactly the way the CRM does.
 */
app.post(
  "/api/transactions/import-csv",
  express.text({ type: ["text/csv", "text/plain"], limit: "8mb" }),
  express.json({ limit: "8mb" }),
  (req, res) => {
    if (!dashboardTokenOk(req)) {
      res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
      return;
    }
    const body = req.body as unknown;
    const asObject = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const csv = typeof body === "string" ? body : typeof asObject.csv === "string" ? asObject.csv : "";
    const apply = asObject.apply === true || req.query.apply === "1";
    const filename = typeof asObject.filename === "string" ? asObject.filename : undefined;

    if (!csv.trim()) {
      res.status(400).json({ ok: false, error: "csv is required (raw text body, or {\"csv\":\"…\"})" });
      return;
    }
    try {
      const plan = planTransactionImport(csv);
      if (plan.errors.length && !plan.rows.length) {
        res.status(422).json({ ok: false, dryRun: !apply, ...plan });
        return;
      }
      if (!apply) {
        // Sample rather than the whole plan: a 2,000-row file would otherwise
        // return a payload nobody can read.
        res.json({
          ok: true, dryRun: true,
          rowsSeen: plan.rowsSeen, create: plan.create, update: plan.update, skip: plan.skip,
          unmappedHeaders: plan.unmappedHeaders, errors: plan.errors,
          sample: plan.rows.filter((r) => r.transaction).slice(0, 5).map((r) => ({
            line: r.line, action: r.action, address: r.transaction.address,
            status: r.transaction.status, dealType: r.transaction.dealType,
            price: r.transaction.price, closingDate: r.transaction.closingDate,
          })),
        });
        return;
      }
      const result = applyTransactionImport(plan, { filename, source: "brivity-csv" });
      /* Close the "import the export" reminder immediately rather than waiting
         for the next scheduled check — being told to do something you just did
         is how a reminder trains people to ignore it. */
      let reminder: string | undefined;
      try {
        reminder = checkTransactionImportReminder().action;
      } catch (err) {
        console.error("[txImportReminder] post-import check failed:", (err as Error).message);
      }
      res.json({ ok: true, dryRun: false, ...result, reminder });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  },
);

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

/**
 * A lead's name for display, never a template token.
 *
 * 42 leads arrived from ManyChat with the merge field unsubstituted, so their
 * username is the literal string "{{full_name}}". Rendered raw that reads as a
 * broken app, and once scoring started working one of them ranked FIRST on the
 * call list — an unidentifiable record at the top of Carlos's day. The
 * conversation behind these is real, so they are not hidden or dropped; they
 * are just labelled honestly so the record can be recognised as needing repair
 * rather than dialled.
 */
function leadDisplayNameSafe(lead: { name?: string | null; username?: string | null } | undefined): string {
  const isToken = (v: string | null | undefined) => !v || /\{\{|\}\}/.test(v);
  const name = lead?.name?.trim();
  if (name && !isToken(name)) return name;
  const user = lead?.username?.trim();
  if (user && !isToken(user)) return user;
  return lead?.name || lead?.username ? "Unknown (broken import)" : "Unknown";
}

app.get("/api/lead-nurture/summary", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const all = await listAllLeads();
  const leadMap = new Map(all.map((l) => [l.id, l]));
  /* Scores outlive the leads they describe. Leads get re-imported and their ids
     churn, but lead_scores keeps every row, so the table held 2,902 scored ids
     against 1,306 real leads — 1,601 of them pointing at people who are no
     longer in the CRM. Reported raw, that produced a "cold: 2902" on a board of
     1,306 leads, and `Math.max(0, unscored)` then clamped away the negative
     that would have made the contradiction obvious. Counting only scores whose
     lead still exists is what makes these numbers mean anything. */
  const live = <T extends { leadId: string }>(rows: T[]): T[] =>
    rows.filter((s) => leadMap.has(s.leadId));
  const hot = live(getLeadsByTier("hot")).sort((a, b) => b.score - a.score);
  const warm = live(getLeadsByTier("warm"));
  const cold = live(getLeadsByTier("cold"));
  const scoredIds = new Set([...hot, ...warm, ...cold].map((s) => s.leadId));
  const unscored = all.length - scoredIds.size;

  const sinceIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const recentScoreChanges = getScoreEntriesSince(sinceIso)
    .filter((s) => s.previousScore != null && s.score !== s.previousScore)
    .sort((a, b) => new Date(b.scoreDate).getTime() - new Date(a.scoreDate).getTime())
    .slice(0, 12)
    .map((s) => {
      const lead = leadMap.get(s.leadId);
      return {
        leadId: s.leadId,
        name: leadDisplayNameSafe(lead),
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
        name: leadDisplayNameSafe(topLead),
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
  const tier = req.params.tier as "hot" | "warm" | "cold";
  if (!["hot", "warm", "cold"].includes(tier)) {
    res.status(400).json({ error: "Invalid tier — must be hot, warm, or cold" });
    return;
  }

  const leads = await listAllLeads();
  const leadMap = new Map(leads.map((l) => [l.id, l]));
  /* Same orphan filter as the summary: a score whose lead no longer exists
     rendered here as a row named "Unknown" with no phone, which is worse than
     absent — it looks like a real person nobody can reach. */
  const scoreEntries = getLeadsByTier(tier).filter((s) => leadMap.has(s.leadId));

  const enriched = scoreEntries
    .map((s) => {
      const lead = leadMap.get(s.leadId);
      const inboundReplyCount = Math.max(
        getInboundMessageCount(s.leadId),
        getInboundDmCount(s.leadId),
      );
      const propertyViewsCount =
        typeof lead?.propertyViewsCount === "number" && lead.propertyViewsCount > 0
          ? lead.propertyViewsCount
          : (lead?.activity ?? []).filter((a) =>
              ["home_clicked", "home_hearted", "web_visit"].includes(a.type),
            ).length;
      return {
        leadId: s.leadId,
        score: s.score,
        previousScore: s.previousScore,
        scoreDate: s.scoreDate,
        scoringFactors: s.scoringFactors,
        /* From the model, never restated. A second copy of the weights is a
           copy that drifts, and this one already had: it still described the
           pre-2026-08 factors months after they stopped being scored. */
        factorMax: LEAD_SCORE_WEIGHTS,
        tier: s.tier,
        name: leadDisplayNameSafe(lead),
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
  const leads = await listAllLeads();
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const sourceActivity = {
    mojo: leads.some((l) => norm(l.source) === "mojo"),
    social: leads.some((l) => ["instagram", "tiktok"].includes(norm(l.source))),
    web_form: leads.some((l) => norm(l.source) === "web_form"),
    referral: leads.some((l) => norm(l.source) === "referral"),
  };
  const routed = leads
    .filter((l) => l.sourceRoutingCompletedAt)
    .sort(
      (a, b) =>
        new Date(b.sourceRoutingCompletedAt!).getTime() -
        new Date(a.sourceRoutingCompletedAt!).getTime(),
    )
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
  const result = await runDailyDigest();
  await deliverDigest(result.snapshotId);
  res.json(result);
});

app.post("/api/reporting/weekly-kpi-now", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const result = await runWeeklyKPI();
  res.json(result);
});

app.get("/api/reporting/latest-digest", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json({ snapshot: getLatestSnapshot("daily_digest") });
});

app.get("/api/reporting/latest-kpi", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json({ snapshot: getLatestSnapshot("weekly_kpi") });
});

app.get("/api/reporting/anomalies", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const snapshot = getLatestSnapshot("daily_digest");
  res.json({ anomalies: snapshot?.anomalies || [], generatedAt: snapshot?.generatedAt || null });
});

app.get("/api/reporting/digest-history", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const limit = parseInt(String(req.query.limit || "14"), 10) || 14;
  const snapshots = getSnapshotsByType("daily_digest", limit);
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
  const snapshots = getSnapshotsByType("weekly_kpi", limit);
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
  res.json({ commissions: getAllCommissions(since) });
});

app.post("/api/finance/commissions", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const salePrice = Number(body.salePrice);
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!address || !Number.isFinite(salePrice) || salePrice <= 0) {
    res.status(400).json({ error: "address and salePrice are required" });
    return;
  }
  const commission = createCommission({
    dealId: typeof body.dealId === "string" ? body.dealId : undefined,
    address,
    salePrice,
    grossCommissionPct: body.grossCommissionPct != null ? Number(body.grossCommissionPct) : undefined,
    dealType: (body.dealType === "seller" ? "seller" : "buyer") as FinanceDealType,
    leadSource: typeof body.leadSource === "string" ? body.leadSource : undefined,
    leadId: typeof body.leadId === "string" ? body.leadId : undefined,
    closedAt:
      typeof body.closedAt === "string"
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
  res.json({ expenses: getAllExpenses(since) });
});

app.post("/api/finance/expenses", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
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
  const expense = createExpense({
    category: category as ExpenseCategory,
    subcategory: typeof body.subcategory === "string" ? body.subcategory : undefined,
    vendor: typeof body.vendor === "string" ? body.vendor : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    amount,
    dealId: typeof body.dealId === "string" ? body.dealId : undefined,
    leadSource: typeof body.leadSource === "string" ? body.leadSource : undefined,
    expenseDate:
      typeof body.expenseDate === "string"
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
  res.json(getGCISummary());
});

app.get("/api/finance/expense-summary", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json(await getExpenseSummary());
});

app.get("/api/finance/projection", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json(generatePipelineProjection());
});

app.get("/api/finance/pace-status", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json(getCurrentPaceStatus());
});

app.get("/api/voice-clone/health", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // ElevenLabs is the primary engine on this CPU-only box; VoxCPM only runs if
  // someone stands up a GPU sidecar. Report whichever is active.
  const elevenConfigured = isElevenLabsConfigured();
  const eleven = elevenConfigured ? await checkElevenLabsHealth() : null;
  const voxcpm = await checkVoxCpmHealth();
  const engine = elevenConfigured ? "elevenlabs" : process.env.VOXCPM_API_URL?.trim() ? "voxcpm" : "none";
  res.json({
    engine,
    configured: elevenConfigured || !!process.env.VOXCPM_API_URL?.trim(),
    elevenlabs: { configured: elevenConfigured, service: eleven },
    voxcpm: { configured: !!process.env.VOXCPM_API_URL?.trim(), service: voxcpm },
    // Back-compat with the existing UI badge (expects `service`).
    apiUrl: process.env.VOXCPM_API_URL?.trim() || null,
    service: elevenConfigured
      ? { ok: !!eleven?.ok, modelLoaded: !!eleven?.ok, cudaAvailable: false }
      : voxcpm,
  });
});

app.get("/api/voice-clone/stats", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const all = getAllRequests(500);
  res.json({
    total: all.length,
    pendingApproval: countPendingApprovalRequests(),
    generating: all.filter((r) => r.generationStatus === "generating").length,
    complete: all.filter((r) => r.generationStatus === "complete").length,
  });
});

app.post("/api/voice-clone/requests", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { script, deliveryStyle, formatType, hookVariationCount, customStyleDescription, voxcpmMode } =
    req.body ?? {};
  if (!script || !deliveryStyle || !formatType) {
    res.status(400).json({ error: "script, deliveryStyle, and formatType required" });
    return;
  }

  const safetyCheck = checkScriptSafety(script, "pre-check", "manual");
  if (!safetyCheck.allowed) {
    res.status(400).json({ error: `Script blocked: ${safetyCheck.reason}` });
    return;
  }

  const request = createVoiceoverRequest({
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
  const requests = getAllRequests(limit).map((r) => enrichVoiceoverRequest(r));
  res.json({ requests });
});

app.get("/api/voice-clone/requests/pending", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const requests = getPendingApprovalRequests().map((r) => enrichVoiceoverRequest(r));
  res.json({ requests });
});

app.get("/api/voice-clone/requests/:id", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const request = enrichVoiceoverRequest(getVoiceoverRequest(req.params.id));
  if (!request) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ request });
});

app.post("/api/voice-clone/requests/:id/approve", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const request = getVoiceoverRequest(req.params.id);
  if (!request) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (request.approvalStatus !== "pending") {
    res.status(400).json({ error: "Request is not in pending state" });
    return;
  }

  const safetyCheck = checkScriptSafety(request.script, request.id!, "approval");
  if (!safetyCheck.allowed) {
    updateVoiceoverRequest(request.id!, {
      approvalStatus: "blocked",
      generationStatus: "failed",
      error: safetyCheck.reason,
    });
    res.status(400).json({ error: `Blocked at approval: ${safetyCheck.reason}` });
    return;
  }

  updateVoiceoverRequest(request.id!, {
    approvalStatus: "approved",
    approvedBy: "marco",
    approvedAt: new Date().toISOString(),
    generationStatus: "queued",
  });
  res.json({ success: true });
});

app.post("/api/voice-clone/requests/:id/reject", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { reason } = req.body ?? {};
  updateVoiceoverRequest(req.params.id, {
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
  res.json({ clips: getAllReferenceClips(), primary: getPrimaryReferenceClip() });
});

app.post("/api/voice-clone/reference-clips", express.json(), (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { sourceUrl, localAudioPath, qualityRating, transcript } = req.body ?? {};
  if (!sourceUrl) {
    res.status(400).json({ error: "sourceUrl required" });
    return;
  }
  const clip = createReferenceClip({
    sourceUrl,
    localAudioPath,
    qualityRating,
    transcript,
    isPrimary: false,
  });
  res.json({ clip });
});

// Real reference-audio upload: accept Marco's voice sample, store it under the
// voice-clone data root, register a reference clip, and immediately create the
// ElevenLabs clone so the UI can show "voice ready". First clip auto-primary.
const referenceAudioUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(voiceCloneDataRoot, "reference");
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 64 * 1024 * 1024 }, // 64MB — a voice sample is short
});

app.post(
  "/api/voice-clone/reference-clips/upload",
  referenceAudioUpload.single("audio"),
  async (req, res) => {
    if (!dashboardTokenOk(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No audio file uploaded (field name: audio)" });
      return;
    }
    const makePrimary = getAllReferenceClips().length === 0; // first upload becomes primary
    const clip = createReferenceClip({
      sourceUrl: `upload:${file.originalname}`,
      localAudioPath: file.path,
      transcript: typeof req.body?.transcript === "string" ? req.body.transcript : undefined,
      isPrimary: makePrimary,
    });
    if (makePrimary && clip.id) setPrimaryReferenceClip(clip.id);

    // Create the ElevenLabs clone now (best-effort). If it fails (e.g. plan
    // doesn't allow cloning), the clip still exists and generation will retry.
    let cloneError: string | undefined;
    if (isElevenLabsConfigured() && clip.id) {
      const clone = await createInstantVoiceClone({
        name: `Marco Puga (${clip.id.slice(0, 8)})`,
        filePaths: [file.path],
        description: "Marco Puga Realty — cloned voiceover voice",
      });
      if (clone.success && clone.voiceId) {
        setReferenceClipVoiceId(clip.id, clone.voiceId);
        clip.elevenVoiceId = clone.voiceId;
      } else {
        cloneError = clone.error;
      }
    } else if (!isElevenLabsConfigured()) {
      cloneError = "ELEVENLABS_API_KEY not set — clip saved; set the key to enable cloning";
    }

    res.json({ clip, voiceReady: !!clip.elevenVoiceId, cloneError });
  },
);

app.post("/api/voice-clone/reference-clips/:id/set-primary", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  setPrimaryReferenceClip(req.params.id);

  // Ensure the now-primary clip has a clone so generation is ready immediately.
  let voiceReady = false;
  let cloneError: string | undefined;
  const clip = getReferenceClipById(req.params.id);
  if (clip?.elevenVoiceId) {
    voiceReady = true;
  } else if (clip?.localAudioPath && isElevenLabsConfigured()) {
    const clone = await createInstantVoiceClone({
      name: `Marco Puga (${req.params.id.slice(0, 8)})`,
      filePaths: [clip.localAudioPath],
      description: "Marco Puga Realty — cloned voiceover voice",
    });
    if (clone.success && clone.voiceId) {
      setReferenceClipVoiceId(req.params.id, clone.voiceId);
      voiceReady = true;
    } else {
      cloneError = clone.error;
    }
  }
  res.json({ success: true, voiceReady, cloneError });
});

app.get("/api/voice-clone/safety-log", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const limit = parseInt(String(req.query.limit || "100"), 10) || 100;
  res.json({ entries: getSafetyLogEntries(limit) });
});

app.post("/api/finance/sync", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const commissions = await syncCommissionsFromClosedTransactions();
  const projection = generatePipelineProjection();
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
  res.json({ alerts: getFinanceAlerts(limit) });
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
  acknowledgeFinanceAlert(id);
  res.json({ success: true });
});

app.get("/api/finance/weekly-summary-preview", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json(await buildWeeklyFinanceSummaryData());
});

app.get("/api/finance/monthly-report-preview", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  res.json(await buildMonthlyCloseReportData());
});

app.post("/api/finance/weekly-summary-now", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const result = await runWeeklyFinanceSummary();
  res.json(result);
});

app.post("/api/finance/monthly-report-now", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const result = await runMonthlyCloseReport();
  res.json(result);
});

app.post("/api/finance/pace-check-now", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const result = await runPaceCheck();
  res.json(result);
});

app.post("/api/finance/expense-spike-check-now", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  const result = await runExpenseSpikeCheck();
  res.json(result);
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

// Self-hosted OpenReel clip editor, served same-origin under /editor.
// It uses SharedArrayBuffer (ffmpeg-mt / WebCodecs threading), which requires
// cross-origin isolation, so every /editor response needs COOP + COEP. These
// headers are scoped to /editor only so the rest of the dashboard (CRM iframe,
// external thumbnails, etc.) is unaffected. Runs before express.static below.
app.use("/editor", (_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
// SPA entry: /editor and /editor/ serve the editor's index.html (the app uses
// hash routing, so deep links like /editor/#/editor?clip=... resolve client-side).
app.get(["/editor", "/editor/"], (_req, res) => {
  res.sendFile(path.join(publicDir, "editor", "index.html"));
});

/** Serve other public assets (CRM modules, etc.) after explicit routes. */
app.use(express.static(publicDir, { index: false }));

app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const e = err as { code?: string; status?: number; message?: string; stack?: string };

  if (e.code === "ENOSPC") {
    console.error("[server] DISK FULL error:", e.message);
    res.status(507).json({
      error: "Insufficient storage space on server",
      detail:
        "The server disk is full. Contact your administrator to free up space on the /data volume.",
      code: "ENOSPC",
    });
    return;
  }

  console.error("[server] Unhandled error:", e.message);
  if (e.stack) console.error(e.stack);

  if (res.headersSent) {
    next(err);
    return;
  }

  res.status(e.status || 500).json({
    error: e.message || "Internal server error",
    code: e.code,
  });
});

const httpServer = http.createServer(app);

// Phase 3c — Node 18+ defaults server.requestTimeout to 5 minutes: the total
// time allowed to RECEIVE an entire request body, enforced by Node itself
// independent of multer's fileSize limit, Express, or Fly's proxy. A 4GB
// upload over a real (non-datacenter) connection can easily take well past
// 5 minutes to fully arrive, so without this the connection gets force-killed
// mid-upload regardless of every other fix in this pass. Raised to 30 minutes
// server-wide — harmless for the app's normal fast JSON routes (this is an
// upper bound, not an added delay) and is what actually lets a large upload
// finish. headersTimeout must stay below requestTimeout (Node requirement);
// headers arrive in milliseconds even for a huge upload, so it stays short.
httpServer.requestTimeout = 30 * 60 * 1000;
httpServer.headersTimeout = 2 * 60 * 1000;

const hullWss = new WebSocketServer({ noServer: true });
hullWss.on("connection", (ws) => {
  registerHullWs(ws);
});

httpServer.on("upgrade", (request, socket, head) => {
  // Harvey STT: ElevenLabs Scribe v2 realtime is the primary engine; Deepgram
  // Flux is kept as a fallback path (still functional if hit directly).
  if (handleElevenLabsUpgrade(request, socket, head, dashboardTokenOkIncoming)) return;
  if (handleDeepgramUpgrade(request, socket, head, dashboardTokenOkIncoming)) return;

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

/* Scheduled transactions sheet sync — every 6 hours (configurable), plus one
   run shortly after boot so a restart never leaves the numbers a day stale.
   No-ops harmlessly when TRANSACTIONS_SHEET_URL is unset. */
if (isSheetSyncConfigured()) {
  const sheetSyncEveryMs = Math.max(
    30 * 60_000,
    (parseInt(process.env.TRANSACTIONS_SHEET_SYNC_HOURS || "6", 10) || 6) * 60 * 60_000,
  );
  setTimeout(() => {
    void runSheetSync().catch((err) => console.warn("[sheetSync] boot run failed:", err));
  }, 90_000).unref();
  setInterval(() => {
    void runSheetSync().catch((err) => console.warn("[sheetSync] scheduled run failed:", err));
  }, sheetSyncEveryMs).unref();
}

/* Scheduled Auto Plan execution — hourly. The old 24h cadence meant a "day 0"
   step could sit unsent for a day and chained steps drifted a full day per
   link; an hourly sweep keeps offsets honest at day granularity. */
const AUTO_PLAN_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  executeDueAutoPlanSteps()
    .then((r) => {
      if (r.stepsExecuted > 0) {
        console.log(`[autoPlans] scheduled run: ${r.stepsExecuted} step(s) across ${r.processed} enrollment(s)`);
      }
      return executeDueTransactionPlanSteps();
    })
    .then((r) => {
      if (r.stepsExecuted > 0) {
        console.log(`[autoPlans] transaction run: ${r.stepsExecuted} step(s) across ${r.processed} enrollment(s)`);
      }
    })
    .catch((err) => console.error("[autoPlans] scheduled run failed:", err));
}, AUTO_PLAN_INTERVAL_MS);

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

httpServer.on("error", (err) => {
  console.error("[Server] HTTP listen error:", err);
  process.exit(1);
});

/* Arm the site lock before the listener opens: everyone signed out, admin
   credential rotated. Once per marker, not once per boot — see
   src/core/initialAdmin.ts for why that distinction matters. */
{
   
  const lock = require("./core/initialAdmin.js") as typeof import("./core/initialAdmin.js");
  try {
    const r = lock.runLockdownBootStep();
    if (r.ran) {
      console.log(
        `[security] Site lock armed. ${r.sessionsRevoked} session(s) revoked; ` +
          `admin credential rotated on ${r.adminEmail ?? "NO ADMIN FOUND"}. ` +
          `Every page, API and static file now requires a signed-in session.`,
      );
      if (!r.adminEmail) {
        console.error("[security] No admin account was found to rotate. Nobody can sign in — fix users.json.");
      }
    }
  } catch (err) {
    console.error("[security] Lockdown boot step FAILED — check auth.db:", (err as Error).message);
  }
}

/* Seed the team's SOPs into the Knowledge Center. Once per library version —
   after that the Knowledge Center owns them and edits there are never
   overwritten. See src/core/sopImport.ts. */
{
  const sops = require("./core/sopImport.js") as typeof import("./core/sopImport.js");
  try {
    const r = sops.runSopImportStep();
    if (r.ran) {
      console.log(
        `[knowledge] SOP import: ${r.imported.length} added, ${r.skipped.length} already present ` +
          `(library ${require("./data/sopLibrary.js").SOP_LIBRARY_VERSION}).`,
      );
    }
  } catch (err) {
    console.error("[knowledge] SOP import FAILED — the Knowledge Center will be missing the SOPs:", (err as Error).message);
  }
}

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[Server] Listening on 0.0.0.0:${PORT}`);
  /* Publish the real routing table to Harvey's CRM bridge. Read from Express
     itself rather than hand-listed, so the catalogue Harvey is shown cannot
     describe an endpoint that does not exist or miss one that does. */
  try {
    /* Express 5 moved the routing table from `app._router` to `app.router`.
       Both are read so this keeps working either side of that change rather
       than silently publishing an empty catalogue. */
    const appAny = app as unknown as { router?: { stack?: unknown[] }; _router?: { stack?: unknown[] } };
    const stack = appAny.router?.stack || appAny._router?.stack || [];
    const routes: Array<{ method: string; path: string }> = [];
    for (const layer of stack as Array<{ route?: { path?: unknown; methods?: Record<string, boolean> } }>) {
      const p = layer.route?.path;
      if (typeof p !== "string") continue;
      for (const [m, on] of Object.entries(layer.route?.methods || {})) {
        if (on) routes.push({ method: m.toUpperCase(), path: p });
      }
    }
    setCrmApiCatalogue(routes, `http://127.0.0.1:${PORT}`);
    console.log(`[Harvey] CRM bridge: ${getCrmApiCatalogue().length} of ${routes.length} routes reachable.`);
  } catch (err) {
    console.error("[Harvey] CRM bridge catalogue failed — crm_api will report an empty index:", err);
  }
  try {
    getContentDb();
    scheduleContentJobs();
  } catch (err) {
    console.error("[Server] content DB / jobs init failed:", err);
  }
  try {
    initHull();
  } catch (err) {
    console.error("[hull] init failed:", err);
  }
  try {
    initPush();
  } catch (err) {
    console.error("[push] init failed:", err);
  }
  try {
    // Scheduled texts/emails. The queue lives on the /data volume, so
    // anything still pending across a deploy is picked up on the next tick.
    startScheduledSender();
  } catch (err) {
    console.error("[scheduled] sender failed to start:", err);
  }
  try {
    // Raises (and clears) the monthly "import the Brivity transaction export"
    // task. Brivity has no transaction API, so nothing else keeps that data
    // from going quietly stale.
    scheduleTransactionImportReminder();
    void (async () => {
      const { scheduleQuoSync } = await import("./core/quoSync.js");
      const { isQuoConfigured, ensureMessageWebhook } = await import("./integrations/quo/index.js");
      scheduleQuoSync(5);
      /* Listing alerts and market reports. Hourly is fine granularity for
         day-scale cadences, and it keeps a restart from bunching every alert
         onto the same minute. */
      const { scheduleOutreach } = await import("./core/outreachRunner.js");
      scheduleOutreach(60);
      /* Register the inbound webhook so a text lands in the CRM in seconds
         rather than on the next poll. Idempotent, and failure is survivable —
         the 5-minute poll is the fallback, so this only ever logs. */
      if (isQuoConfigured()) {
        try {
          const url = await quoWebhookUrl();
          if (url) {
            const out = await ensureMessageWebhook(url);
            console.log(`[Quo] webhook ${out.created ? "registered" : "already registered"} (${out.webhook.id})`);
          }
        } catch (err) {
          console.error("[Quo] webhook registration failed (poll still covers it):", (err as Error).message);
        }
      }
    })();
  } catch (err) {
    console.error("[txImportReminder] failed to start:", err);
  }
  try {
    initTeamStore();
  } catch (err) {
    console.error("[team] init failed:", err);
  }
  // Planner activity lines name people, not ids. The roster lives in one file
  // and the store must not import it directly (it would drag the CRM user
  // table into every planner query), so the resolver is injected at boot.
  void (async () => {
    try {
      const { setNameResolver, getPlannerDb } = await import("./core/contentPlanner.js");
      const { plannerMemberName } = await import("./core/plannerTeam.js");
      setNameResolver(plannerMemberName);
      getPlannerDb();
    } catch (err) {
      console.error("[planner] init failed:", err);
    }
  })();
  // A job left 'running' when the process died is not running — nothing resumes
  // it. Mark those interrupted so the UI shows the truth, not a phantom job.
  void (async () => {
    try {
      const { reconcileOrphanedJobs, initJobSchema } = await import("./core/jobStore.js");
      initJobSchema();
      const n = reconcileOrphanedJobs();
      if (n) console.log(`[HarveyJobs] marked ${n} interrupted job(s) from the previous run`);
    } catch (err) {
      console.error("[HarveyJobs] init failed:", err);
    }
  })();
  if (!process.env.ELEVENLABS_API_KEY?.trim()) {
    console.warn("[Harvey] ELEVENLABS_API_KEY not set — Scribe v2 Realtime STT will not work");
  } else {
    console.log("[Harvey] ELEVENLABS_API_KEY configured — Scribe v2 Realtime STT ready");
  }
  if (!process.env.DEEPGRAM_API_KEY?.trim()) {
    console.warn("[Harvey] DEEPGRAM_API_KEY not set — Deepgram Flux STT fallback unavailable");
  } else {
    console.log("[Harvey] DEEPGRAM_API_KEY configured — Flux STT fallback ready");
  }
  if (!geminiApiKey()) {
    console.warn("[Harvey] GEMINI_API_KEY not set — Gemini TTS will not work");
  } else {
    console.log("[Harvey] GEMINI_API_KEY configured — Gemini TTS ready");
  }
  if (isAnthropicApiKeyConfigured()) {
    console.log(`[Anthropic] API key present — model ${getAnthropicModel()} (set ANTHROPIC_MODEL to override).`);
  } else {
    console.warn(
      "[Anthropic] ANTHROPIC_API_KEY missing — preflight/opening/pipeline skip Haiku and use template fallbacks only.",
    );
  }
  void import("./integrations/email/index.js").then(async (m) => {
    const ok = await m.verifyEmailConnection();
    if (ok) {
      void import("./agents/emailMarketing/gmailSync.js").then((g) =>
        g.syncGmailInbox({ maxResults: 25 }).catch((err) =>
          console.warn("[GmailSync] startup sync failed:", err instanceof Error ? err.message : err),
        ),
      );
    }
  });
  // Periodic Gmail sync. Before this, the inbox only synced at boot and on
  // manual triggers — when the OAuth token died in June the cache just froze
  // silently. Every failure is now recorded by syncGmailInbox for the
  // dashboard's sync-status banner, and a relink through the in-app OAuth
  // flow is picked up on the next tick without a restart.
  const gmailSyncEveryMs = Math.max(
    5 * 60_000,
    parseInt(process.env.GMAIL_SYNC_INTERVAL_MINUTES || "15", 10) * 60_000 || 15 * 60_000,
  );
  setInterval(() => {
    void import("./agents/emailMarketing/gmailSync.js").then((g) =>
      g.syncGmailInbox({ maxResults: 30 }).catch((err) =>
        console.warn("[GmailSync] periodic sync failed:", err instanceof Error ? err.message : err),
      ),
    );
  }, gmailSyncEveryMs).unref();
  void import("./agents/finance/index.js").then((m) =>
    m.syncCommissionsFromClosedTransactions().catch((err) =>
      console.warn("[Finance] startup commission sync failed:", err instanceof Error ? err.message : err),
    ),
  );
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
  console.log(`Harvey chat: POST http://localhost:${PORT}/api/jarvis/chat (model ${getHarveyModel()})`);
  console.log(`Harvey voice STT: WS   http://localhost:${PORT}/api/jarvis/elevenlabs/listen (fallback: /api/jarvis/deepgram/listen)`);
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

