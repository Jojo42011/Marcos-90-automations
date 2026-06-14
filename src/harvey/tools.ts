/**
 * Harvey chat tools — Anthropic tool definitions + DB-backed executors.
 */

import { getConversation, listAllLeads } from "../core/db.js";
import { getSocialSummaryForHarvey, getSocialVideos, getPendingCommentReplies } from "../core/socialStore.js";
import { getLatestMorningScan } from "../agents/morningScan/index.js";
import { getLatestReportingSnapshot } from "../agents/reporting/index.js";
import { getLatestContentSuggestions } from "../agents/contentSuggestions/index.js";
import { getRecentEscalations } from "../agents/escalations/index.js";
import { getLatestContentDigest } from "../agents/harveyContentDigest/index.js";
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

function sendblueThreadId(lead: Lead): string | null {
  const raw = lead as Lead & { sendblueThreadId?: string | null };
  const v = raw.sendblueThreadId;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function isHotLead(lead: Lead): boolean {
  if (!lead.phone?.trim()) return false;
  if (sendblueThreadId(lead)) return false;
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
      "Leads with phone on file who have not been texted on Sendblue yet (no SMS thread).",
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
  ],
};

function normalizeHarveyToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  if (out.lead_id != null && out.leadId == null) {
    out.leadId = out.lead_id;
  }
  return out;
}

export async function executeHarveyTool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const normalized = normalizeHarveyToolInput(input);
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
