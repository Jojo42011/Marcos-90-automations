/**
 * Harvey chat tools — Anthropic tool definitions + DB-backed executors.
 */

import {
  PLATFORM_TOOL_DEFINITIONS,
  PLATFORM_TOOL_NAMES,
  executePlatformTool,
} from "./platformTools.js";
import { getThreadForLead } from "../core/smsStore.js";
import { getConversation, listAllLeads, getLeadById } from "../core/db.js";
import { getSocialSummaryForHarvey, getSocialVideos, getPendingCommentReplies } from "../core/socialStore.js";
import { getLatestMorningScan } from "../agents/morningScan/index.js";
import { getLatestReportingSnapshot } from "../agents/reporting/index.js";
import { getLatestContentSuggestions } from "../agents/contentSuggestions/index.js";
import { getRecentEscalations } from "../agents/escalations/index.js";
import { getUpcomingShowings } from "../agents/showingReminders/index.js";
import { getMojoOutreachStatus } from "../agents/mojoOutreach/index.js";
import {
  getAllTransactions,
  getOverdueDeadlines,
  getTransaction,
  getUnsignedDocuments,
  getUpcomingDeadlines,
} from "../core/transactionsStore.js";
import { getLatestContentDigest } from "../agents/harveyContentDigest/index.js";
import { getLeadsByTier, getLatestScore, getScoreHistory, type LeadScoreEntry } from "../core/leadScoreStore.js";
import { getInboundMessageCount } from "../core/smsStore.js";
import { scoreAllLeads, scoreAndRecordLead, scoreColdLeads } from "../agents/leadScoring/index.js";
import { routeNewLead } from "../agents/leadNurture/sourceRouting.js";
import { runWarmLeadWeeklyTouch } from "../agents/leadNurture/warmLeadFlow.js";
import { runColdLeadMonthlyTouch } from "../agents/leadNurture/coldLeadFlow.js";
import { handleWebsiteVisit } from "../agents/reEngagement/index.js";
import {
  getDailyReport,
  getWeeklyReport,
} from "../agents/contentManager/analytics.js";
import {
  listContentVideos,
  listPendingComplianceQueue,
  ensureDailyTargets,
  getDailyStrategy,
  getLatestBriefing,
  getPerformanceModel,
  todayDateCst,
} from "../core/contentDb.js";
import { contentManagerBrain } from "../agents/contentManager/brain/index.js";
import {
  handleListingStatusUpdate,
  type ListingStatusValue,
} from "../agents/listingStatusAutomation/index.js";
import {
  getAllNotifications,
  getUnreadNotifications,
} from "../core/crmNotificationStore.js";
import {
  getLatestSnapshot,
  type DailyDigestData,
} from "../core/reportingStore.js";
import { getGCISummary, getExpenseSummary, generatePipelineProjection } from "../core/financeStore.js";
import { getCurrentPaceStatus } from "../agents/finance/paceAlert.js";
import type { Lead } from "../core/types.js";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";

const MS_48H = 48 * 60 * 60 * 1000;
const POST_PHONE_STAGES = new Set([
  "phone_captured",
  "property_sent",
  "criteria_collected",
  "email_sent",
]);

function hoursSince(iso: string | null | undefined): number {
  if (!iso) return 9999;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 9999;
  return (Date.now() - t) / (60 * 60 * 1000);
}

function daysSince(iso: string | null | undefined): number {
  return Math.floor(hoursSince(iso) / 24);
}

function platformBucket(platform: string): "instagram" | "tiktok" | "other" {
  const p = (platform || "").toLowerCase();
  if (p.includes("insta")) return "instagram";
  if (p.includes("tik")) return "tiktok";
  return "other";
}

function adCampaignBucket(ad: string | null | undefined): string {
  if (ad === "canyon_lake_ad" || ad === "low_interest_ad") return ad;
  return "unknown";
}

function leadDisplayName(lead: Lead): string | null {
  return lead.name || lead.username || null;
}

function leadHasSmsOutbound(lead: Lead): boolean {
  const thread = getThreadForLead(lead.id, 50);
  return thread.some((m) => m.direction === "outbound");
}

