"use strict";
/**
 * Harvey chat tools — Anthropic tool definitions + DB-backed executors.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HARVEY_GEMINI_TOOLS = exports.HARVEY_TOOL_DEFINITIONS = void 0;
exports.executeHarveyTool = executeHarveyTool;
const smsStore_js_1 = require("../core/smsStore.js");
const db_js_1 = require("../core/db.js");
const socialStore_js_1 = require("../core/socialStore.js");
const index_js_1 = require("../agents/morningScan/index.js");
const index_js_2 = require("../agents/reporting/index.js");
const index_js_3 = require("../agents/contentSuggestions/index.js");
const index_js_4 = require("../agents/escalations/index.js");
const index_js_5 = require("../agents/showingReminders/index.js");
const index_js_6 = require("../agents/mojoOutreach/index.js");
const transactionsStore_js_1 = require("../core/transactionsStore.js");
const index_js_7 = require("../agents/harveyContentDigest/index.js");
const leadScoreStore_js_1 = require("../core/leadScoreStore.js");
const MS_48H = 48 * 60 * 60 * 1000;
const POST_PHONE_STAGES = new Set([
    "phone_captured",
    "property_sent",
    "criteria_collected",
    "email_sent",
]);
function hoursSince(iso) {
    if (!iso)
        return 9999;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t))
        return 9999;
    return (Date.now() - t) / (60 * 60 * 1000);
}
function daysSince(iso) {
    return Math.floor(hoursSince(iso) / 24);
}
function platformBucket(platform) {
    const p = (platform || "").toLowerCase();
    if (p.includes("insta"))
        return "instagram";
    if (p.includes("tik"))
        return "tiktok";
    return "other";
}
function adCampaignBucket(ad) {
    if (ad === "canyon_lake_ad" || ad === "low_interest_ad")
        return ad;
    return "unknown";
}
function leadDisplayName(lead) {
    return lead.name || lead.username || null;
}
function leadHasSmsOutbound(lead) {
    const thread = (0, smsStore_js_1.getThreadForLead)(lead.id, 50);
    return thread.some((m) => m.direction === "outbound");
}
function isHotLead(lead) {
    if (!lead.phone?.trim())
        return false;
    if (leadHasSmsOutbound(lead))
        return false;
    if (lead.crmStatus === "dead")
        return false;
    return lead.crmStatus === "not_contacted";
}
function normalizeQuery(q) {
    return q.trim().toLowerCase();
}
function phoneDigits(phone) {
    if (!phone)
        return "";
    return phone.replace(/\D/g, "");
}
function fuzzyMatchLead(lead, query) {
    const q = normalizeQuery(query);
    if (!q)
        return false;
    const parts = [
        lead.name,
        lead.username,
        lead.phone,
        leadDisplayName(lead),
    ]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase());
    for (const p of parts) {
        if (p.includes(q))
            return true;
    }
    const digits = phoneDigits(lead.phone);
    const qDigits = q.replace(/\D/g, "");
    if (qDigits.length >= 3 && digits.includes(qDigits))
        return true;
    const nameParts = (lead.name || "").toLowerCase().split(/\s+/);
    for (const np of nameParts) {
        if (np.length >= 2 && np.includes(q))
            return true;
    }
    return false;
}
function startOfTodayUtc() {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
}
exports.HARVEY_TOOL_DEFINITIONS = [
    {
        name: "get_lead_summary",
        description: "Totals and breakdowns: all leads, by platform (instagram/tiktok), funnel stage, ad campaign, phones and emails captured.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_hot_leads",
        description: "Leads with phone on file who have not been texted via SMS yet (no outbound SMS thread).",
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
        description: "Leads stuck in new or opening_asked_first_time with no activity in 48+ hours.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_social_summary",
        description: "Get Marco's TikTok social media performance summary including views, engagement, content patterns, and week-over-week trends. Use when Marco asks about his content, TikTok performance, social media stats, or how his videos are doing.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_social_videos",
        description: "Get a list of Marco's TikTok videos filtered by performance tier and time period. Use when Marco asks about his best videos, worst videos, recent videos, or wants to see specific video performance.",
        input_schema: {
            type: "object",
            properties: {
                tier: {
                    type: "string",
                    enum: ["hot", "average", "warm", "cold"],
                    description: "Performance tier — hot=top performers, average/warm=mid tier, cold=underperformers",
                },
                limit: { type: "number", description: "Number of videos to return (default 10)" },
                days: { type: "number", description: "Only return videos from the last N days" },
            },
            required: [],
        },
    },
    {
        name: "get_morning_scan",
        description: "Get the latest overnight scan results — new comments, mentions, and flagged lead-intent messages from TikTok/Instagram that need attention.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_pending_comment_replies",
        description: "Get comment replies that are pending review, especially negative comments that need human approval before being sent.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_evening_pull",
        description: "Get the latest evening performance report — last 7 days video scores, top performer, and underperformers.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_content_suggestions",
        description: "Get this week's AI-generated content ideas for TikTok based on recent performance data and current trends.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_content_digest",
        description: "Get the latest content performance digest — a summary of TikTok stats, top/underperforming videos, escalations, and content ideas, updated every 3 days.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_recent_escalations",
        description: "Get recent escalation alerts — negative comments needing review, strong lead intent in DMs, or videos going viral.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_upcoming_showings",
        description: "Get all upcoming property showings with confirmation status — which leads have confirmed, which are pending, which need follow-up.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_mojo_outreach_status",
        description: "Get status of Mojo cold lead outreach sequences — how many leads are in sequence, paused, replied, or completed.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_paused_conversations",
        description: "Get leads where automation has been paused due to escalation — ready to make an offer, angry client, or legal question. These need Marco's personal attention.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_transactions_overview",
        description: "Get an overview of all active transactions — addresses, status, closing dates, and how many deadlines are upcoming or overdue.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_upcoming_deadlines",
        description: "Get transaction deadlines coming up in the next N days across all deals — inspections, appraisals, closings, etc.",
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
        description: "Get all overdue transaction deadlines and unsigned documents that need immediate attention.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_transaction_flow_status",
        description: "Get the status of in-progress transaction workflows — inspection periods, final week prep, and post-close follow-ups across all active deals.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_lead_nurture_overview",
        description: "Get an overview of lead scoring and nurture status — how many hot/warm/cold leads, recent tier distribution, and nurture activity.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
];
exports.HARVEY_GEMINI_TOOLS = {
    functionDeclarations: [
        {
            name: "get_lead_summary",
            description: "Get a summary of all leads in the CRM pipeline including counts by stage and funnel position.",
            parameters: {
                type: "OBJECT",
                properties: {},
                required: [],
            },
        },
        {
            name: "get_hot_leads",
            description: "Get the list of hot leads — leads with phone captured who need immediate follow up.",
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
            description: "Get leads that have gone cold or stalled in the pipeline with no recent activity.",
            parameters: {
                type: "OBJECT",
                properties: {},
                required: [],
            },
        },
        {
            name: "get_social_summary",
            description: "Get live TikTok social media performance data from Apify including current avg views per video, total views, followers, top performing videos, and content patterns. Always call this for TikTok performance questions.",
            parameters: {
                type: "OBJECT",
                properties: {},
                required: [],
            },
        },
        {
            name: "get_social_videos",
            description: "Get a list of TikTok videos filtered by performance tier. Use for questions about best videos, worst videos, or recent video performance.",
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
            description: "Get the latest overnight scan — new comments, mentions, and lead-intent flags from social platforms.",
            parameters: {
                type: "OBJECT",
                properties: {},
                required: [],
            },
        },
        {
            name: "get_pending_comment_replies",
            description: "Get comment replies pending review, especially negative comments needing human approval.",
            parameters: {
                type: "OBJECT",
                properties: {},
                required: [],
            },
        },
        {
            name: "get_evening_pull",
            description: "Get the latest evening performance report — last 7 days scores, top performer, underperformers.",
            parameters: {
                type: "OBJECT",
                properties: {},
                required: [],
            },
        },
        {
            name: "get_content_suggestions",
            description: "Get this week's AI-generated TikTok content ideas based on recent performance and trends.",
            parameters: {
                type: "OBJECT",
                properties: {},
                required: [],
            },
        },
        {
            name: "get_content_digest",
            description: "Get the latest content performance digest — TikTok stats, top/underperforming videos, escalations, and content ideas (updated every 3 days).",
            parameters: {
                type: "OBJECT",
                properties: {},
                required: [],
            },
        },
        {
            name: "get_recent_escalations",
            description: "Get recent escalation alerts for negative comments, lead intent, or viral spikes.",
            parameters: {
                type: "OBJECT",
                properties: {},
                required: [],
            },
        },
        {
            name: "get_upcoming_showings",
            description: "Get all upcoming property showings with confirmation status — confirmed, pending, or needing follow-up.",
            parameters: {
                type: "OBJECT",
                properties: {},
                required: [],
            },
        },
        {
            name: "get_mojo_outreach_status",
            description: "Get status of Mojo cold lead outreach sequences — active, paused, replied, or completed.",
            parameters: {
                type: "OBJECT",
                properties: {},
                required: [],
            },
        },
        {
            name: "get_paused_conversations",
            description: "Get leads where SMS automation is paused due to escalation — offer intent, angry client, or legal question.",
            parameters: {
                type: "OBJECT",
                properties: {},
                required: [],
            },
        },
        {
            name: "get_transactions_overview",
            description: "Overview of active transactions — status, closing dates, upcoming and overdue deadline counts.",
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
            description: "Get the status of in-progress transaction workflows — inspection periods, final week prep, and post-close follow-ups across all active deals.",
            parameters: {
                type: "OBJECT",
                properties: {},
                required: [],
            },
        },
        {
            name: "get_lead_nurture_overview",
            description: "Overview of lead scoring and nurture — hot/warm/cold counts and recent hot lead scores.",
            parameters: {
                type: "OBJECT",
                properties: {},
                required: [],
            },
        },
    ],
};
function normalizeHarveyToolInput(input) {
    const out = { ...input };
    if (out.lead_id != null && out.leadId == null) {
        out.leadId = out.lead_id;
    }
    return out;
}
async function executeHarveyTool(name, input) {
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
            const summary = (0, socialStore_js_1.getSocialSummaryForHarvey)();
            const stats = summary.stats;
            const profile = summary.profile;
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
            const scan = (0, index_js_1.getLatestMorningScan)();
            return { result: scan };
        }
        case "get_pending_comment_replies": {
            return { replies: (0, socialStore_js_1.getPendingCommentReplies)() };
        }
        case "get_evening_pull": {
            return (0, index_js_2.getLatestReportingSnapshot)("evening");
        }
        case "get_content_suggestions": {
            return (0, index_js_3.getLatestContentSuggestions)();
        }
        case "get_content_digest": {
            return (0, index_js_7.getLatestContentDigest)();
        }
        case "get_recent_escalations": {
            return { escalations: (0, index_js_4.getRecentEscalations)(10) };
        }
        case "get_upcoming_showings": {
            const upcoming = await (0, index_js_5.getUpcomingShowings)();
            return { upcoming };
        }
        case "get_mojo_outreach_status": {
            return await (0, index_js_6.getMojoOutreachStatus)();
        }
        case "get_paused_conversations": {
            const leads = (await (0, db_js_1.listAllLeads)()).filter((l) => l.automationPaused);
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
            const transactions = (0, transactionsStore_js_1.getAllTransactions)();
            const upcoming = (0, transactionsStore_js_1.getUpcomingDeadlines)(7);
            const overdue = (0, transactionsStore_js_1.getOverdueDeadlines)();
            return {
                activeCount: transactions.filter((t) => ["active", "under_contract", "pending"].includes(t.status)).length,
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
            const deadlines = (0, transactionsStore_js_1.getUpcomingDeadlines)(days);
            return {
                deadlines: deadlines.map((d) => {
                    const tx = (0, transactionsStore_js_1.getTransaction)(d.dealId);
                    return { ...d, address: tx?.address };
                }),
            };
        }
        case "get_overdue_items": {
            const deadlines = (0, transactionsStore_js_1.getOverdueDeadlines)();
            const documents = (0, transactionsStore_js_1.getUnsignedDocuments)();
            return {
                overdueDeadlines: deadlines.map((d) => {
                    const tx = (0, transactionsStore_js_1.getTransaction)(d.dealId);
                    return { ...d, address: tx?.address };
                }),
                unsignedDocuments: documents.map((doc) => {
                    const tx = (0, transactionsStore_js_1.getTransaction)(doc.dealId);
                    return { ...doc, address: tx?.address };
                }),
            };
        }
        case "get_transaction_flow_status": {
            const transactions = (0, transactionsStore_js_1.getAllTransactions)();
            return {
                inInspectionPeriod: transactions
                    .filter((t) => t.inspectionFlow?.scheduledAt && !t.inspectionFlow?.sellerResponseReceivedAt)
                    .map((t) => ({
                    address: t.address,
                    status: t.inspectionFlow?.sellerResponseStatus,
                    confirmedParties: t.inspectionFlow?.scheduleConfirmedParties,
                })),
                inFinalWeek: transactions
                    .filter((t) => t.finalWeekFlow?.closingDisclosureReminderSentAt && !t.postCloseFlow?.congratulationsSentAt)
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
            const hot = (0, leadScoreStore_js_1.getLeadsByTier)("hot");
            const warm = (0, leadScoreStore_js_1.getLeadsByTier)("warm");
            const cold = (0, leadScoreStore_js_1.getLeadsByTier)("cold");
            return {
                hotCount: hot.length,
                warmCount: warm.length,
                coldCount: cold.length,
                hotLeads: hot.map((s) => ({ leadId: s.leadId, score: s.score })),
            };
        }
        default:
            return { error: `Unknown tool: ${name}` };
    }
}
async function getLeadSummary() {
    const leads = await (0, db_js_1.listAllLeads)();
    const byPlatform = { instagram: 0, tiktok: 0, other: 0 };
    const byFunnelStage = {};
    const byAdCampaign = { canyon_lake_ad: 0, low_interest_ad: 0, unknown: 0 };
    let phonesCaptured = 0;
    let emailsCaptured = 0;
    for (const lead of leads) {
        byPlatform[platformBucket(lead.platform)]++;
        const stage = String(lead.state);
        byFunnelStage[stage] = (byFunnelStage[stage] ?? 0) + 1;
        const ad = adCampaignBucket(lead.adCampaign);
        if (ad === "canyon_lake_ad")
            byAdCampaign.canyon_lake_ad++;
        else if (ad === "low_interest_ad")
            byAdCampaign.low_interest_ad++;
        else
            byAdCampaign.unknown++;
        if (lead.phone?.trim())
            phonesCaptured++;
        if (lead.email?.trim())
            emailsCaptured++;
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
async function getHotLeads() {
    const leads = await (0, db_js_1.listAllLeads)();
    const hot = leads.filter(isHotLead);
    const rows = await Promise.all(hot.map(async (lead) => {
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
    }));
    rows.sort((a, b) => b.daysSincePhoneCaptured - a.daysSincePhoneCaptured);
    return { count: rows.length, leads: rows };
}
async function getFunnelStats() {
    const leads = await (0, db_js_1.listAllLeads)();
    const countByStage = {};
    const todayStart = startOfTodayUtc();
    let addedToday = 0;
    let inPhoneFunnel = 0;
    for (const lead of leads) {
        const stage = String(lead.state);
        countByStage[stage] = (countByStage[stage] ?? 0) + 1;
        if (POST_PHONE_STAGES.has(stage))
            inPhoneFunnel++;
        if (lead.createdAt >= todayStart)
            addedToday++;
    }
    const total = leads.length;
    const phoneCaptureRatePct = total > 0 ? Math.round((100 * inPhoneFunnel) / total) : 0;
    return {
        countByStage,
        phoneCaptureRatePct,
        phoneCaptureNumerator: inPhoneFunnel,
        totalLeads: total,
        leadsAddedToday: addedToday,
        leadsAllTime: total,
    };
}
async function searchLeads(query) {
    const q = query.trim();
    if (!q)
        return { matches: [], query: q };
    const leads = await (0, db_js_1.listAllLeads)();
    const matches = leads.filter((l) => fuzzyMatchLead(l, q)).slice(0, 20);
    const rows = await Promise.all(matches.map(async (lead) => {
        const conv = await (0, db_js_1.getConversation)(lead.id);
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
    }));
    return { query: q, count: rows.length, matches: rows };
}
async function getConversationForLead(leadId) {
    const id = leadId.trim();
    if (!id)
        return { error: "Missing leadId" };
    const leads = await (0, db_js_1.listAllLeads)();
    const lead = leads.find((l) => l.id === id);
    if (!lead)
        return { error: "Lead not found", leadId: id };
    const conv = await (0, db_js_1.getConversation)(id);
    const lines = [];
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
async function getStalledLeads() {
    const leads = await (0, db_js_1.listAllLeads)();
    const stalledStages = new Set(["new", "opening_asked_first_time"]);
    const rows = leads
        .filter((lead) => {
        if (!stalledStages.has(String(lead.state)))
            return false;
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
function getSocialVideosForHarvey(input) {
    const tierRaw = input.tier;
    let tier;
    if (tierRaw === "hot" || tierRaw === "average" || tierRaw === "cold" || tierRaw === "warm") {
        tier = tierRaw === "average" ? "warm" : String(tierRaw);
    }
    const limit = typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.min(100, Math.max(1, Math.floor(input.limit)))
        : 10;
    const days = typeof input.days === "number" && Number.isFinite(input.days)
        ? Math.max(1, Math.floor(input.days))
        : undefined;
    const videos = (0, socialStore_js_1.getSocialVideos)({ tier, limit, days });
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
