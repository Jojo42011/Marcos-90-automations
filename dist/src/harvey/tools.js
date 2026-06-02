"use strict";
/**
 * Harvey chat tools — Anthropic tool definitions + DB-backed executors.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HARVEY_TOOL_DEFINITIONS = void 0;
exports.executeHarveyTool = executeHarveyTool;
const db_js_1 = require("../core/db.js");
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
function sendblueThreadId(lead) {
    const raw = lead;
    const v = raw.sendblueThreadId;
    return typeof v === "string" && v.trim() ? v.trim() : null;
}
function isHotLead(lead) {
    if (!lead.phone?.trim())
        return false;
    if (sendblueThreadId(lead))
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
        description: "Leads with phone on file who have not been texted on Sendblue yet (no SMS thread).",
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
];
async function executeHarveyTool(name, input) {
    switch (name) {
        case "get_lead_summary":
            return getLeadSummary();
        case "get_hot_leads":
            return getHotLeads();
        case "get_funnel_stats":
            return getFunnelStats();
        case "search_leads":
            return searchLeads(String(input.query ?? ""));
        case "get_conversation":
            return getConversationForLead(String(input.leadId ?? ""));
        case "get_stalled_leads":
            return getStalledLeads();
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