function isHotLead(lead: Lead): boolean {
  if (!lead.phone?.trim()) return false;
  if (leadHasSmsOutbound(lead)) return false;
  if (lead.crmStatus === "dead") return false;
  return lead.crmStatus === "not_contacted";
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

function phoneDigits(phone: string | null | undefined): string {
  if (!phone) return "";
  return phone.replace(/\D/g, "");
}

function fuzzyMatchLead(lead: Lead, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return false;
  const parts = [
    lead.name,
    lead.username,
    lead.phone,
    leadDisplayName(lead),
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  for (const p of parts) {
    if (p.includes(q)) return true;
  }
  const digits = phoneDigits(lead.phone);
  const qDigits = q.replace(/\D/g, "");
  if (qDigits.length >= 3 && digits.includes(qDigits)) return true;
  const nameParts = (lead.name || "").toLowerCase().split(/\s+/);
  for (const np of nameParts) {
    if (np.length >= 2 && np.includes(q)) return true;
  }
  return false;
}

function startOfTodayUtc(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export const HARVEY_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "get_lead_summary",
    description:
      "Totals and breakdowns: all leads, by platform (instagram/tiktok), funnel stage, ad campaign, phones and emails captured.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_hot_leads",
    description:
      "Leads with phone on file who have not been texted via SMS yet (no outbound SMS thread).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_funnel_stats",
    description: "Funnel stage counts, phone capture rate, leads added today vs all time.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_leads",
    description: "Search leads by first name, last name, or phone number.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name or phone fragment to search" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_conversation",
    description: "Full DM conversation thread for a lead by internal lead id.",
    input_schema: {
      type: "object",
      properties: {
        leadId: { type: "string", description: "Internal lead id" },
      },
      required: ["leadId"],
    },
  },
  {
    name: "get_stalled_leads",
    description:
      "Leads stuck in new or opening_asked_first_time with no activity in 48+ hours.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_social_summary",
    description:
      "Get Marco's TikTok social media performance summary including views, engagement, content patterns, and week-over-week trends. Use when Marco asks about his content, TikTok performance, social media stats, or how his videos are doing.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_social_videos",
    description:
      "Get a list of Marco's TikTok videos filtered by performance tier and time period. Use when Marco asks about his best videos, worst videos, recent videos, or wants to see specific video performance.",
    input_schema: {
      type: "object",
      properties: {
        tier: {
          type: "string",
          enum: ["hot", "average", "warm", "cold"],
          description:
            "Performance tier — hot=top performers, average/warm=mid tier, cold=underperformers",
        },
        limit: { type: "number", description: "Number of videos to return (default 10)" },
        days: { type: "number", description: "Only return videos from the last N days" },
      },
      required: [],
    },
  },
  {
    name: "get_morning_scan",
    description:
      "Get the latest overnight scan results — new comments, mentions, and flagged lead-intent messages from TikTok/Instagram that need attention.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_pending_comment_replies",
    description:
      "Get comment replies that are pending review, especially negative comments that need human approval before being sent.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_evening_pull",
    description:
      "Get the latest evening performance report — last 7 days video scores, top performer, and underperformers.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_content_suggestions",
    description:
      "Get this week's AI-generated content ideas for TikTok based on recent performance data and current trends.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_content_digest",
    description:
      "Get the latest content performance digest — a summary of TikTok stats, top/underperforming videos, escalations, and content ideas, updated every 3 days.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_recent_escalations",
    description:
      "Get recent escalation alerts — negative comments needing review, strong lead intent in DMs, or videos going viral.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_upcoming_showings",
    description:
      "Get all upcoming property showings with confirmation status — which leads have confirmed, which are pending, which need follow-up.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_mojo_outreach_status",
    description:
      "Get status of Mojo cold lead outreach sequences — how many leads are in sequence, paused, replied, or completed.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_paused_conversations",
    description:
      "Get leads where automation has been paused due to escalation — ready to make an offer, angry client, or legal question. These need Marco's personal attention.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_transactions_overview",
    description:
      "Get an overview of all active transactions — addresses, status, closing dates, and how many deadlines are upcoming or overdue.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_upcoming_deadlines",
    description:
      "Get transaction deadlines coming up in the next N days across all deals — inspections, appraisals, closings, etc.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Number of days ahead to look (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "get_overdue_items",
    description:
      "Get all overdue transaction deadlines and unsigned documents that need immediate attention.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_transaction_flow_status",
    description:
      "Get the status of in-progress transaction workflows — inspection periods, final week prep, and post-close follow-ups across all active deals.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_lead_nurture_overview",
    description:
      "Lead nurture dashboard summary — hot/warm/cold/unscored counts, top hot lead with scoring factors and real CRM numbers (timeline, pre-approval, replies, views, showings).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_lead_nurture_tier",
    description:
      "Get enriched leads in a nurture tier (hot, warm, or cold) with scores, factor breakdown, names, phones, and real CRM values.",
    input_schema: {
      type: "object",
      properties: {
        tier: { type: "string", description: "hot, warm, or cold" },
        limit: { type: "number", description: "Max leads to return, default 15" },
      },
      required: ["tier"],
    },
  },
  {
    name: "get_lead_score_detail",
    description:
      "Get full score history and factor breakdown for one lead by lead_id — includes real timeline, pre-approval, inbound SMS count, property views, showing status.",
    input_schema: {
      type: "object",
      properties: { lead_id: { type: "string", description: "CRM lead id" } },
      required: ["lead_id"],
    },
  },
  {
    name: "lead_nurture_score_all",
    description: "Re-score every lead in the CRM and update hot/warm/cold tiers. Use when Marco asks to refresh lead scores.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "lead_nurture_rescore_cold",
    description: "Re-score only cold-tier leads and promote any that moved up. Use when Marco asks to refresh cold leads.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "lead_nurture_route_lead",
    description:
      "Run source-based nurture routing for one lead (mojo instant text, social DM, web form, referral priority).",
    input_schema: {
      type: "object",
      properties: { lead_id: { type: "string", description: "CRM lead id" } },
      required: ["lead_id"],
    },
  },
  {
    name: "get_lead_nurture_routing",
    description: "Recently source-routed leads and which routing rules (mojo, social, web form, referral) have activity.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_crm_automation_notifications",
    description:
      "Unread CRM automation alerts — ghosted lead website revisits (re-engagement) and seller listing status changes (off-market outreach, active on market).",
    input_schema: {
      type: "object",
      properties: {
        unread_only: { type: "boolean", description: "Default true — only unread notifications" },
        limit: { type: "number", description: "Max rows, default 20" },
      },
      required: [],
    },
  },
  {
    name: "trigger_website_revisit",
    description:
      "Fire the website-visit / re-engagement intake for a lead (same as CRM manual test). Only when Marco asks to simulate a revisit or record a website visit for a ghosted lead.",
    input_schema: {
      type: "object",
      properties: { lead_id: { type: "string", description: "CRM lead id" } },
      required: ["lead_id"],
    },
  },
  {
    name: "update_seller_listing_status",
    description:
      "Record a seller lead's home listing status change (active, off_market, expired, pending, sold). Fires off-market outreach or Marco active alert on transitions.",
    input_schema: {
      type: "object",
      properties: {
        lead_id: { type: "string", description: "CRM lead id" },
        address: { type: "string", description: "Property address" },
        status: {
          type: "string",
          description: "active | pending | off_market | expired | sold",
        },
        source: { type: "string", description: "manual or mls_feed, default manual" },
      },
      required: ["lead_id", "address", "status"],
    },
  },
  {
    name: "get_daily_digest",
    description:
      "Get the latest daily digest — all 6 sections (social, email, texts, transactions, pipeline, business health) plus anomalies flagged this morning.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_digest_section",
    description:
      "Drill into a specific section of the daily digest — social, email, texts, transactions, pipeline, or business_health.",
    input_schema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description: "Section key: social, email, texts, transactions, pipeline, business_health",
        },
      },
      required: ["section"],
    },
  },
  {
    name: "get_weekly_kpi",
    description:
      "Get the latest weekly KPI scorecard with week-over-week trends.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_anomalies",
    description:
      "Get anomalies from the latest daily digest — unusual metrics vs the prior 4-week average.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_finance_overview",
    description:
      "Finance overview — GCI summary, expense summary, pipeline projection, and pace-to-goal status.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_gci_summary",
    description: "GCI tracker — MTD/YTD gross and net, by deal, by lead source, monthly trend.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_expense_summary",
    description: "Expense tracker — MTD/week totals, by category, cost per lead/close by source.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_pipeline_projection",
    description: "Weighted pipeline GCI projection from active transactions.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_pace_status",
    description: "Monthly GCI pace vs MONTHLY_GCI_GOAL — on track or behind.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_email_marketing_overview",
    description:
      "Get email marketing stats — emails sent, open rate, reply rate, active drip sequences, recent activity, and cached Gmail inbox.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "gmail_list_inbox",
    description:
      "List recent Gmail messages from Marco's inbox (inbound and sent). Syncs from Gmail API when cache is empty unless live=true.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max messages, default 15" },
        query: { type: "string", description: "Gmail search query, e.g. newer_than:7d" },
        live: { type: "boolean", description: "Force live pull from Gmail" },
      },
      required: [],
    },
  },
  {
    name: "gmail_get_message",
    description: "Get full Gmail message by Gmail message id (subject, body, from, to).",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "Gmail message id" },
      },
      required: ["message_id"],
    },
  },
  {
    name: "gmail_sync_inbox",
    description:
      "Pull recent Gmail messages and match inbound replies to CRM leads (updates reply tracking).",
    input_schema: {
      type: "object",
      properties: {
        max_results: { type: "number", description: "Max messages to sync, default 30" },
      },
      required: [],
    },
  },
  {
    name: "get_sent_email_detail",
    description: "Get full body and metadata for a logged marketing email by local email id.",
    input_schema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "Local email id from email marketing log" },
      },
      required: ["email_id"],
    },
  },
  {
    name: "get_content_summary",
    description:
      "Content Manager daily and weekly performance — videos published vs 7/day target, phone numbers captured vs 22/day, top/bottom videos, below-benchmark flags. Use when Marco asks how content is doing, if he's on track, or phone numbers today.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_content_pipeline",
    description:
      "Content Manager video queue — pending review, approved, scheduled, published, or rejected clips with captions, hooks, pillars, compliance flags.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending_review", "approved", "scheduled", "published", "rejected"],
          description: "Filter by video status",
        },
        limit: { type: "number", description: "Max videos to return, default 20" },
      },
      required: [],
    },
  },
  {
    name: "get_content_compliance_queue",
    description:
      "Content awaiting compliance review before publish — caption, hook, platform, flagged reasons. Check proactively during daily game plan discussions.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_content_manager_status",
    description:
      "Latest Content Manager briefing, today's strategy, and daily targets. Use for quick content status checks.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "ask_content_manager",
    description:
      "Ask the Content Manager Brain a content-strategy question. Use for analysis, recommendations, what to film, hooks, hashtags, performance.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Content question for the specialist" },
      },
      required: ["question"],
    },
  },
  // Tracker, Task Command, team and settings — see platformTools.ts.
  ...PLATFORM_TOOL_DEFINITIONS,
];

export const HARVEY_GEMINI_TOOLS = {
  functionDeclarations: [
    {
      name: "get_lead_summary",
      description:
        "Get a summary of all leads in the CRM pipeline including counts by stage and funnel position.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_hot_leads",
      description:
        "Get the list of hot leads — leads with phone captured who need immediate follow up.",
      parameters: {
        type: "OBJECT",
        properties: {
          limit: {
            type: "NUMBER",
            description: "Maximum number of leads to return, default 10",
          },
        },
        required: [],
      },
    },
    {
      name: "get_funnel_stats",
      description: "Get funnel statistics showing how many leads are at each stage of the pipeline.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "search_leads",
      description: "Search for a specific lead by name, username, or phone number.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: {
            type: "STRING",
            description: "The name, username, or phone number to search for",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_conversation",
      description: "Get the full conversation history for a specific lead.",
      parameters: {
        type: "OBJECT",
        properties: {
          lead_id: {
            type: "STRING",
            description: "The lead ID to get conversation for",
          },
        },
        required: ["lead_id"],
      },
    },
    {
      name: "get_stalled_leads",
      description:
        "Get leads that have gone cold or stalled in the pipeline with no recent activity.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_social_summary",
      description:
        "Get live TikTok social media performance data from Apify including current avg views per video, total views, followers, top performing videos, and content patterns. Always call this for TikTok performance questions.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_social_videos",
      description:
        "Get a list of TikTok videos filtered by performance tier. Use for questions about best videos, worst videos, or recent video performance.",
      parameters: {
        type: "OBJECT",
        properties: {
          tier: {
            type: "STRING",
            description: "Performance tier: hot, warm, or cold",
          },
          limit: {
            type: "NUMBER",
            description: "Number of videos to return",
          },
          days: {
            type: "NUMBER",
            description: "Only return videos from the last N days",
          },
        },
        required: [],
      },
    },
    {
      name: "get_morning_scan",
      description:
        "Get the latest overnight scan — new comments, mentions, and lead-intent flags from social platforms.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_pending_comment_replies",
      description:
        "Get comment replies pending review, especially negative comments needing human approval.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_evening_pull",
      description:
        "Get the latest evening performance report — last 7 days scores, top performer, underperformers.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_content_suggestions",
      description:
        "Get this week's AI-generated TikTok content ideas based on recent performance and trends.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_content_digest",
      description:
        "Get the latest content performance digest — TikTok stats, top/underperforming videos, escalations, and content ideas (updated every 3 days).",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_recent_escalations",
      description:
        "Get recent escalation alerts for negative comments, lead intent, or viral spikes.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_upcoming_showings",
      description:
        "Get all upcoming property showings with confirmation status — confirmed, pending, or needing follow-up.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_mojo_outreach_status",
      description:
        "Get status of Mojo cold lead outreach sequences — active, paused, replied, or completed.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_paused_conversations",
      description:
        "Get leads where SMS automation is paused due to escalation — offer intent, angry client, or legal question.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_transactions_overview",
      description:
        "Overview of active transactions — status, closing dates, upcoming and overdue deadline counts.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_upcoming_deadlines",
      description: "Transaction deadlines in the next N days (inspection, appraisal, closing, etc.).",
      parameters: {
        type: "OBJECT",
        properties: {
          days: { type: "NUMBER", description: "Days ahead to look (default 7)" },
        },
        required: [],
      },
    },
    {
      name: "get_overdue_items",
      description: "Overdue transaction deadlines and unsigned documents needing attention.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_transaction_flow_status",
      description:
        "Get the status of in-progress transaction workflows — inspection periods, final week prep, and post-close follow-ups across all active deals.",
      parameters: {
        type: "OBJECT",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_lead_nurture_overview",
      description:
        "Lead nurture summary — hot/warm/cold counts, top hot lead with scoring factors and real CRM numbers.",
      parameters: { type: "OBJECT", properties: {}, required: [] },
    },
    {
      name: "get_lead_nurture_tier",
      description: "Enriched leads in a nurture tier with scores and real CRM values.",
      parameters: {
        type: "OBJECT",
        properties: {
          tier: { type: "STRING", description: "hot, warm, or cold" },
          limit: { type: "NUMBER", description: "Max leads" },
        },
        required: ["tier"],
      },
    },
    {
      name: "get_lead_score_detail",
      description: "Full score history and factors for one lead.",
      parameters: {
        type: "OBJECT",
        properties: { lead_id: { type: "STRING" } },
        required: ["lead_id"],
      },
    },
    {
      name: "lead_nurture_score_all",
      description: "Re-score all CRM leads.",
      parameters: { type: "OBJECT", properties: {}, required: [] },
    },
    {
      name: "lead_nurture_rescore_cold",
      description: "Re-score cold-tier leads only.",
      parameters: { type: "OBJECT", properties: {}, required: [] },
    },
    {
      name: "lead_nurture_route_lead",
      description: "Run source routing for one lead.",
      parameters: {
        type: "OBJECT",
        properties: { lead_id: { type: "STRING" } },
        required: ["lead_id"],
      },
    },
    {
      name: "get_lead_nurture_routing",
      description: "Recently routed leads and routing rule activity.",
      parameters: { type: "OBJECT", properties: {}, required: [] },
    },
    {
      name: "get_daily_digest",
      description:
        "Latest daily digest — social, email, texts, transactions, pipeline, business health, and anomalies.",
      parameters: { type: "OBJECT", properties: {}, required: [] },
    },
    {
      name: "get_digest_section",
      description: "Drill into one daily digest section.",
      parameters: {
        type: "OBJECT",
        properties: {
          section: {
            type: "STRING",
            description: "social, email, texts, transactions, pipeline, or business_health",
          },
        },
        required: ["section"],
      },
    },
    {
      name: "get_weekly_kpi",
      description: "Latest weekly KPI scorecard with week-over-week trends.",
      parameters: { type: "OBJECT", properties: {}, required: [] },
    },
    {
      name: "get_anomalies",
      description: "Anomalies from the latest daily digest.",
      parameters: { type: "OBJECT", properties: {}, required: [] },
    },
    {
      name: "get_finance_overview",
      description: "Finance overview — GCI, expenses, projection, pace.",
      parameters: { type: "OBJECT", properties: {}, required: [] },
    },
    {
      name: "get_gci_summary",
      description: "GCI tracker summary.",
      parameters: { type: "OBJECT", properties: {}, required: [] },
    },
    {
      name: "get_expense_summary",
      description: "Expense tracker summary.",
      parameters: { type: "OBJECT", properties: {}, required: [] },
    },
    {
      name: "get_pipeline_projection",
      description: "Weighted pipeline GCI projection.",
      parameters: { type: "OBJECT", properties: {}, required: [] },
    },
    {
      name: "get_pace_status",
      description: "Monthly GCI pace vs goal.",
      parameters: { type: "OBJECT", properties: {}, required: [] },
    },
    {
      name: "get_email_marketing_overview",
      description:
        "Get email marketing stats — emails sent, open rate, reply rate, active drip sequences, recent activity, and cached Gmail inbox.",
      parameters: { type: "OBJECT", properties: {}, required: [] },
    },
    {
      name: "gmail_list_inbox",
      description: "List recent Gmail messages from Marco's inbox.",
      parameters: {
        type: "OBJECT",
        properties: {
          limit: { type: "NUMBER", description: "Max messages" },
          query: { type: "STRING", description: "Gmail search query" },
          live: { type: "BOOLEAN", description: "Force live pull" },
        },
        required: [],
      },
    },
    {
      name: "gmail_get_message",
      description: "Get full Gmail message by id.",
      parameters: {
        type: "OBJECT",
        properties: { message_id: { type: "STRING", description: "Gmail message id" } },
        required: ["message_id"],
      },
    },
    {
      name: "gmail_sync_inbox",
      description: "Sync Gmail inbox and match inbound replies to leads.",
      parameters: {
        type: "OBJECT",
        properties: { max_results: { type: "NUMBER" } },
        required: [],
      },
    },
    {
      name: "get_sent_email_detail",
      description: "Get full logged marketing email by local id.",
      parameters: {
        type: "OBJECT",
        properties: { email_id: { type: "STRING" } },
        required: ["email_id"],
      },
    },
    {
      name: "gmail_send",
      description:
        "Send an email from Marco's Gmail when Marco explicitly asks. Requires to, subject, and body.",
      parameters: {
        type: "OBJECT",
        properties: {
          to: { type: "STRING", description: "Recipient email" },
          subject: { type: "STRING", description: "Subject line" },
          body: { type: "STRING", description: "Email body" },
          html: { type: "BOOLEAN", description: "True if body is HTML" },
        },
        required: ["to", "subject", "body"],
      },
    },
  ],
};

function normalizeHarveyToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  if (out.lead_id != null && out.leadId == null) {
    out.leadId = out.lead_id;
  }
  if (out.message_id != null && out.messageId == null) {
    out.messageId = out.message_id;
  }
  if (out.email_id != null && out.emailId == null) {
    out.emailId = out.email_id;
  }
  if (out.max_results != null && out.maxResults == null) {
    out.maxResults = out.max_results;
  }
  return out;
}

const NURTURE_WEIGHTS = {
  timeline: 25,
  preApproval: 25,
  responseCount: 20,
  propertyViews: 15,
  showingRequests: 15,
};

function formatPreApproval(status: string | null | undefined): string {
  if (!status) return "Not set";
  if (status === "approved") return "Approved";
  if (status === "cash") return "Cash buyer";
  if (status === "in_progress") return "In progress";
  return "Not approved";
}

function formatShowing(appt: { confirmationStatus?: string; address?: string } | null | undefined): string {
  if (!appt) return "No showing";
  const st = appt.confirmationStatus || "pending";
  const addr = appt.address ? ` · ${appt.address.slice(0, 24)}` : "";
  return `${st}${addr}`;
}

async function enrichNurtureLeadScore(
  scoreEntry: LeadScoreEntry,
  leadMap: Map<string, Awaited<ReturnType<typeof listAllLeads>>[number]>,
) {
  const lead = leadMap.get(scoreEntry.leadId);
  const inboundReplyCount = getInboundMessageCount(scoreEntry.leadId);
  const propertyViewsCount =
    typeof lead?.propertyViewsCount === "number" && lead.propertyViewsCount > 0
      ? lead.propertyViewsCount
      : (lead?.activity ?? []).filter((a) =>
          ["home_clicked", "home_hearted", "web_visit"].includes(a.type),
        ).length;

  return {
    leadId: scoreEntry.leadId,
    score: scoreEntry.score,
    previousScore: scoreEntry.previousScore,
    scoreDate: scoreEntry.scoreDate,
    tier: scoreEntry.tier,
    scoringFactors: scoreEntry.scoringFactors,
    factorMax: NURTURE_WEIGHTS,
    realNumbers: {
      timeline: lead?.criteria?.timeline || null,
      preApprovalStatus: lead?.preApprovalStatus || null,
      inboundReplyCount,
      propertyViewsCount,
      showingStatus: lead?.showingAppointment?.confirmationStatus || null,
      showingAddress: lead?.showingAppointment?.address || null,
    },
    name: lead?.name || lead?.username || "Unknown",
    phone: lead?.phone || null,
    email: lead?.email || null,
    source: lead?.source || null,
    crmIntent: lead?.crmIntent || null,
    automationPaused: lead?.automationPaused || false,
  };
}

export async function executeHarveyTool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const normalized = normalizeHarveyToolInput(input);
  // Platform surfaces (tracker / tasks / team / settings) live in their own module.
  if (PLATFORM_TOOL_NAMES.has(name)) return executePlatformTool(name, normalized);
  switch (name) {
    case "get_lead_summary":
      return getLeadSummary();
    case "get_hot_leads":
      return getHotLeads();
    case "get_funnel_stats":
      return getFunnelStats();
    case "search_leads":
      return searchLeads(String(normalized.query ?? ""));
    case "get_conversation":
      return getConversationForLead(String(normalized.leadId ?? ""));
    case "get_stalled_leads":
      return getStalledLeads();
    case "get_social_summary": {
      const summary = getSocialSummaryForHarvey() as Record<string, unknown>;
      const stats = summary.stats as Record<string, unknown> | undefined;
      const profile = summary.profile as Record<string, unknown> | undefined;
      console.log("[Harvey Tools] get_social_summary result:");
      console.log("  dataAvailable:", summary.dataAvailable);
      console.log("  avgViews:", stats?.avgViewsPerVideo ?? summary.avg_views);
      console.log("  followers:", profile?.followers ?? summary.follower_count);
      console.log("  videosTracked:", stats?.videosTracked ?? summary.total_videos);
      console.log("  pulledAt:", summary.pulledAt ?? summary.fetchedAt);
      return summary;
    }
    case "get_social_videos":
      return getSocialVideosForHarvey(normalized);
    case "get_morning_scan": {
      const scan = getLatestMorningScan();
      return { result: scan };
    }
    case "get_pending_comment_replies": {
      return { replies: getPendingCommentReplies() };
    }
    case "get_evening_pull": {
      return getLatestReportingSnapshot("evening");
    }
    case "get_content_suggestions": {
      return getLatestContentSuggestions();
    }
    case "get_content_digest": {
      return getLatestContentDigest();
    }
    case "get_recent_escalations": {
      return { escalations: getRecentEscalations(10) };
    }
    case "get_upcoming_showings": {
      const upcoming = await getUpcomingShowings();
      return { upcoming };
    }
    case "get_mojo_outreach_status": {
      return await getMojoOutreachStatus();
    }
    case "get_paused_conversations": {
      const leads = (await listAllLeads()).filter((l) => l.automationPaused);
      return {
        paused: leads.map((l) => ({
          leadId: l.id,
          name: l.name || l.username,
          reason: l.automationPausedReason,
          pausedAt: l.automationPausedAt,
        })),
      };
    }
    case "get_transactions_overview": {
      const transactions = getAllTransactions();
      const upcoming = getUpcomingDeadlines(7);
      const overdue = getOverdueDeadlines();
      return {
        activeCount: transactions.filter((t) =>
          ["active", "under_contract", "pending"].includes(t.status),
        ).length,
        closedCount: transactions.filter((t) => t.status === "closed").length,
        upcomingDeadlines: upcoming.length,
        overdueDeadlines: overdue.length,
        transactions: transactions.map((t) => ({
          address: t.address,
          status: t.status,
          closingDate: t.closingDate,
          price: t.price,
        })),
      };
    }
    case "get_upcoming_deadlines": {
      const days = typeof normalized.days === "number" ? normalized.days : 7;
      const deadlines = getUpcomingDeadlines(days);
      return {
        deadlines: deadlines.map((d) => {
          const tx = getTransaction(d.dealId);
          return { ...d, address: tx?.address };
        }),
      };
    }
    case "get_overdue_items": {
      const deadlines = getOverdueDeadlines();
      const documents = getUnsignedDocuments();
      return {
        overdueDeadlines: deadlines.map((d) => {
          const tx = getTransaction(d.dealId);
          return { ...d, address: tx?.address };
        }),
        unsignedDocuments: documents.map((doc) => {
          const tx = getTransaction(doc.dealId);
          return { ...doc, address: tx?.address };
        }),
      };
    }
    case "get_transaction_flow_status": {
      const transactions = getAllTransactions();
      return {
        inInspectionPeriod: transactions
          .filter(
            (t) => t.inspectionFlow?.scheduledAt && !t.inspectionFlow?.sellerResponseReceivedAt,
          )
          .map((t) => ({
            address: t.address,
            status: t.inspectionFlow?.sellerResponseStatus,
            confirmedParties: t.inspectionFlow?.scheduleConfirmedParties,
          })),
        inFinalWeek: transactions
          .filter(
            (t) => t.finalWeekFlow?.closingDisclosureReminderSentAt && !t.postCloseFlow?.congratulationsSentAt,
          )
          .map((t) => ({ address: t.address, closingDate: t.closingDate })),
        recentlyClosed: transactions
          .filter((t) => t.postCloseFlow?.congratulationsSentAt)
          .map((t) => ({
            address: t.address,
            congratsAt: t.postCloseFlow?.congratulationsSentAt,
          })),
      };
    }
    case "get_lead_nurture_overview": {
      const hot = getLeadsByTier("hot").sort((a, b) => b.score - a.score);
      const warm = getLeadsByTier("warm");
      const cold = getLeadsByTier("cold");
      const all = await listAllLeads();
      const leadMap = new Map(all.map((l) => [l.id, l]));
      const scoredIds = new Set([...hot, ...warm, ...cold].map((s) => s.leadId));
      const topHot = hot[0] ? await enrichNurtureLeadScore(hot[0], leadMap) : null;
      return {
        hotCount: hot.length,
        warmCount: warm.length,
        coldCount: cold.length,
        unscoredCount: Math.max(0, all.length - scoredIds.size),
        totalLeads: all.length,
        topHotLead: topHot,
        hotLeads: await Promise.all(hot.slice(0, 5).map((s) => enrichNurtureLeadScore(s, leadMap))),
      };
    }
    case "get_lead_nurture_tier": {
      const tier = String(normalized.tier || "").trim().toLowerCase() as "hot" | "warm" | "cold";
      if (!["hot", "warm", "cold"].includes(tier)) {
        return { error: "tier must be hot, warm, or cold" };
      }
      const limit = Number(normalized.limit) || 15;
      const entries = getLeadsByTier(tier).sort((a, b) => b.score - a.score).slice(0, limit);
      const all = await listAllLeads();
      const leadMap = new Map(all.map((l) => [l.id, l]));
      return {
        tier,
        count: entries.length,
        leads: await Promise.all(entries.map((s) => enrichNurtureLeadScore(s, leadMap))),
      };
    }
    case "get_lead_score_detail": {
      const leadId = String(normalized.leadId || "").trim();
      if (!leadId) return { error: "lead_id required" };
      const latest = getLatestScore(leadId);
      const history = getScoreHistory(leadId, 10);
      const lead = await getLeadById(leadId);
      if (!latest && !lead) return { error: "Lead not found", leadId };
      const leadMap = new Map(lead ? [[lead.id, lead]] : []);
      return {
        lead: lead
          ? {
              id: lead.id,
              name: lead.name || lead.username,
              phone: lead.phone,
              source: lead.source,
            }
          : null,
        latest: latest ? await enrichNurtureLeadScore(latest, leadMap) : null,
        history: history.map((h) => ({
          score: h.score,
          tier: h.tier,
          scoreDate: h.scoreDate,
          scoringFactors: h.scoringFactors,
        })),
      };
    }
    case "lead_nurture_score_all": {
      return scoreAllLeads();
    }
    case "lead_nurture_rescore_cold": {
      return scoreColdLeads();
    }
    case "lead_nurture_route_lead": {
      const leadId = String(normalized.leadId || "").trim();
      if (!leadId) return { error: "lead_id required" };
      const lead = await getLeadById(leadId);
      if (!lead) return { error: "Lead not found", leadId };
      await routeNewLead(lead);
      return { success: true, leadId, source: lead.source };
    }
    case "get_lead_nurture_routing": {
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
        .slice(0, 15)
        .map((l) => ({
          leadId: l.id,
          name: l.name || l.username,
          source: l.source,
          phone: l.phone,
          routedAt: l.sourceRoutingCompletedAt,
        }));
      return { sourceActivity, routed };
    }
    case "get_daily_digest": {
      const snapshot = getLatestSnapshot("daily_digest");
      if (!snapshot) return { message: "No daily digest generated yet — will be available after 7am Central." };
      return {
        data: snapshot.data,
        anomalies: snapshot.anomalies,
        generatedAt: snapshot.generatedAt,
      };
    }
    case "get_digest_section": {
      const snapshot = getLatestSnapshot("daily_digest");
      if (!snapshot) return { message: "No daily digest available yet." };
      const sectionRaw = String(normalized.section || "").trim().toLowerCase();
      const sectionKey =
        sectionRaw === "business_health" ? "businessHealth" : sectionRaw;
      const data = snapshot.data as DailyDigestData;
      const sectionData = (data as unknown as Record<string, unknown>)[sectionKey];
      if (!sectionData) {
        return {
          message:
            "Unknown section. Valid: social, email, texts, transactions, pipeline, business_health",
        };
      }
      return {
        section: sectionRaw,
        data: sectionData,
        anomaliesForSection: (snapshot.anomalies || []).filter((a) =>
          a.field.startsWith(sectionKey) || a.field.startsWith(sectionRaw),
        ),
      };
    }
    case "get_weekly_kpi": {
      const snapshot = getLatestSnapshot("weekly_kpi");
      if (!snapshot) return { message: "No weekly KPI available yet — runs every Friday at 5pm Central." };
      return snapshot.data;
    }
    case "get_anomalies": {
      const snapshot = getLatestSnapshot("daily_digest");
      if (!snapshot) return { anomalies: [] };
      const anomalies = snapshot.anomalies || [];
      return {
        total: anomalies.length,
        critical: anomalies.filter((a) => a.severity === "critical"),
        warnings: anomalies.filter((a) => a.severity === "warning"),
      };
    }
    case "get_finance_overview": {
      return {
        gci: getGCISummary(),
        expenses: await getExpenseSummary(),
        projection: generatePipelineProjection(),
        pace: getCurrentPaceStatus(),
      };
    }
    case "get_gci_summary": {
      return getGCISummary();
    }
    case "get_expense_summary": {
      return await getExpenseSummary();
    }
    case "get_pipeline_projection": {
      return generatePipelineProjection();
    }
    case "get_pace_status": {
      return getCurrentPaceStatus();
    }
    case "get_email_marketing_overview": {
      const { getEmailStats, getRecentEmails, countActiveDripSequences } = await import(
        "../core/emailStore.js"
      );
      const { getGmailInboxForHarvey } = await import("../agents/emailMarketing/gmailSync.js");
      const stats = getEmailStats(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
      const recent = getRecentEmails(10);
      const inbox = getGmailInboxForHarvey(10);
      return {
        last30Days: stats,
        activeDrips: countActiveDripSequences(),
        recentEmails: recent.map((e) => ({
          id: e.id,
          subject: e.subject,
          type: e.emailType,
          status: e.sendStatus,
          sentAt: e.sentAt,
          repliedAt: e.repliedAt,
        })),
        gmailInbox: inbox,
      };
    }
    case "gmail_list_inbox": {
      const limit = Number(normalized.limit) || 15;
      const query = normalized.query ? String(normalized.query) : undefined;
      const live = normalized.live === true;
      const { getCachedGmailMessages } = await import("../core/emailStore.js");
      const { listGmailMessages } = await import("../integrations/gmail/inbox.js");
      const { isGmailConfigured } = await import("../integrations/gmail/index.js");
      if (!isGmailConfigured()) return { error: "Gmail not configured" };
      let messages = getCachedGmailMessages(limit);
      if (live || messages.length === 0) {
        const liveMsgs = await listGmailMessages({ maxResults: limit, query });
        return { live: true, messages: liveMsgs };
      }
      return { cached: true, messages };
    }
    case "gmail_get_message": {
      const messageId = String(normalized.messageId || "").trim();
      if (!messageId) return { error: "message_id required" };
      const { getGmailMessage } = await import("../integrations/gmail/inbox.js");
      const { isGmailConfigured } = await import("../integrations/gmail/index.js");
      if (!isGmailConfigured()) return { error: "Gmail not configured" };
      const msg = await getGmailMessage(messageId);
      return {
        id: msg.id,
        subject: msg.subject,
        from: msg.from,
        to: msg.to,
        date: msg.date,
        direction: msg.direction,
        body: msg.bodyText,
      };
    }
    case "gmail_sync_inbox": {
      const { syncGmailInbox } = await import("../agents/emailMarketing/gmailSync.js");
      const maxResults = Number(normalized.maxResults) || 30;
      return syncGmailInbox({ maxResults });
    }
    case "get_sent_email_detail": {
      const emailId = String(normalized.emailId || "").trim();
      if (!emailId) return { error: "email_id required" };
      const { getEmailById } = await import("../core/emailStore.js");
      const email = getEmailById(emailId);
      if (!email) return { error: "Email not found", emailId };
      return email;
    }
    case "get_crm_automation_notifications": {
      const unreadOnly =
        normalized.unread_only === false || normalized.unreadOnly === false ? false : true;
      const limit = Number(normalized.limit) || 20;
      const list = unreadOnly ? getUnreadNotifications(limit) : getAllNotifications(limit);
      return {
        count: list.length,
        unreadOnly,
        notifications: list.map((n) => ({
          id: n.id,
          leadId: n.leadId,
          type: n.notificationType,
          message: n.message,
          read: n.read,
          createdAt: n.createdAt,
        })),
      };
    }
    case "trigger_website_revisit": {
      const leadId = String(normalized.leadId || normalized.lead_id || "").trim();
      if (!leadId) return { error: "lead_id required" };
      const lead = await getLeadById(leadId);
      if (!lead) return { error: "Lead not found", leadId };
      return handleWebsiteVisit(leadId);
    }
    case "update_seller_listing_status": {
      const leadId = String(normalized.leadId || normalized.lead_id || "").trim();
      const address = String(normalized.address || "").trim();
      const status = String(normalized.status || "").trim() as ListingStatusValue;
      const allowed = new Set(["active", "pending", "off_market", "expired", "sold"]);
      if (!leadId) return { error: "lead_id required" };
      if (!address) return { error: "address required" };
      if (!allowed.has(status)) return { error: "Invalid status" };
      const lead = await getLeadById(leadId);
      if (!lead) return { error: "Lead not found", leadId };
      const source = normalized.source === "mls_feed" ? "mls_feed" : "manual";
      return handleListingStatusUpdate(leadId, address, status, source);
    }
    case "get_content_summary": {
      const daily = getDailyReport();
      const weekly = getWeeklyReport();
      return {
        today: daily,
        weekly,
        summary: {
          videosPublished: daily.targets.videosPublished,
          videosTarget: daily.targets.videosTarget,
          phoneNumbersCaptured: daily.targets.phoneNumbersCaptured,
          phoneNumbersTarget: daily.targets.phoneNumbersTarget,
          commentsManaged: daily.targets.commentsManaged,
          dmsTriaged: daily.targets.dmsTriaged,
          topVideos: daily.topVideos,
          bottomVideos: daily.bottomVideos,
          weeklyVideosPublished: weekly.totalVideosPublished,
          weeklyVideoTarget: weekly.weeklyVideoTarget,
          weeklyPhonesCaptured: weekly.totalPhoneNumbersCaptured,
          weeklyPhoneTarget: weekly.weeklyPhoneTarget,
          belowBenchmarkFlags: weekly.consistentlyBelowBenchmark,
        },
      };
    }
    case "get_content_pipeline": {
      const status = normalized.status as
        | "pending_review"
        | "approved"
        | "scheduled"
        | "published"
        | "rejected"
        | undefined;
      const limit = Number(normalized.limit) || 20;
      const videos = listContentVideos(status ? { status, limit } : { limit });
      return {
        count: videos.length,
        videos: videos.map((v) => ({
          id: v.id,
          title: v.title,
          caption: v.caption,
          hook: v.hook,
          pillar: v.pillar,
          platform_target: v.platformTarget,
          status: v.status,
          compliance_flagged: v.complianceFlagged,
          scheduled_for: v.scheduledFor,
          published_at: v.publishedAt,
        })),
      };
    }
    case "get_content_compliance_queue": {
      const pending = listPendingComplianceQueue();
      return {
        count: pending.length,
        pending,
      };
    }
    case "get_content_manager_status": {
      const today = todayDateCst();
      return {
        latestBriefing: getLatestBriefing(),
        todayStrategy: getDailyStrategy(today),
        dailyTargets: ensureDailyTargets(today),
        performanceModel: getPerformanceModel(),
      };
    }
    case "ask_content_manager": {
      const question = String(normalized.question ?? "").trim();
      if (!question) return { error: "question required" };
      const answer = await contentManagerBrain.chat(question);
      return { answer };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function getLeadSummary(): Promise<unknown> {
  const leads = await listAllLeads();
  const byPlatform = { instagram: 0, tiktok: 0, other: 0 };
  const byFunnelStage: Record<string, number> = {};
  const byAdCampaign = { canyon_lake_ad: 0, low_interest_ad: 0, unknown: 0 };
  let phonesCaptured = 0;
  let emailsCaptured = 0;

  for (const lead of leads) {
    byPlatform[platformBucket(lead.platform)]++;
    const stage = String(lead.state);
    byFunnelStage[stage] = (byFunnelStage[stage] ?? 0) + 1;
    const ad = adCampaignBucket(lead.adCampaign);
    if (ad === "canyon_lake_ad") byAdCampaign.canyon_lake_ad++;
    else if (ad === "low_interest_ad") byAdCampaign.low_interest_ad++;
    else byAdCampaign.unknown++;
    if (lead.phone?.trim()) phonesCaptured++;
    if (lead.email?.trim()) emailsCaptured++;
  }

  return {
    totalLeads: leads.length,
    byPlatform,
    byFunnelStage,
    byAdCampaign,
    phonesCaptured,
    emailsCaptured,
  };
}

async function getHotLeads(): Promise<unknown> {
  const leads = await listAllLeads();
  const hot = leads.filter(isHotLead);
  const rows = await Promise.all(
    hot.map(async (lead) => {
      const anchor = lead.updatedAt || lead.createdAt;
      return {
        id: lead.id,
        name: leadDisplayName(lead),
        phone: lead.phone,
        platform: platformBucket(lead.platform),
        adCampaign: adCampaignBucket(lead.adCampaign),
        funnelStage: String(lead.state),
        daysSincePhoneCaptured: daysSince(anchor),
      };
    }),
  );
  rows.sort((a, b) => b.daysSincePhoneCaptured - a.daysSincePhoneCaptured);
  return { count: rows.length, leads: rows };
}

async function getFunnelStats(): Promise<unknown> {
  const leads = await listAllLeads();
  const countByStage: Record<string, number> = {};
  const todayStart = startOfTodayUtc();
  let addedToday = 0;
  let inPhoneFunnel = 0;

  for (const lead of leads) {
    const stage = String(lead.state);
    countByStage[stage] = (countByStage[stage] ?? 0) + 1;
    if (POST_PHONE_STAGES.has(stage)) inPhoneFunnel++;
    if (lead.createdAt >= todayStart) addedToday++;
  }

  const total = leads.length;
  const phoneCaptureRatePct =
    total > 0 ? Math.round((100 * inPhoneFunnel) / total) : 0;

  return {
    countByStage,
    phoneCaptureRatePct,
    phoneCaptureNumerator: inPhoneFunnel,
    totalLeads: total,
    leadsAddedToday: addedToday,
    leadsAllTime: total,
  };
}

async function searchLeads(query: string): Promise<unknown> {
  const q = query.trim();
  if (!q) return { matches: [], query: q };
  const leads = await listAllLeads();
  const matches = leads.filter((l) => fuzzyMatchLead(l, q)).slice(0, 20);
  const rows = await Promise.all(
    matches.map(async (lead) => {
      const conv = await getConversation(lead.id);
      const lastTwo = conv.messages.slice(-2).map((m) => ({
        role: m.role,
        text: m.text,
        at: m.at,
      }));
      return {
        id: lead.id,
        name: leadDisplayName(lead),
        phone: lead.phone,
        platform: platformBucket(lead.platform),
        stage: String(lead.state),
        adCampaign: adCampaignBucket(lead.adCampaign),
        conversationSnippet: lastTwo,
      };
    }),
  );
  return { query: q, count: rows.length, matches: rows };
}

async function getConversationForLead(leadId: string): Promise<unknown> {
  const id = leadId.trim();
  if (!id) return { error: "Missing leadId" };
  const leads = await listAllLeads();
  const lead = leads.find((l) => l.id === id);
  if (!lead) return { error: "Lead not found", leadId: id };
  const conv = await getConversation(id);
  const lines: string[] = [];
  for (const m of conv.messages) {
    const who = m.role === "user" ? "Lead" : "Marco";
    lines.push(`${who} (${m.at}): ${m.text}`);
  }
  return {
    leadId: id,
    name: leadDisplayName(lead),
    platform: lead.platform,
    stage: String(lead.state),
    messageCount: conv.messages.length,
    thread: lines.join("\n"),
    messages: conv.messages,
  };
}

async function getStalledLeads(): Promise<unknown> {
  const leads = await listAllLeads();
  const stalledStages = new Set(["new", "opening_asked_first_time"]);
  const rows = leads
    .filter((lead) => {
      if (!stalledStages.has(String(lead.state))) return false;
      return hoursSince(lead.updatedAt || lead.createdAt) >= 48;
    })
    .map((lead) => ({
      id: lead.id,
      name: leadDisplayName(lead),
      platform: platformBucket(lead.platform),
      stage: String(lead.state),
      adCampaign: adCampaignBucket(lead.adCampaign),
      hoursSinceActivity: Math.round(hoursSince(lead.updatedAt || lead.createdAt)),
      updatedAt: lead.updatedAt,
    }));
  rows.sort((a, b) => b.hoursSinceActivity - a.hoursSinceActivity);
  return { count: rows.length, leads: rows };
}

function getSocialVideosForHarvey(input: Record<string, unknown>): unknown {
  const tierRaw = input.tier;
  let tier: string | undefined;
  if (tierRaw === "hot" || tierRaw === "average" || tierRaw === "cold" || tierRaw === "warm") {
    tier = tierRaw === "average" ? "warm" : String(tierRaw);
  }
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.min(100, Math.max(1, Math.floor(input.limit)))
      : 10;
  const days =
    typeof input.days === "number" && Number.isFinite(input.days)
      ? Math.max(1, Math.floor(input.days))
      : undefined;

  const videos = getSocialVideos({ tier, limit, days });
  console.log("[Harvey] get_social_videos called, returned:", videos.length, "videos");
  return {
    count: videos.length,
    videos: videos.map((v) => ({
      url: v.url,
      caption: v.caption,
      postedAt: v.postedAt,
      views: v.views,
      likes: v.likes,
      comments: v.comments,
      shares: v.shares,
      saves: v.saves,
      score: v.score,
      tier: v.tier,
      viral: v.viral,
      scoreBreakdown: v.scoreBreakdown,
    })),
  };
}
