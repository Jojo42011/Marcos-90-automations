"use strict";
/**
 * Harvey perception — fresh business snapshot each request.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildHarveyContext = buildHarveyContext;
exports.contextToMetricsPanel = contextToMetricsPanel;
const db_js_1 = require("../core/db.js");
const index_js_1 = require("../integrations/llm/index.js");
const index_js_2 = require("../integrations/twilio/index.js");
const adsUpstream_js_1 = require("./adsUpstream.js");
const MS_24H = 24 * 60 * 60 * 1000;
function hoursSince(iso) {
    if (!iso)
        return 9999;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t))
        return 9999;
    return (Date.now() - t) / (60 * 60 * 1000);
}
function platformBucket(platform) {
    const p = (platform || "").toLowerCase();
    if (p.includes("insta"))
        return "instagram";
    if (p.includes("tik"))
        return "tiktok";
    return "other";
}
function leadDisplayName(lead) {
    return lead.name || lead.username || null;
}
async function summarizeLead(lead) {
    const conv = await (0, db_js_1.getConversation)(lead.id);
    let userMessageCount = 0;
    let assistantMessageCount = 0;
    let lastMessageAt = null;
    for (const m of conv.messages) {
        if (m.role === "user")
            userMessageCount++;
        else
            assistantMessageCount++;
        if (m.at && (!lastMessageAt || m.at > lastMessageAt))
            lastMessageAt = m.at;
    }
    const updatedAt = lead.updatedAt || lead.createdAt;
    return {
        id: lead.id,
        name: leadDisplayName(lead),
        username: lead.username,
        platform: lead.platform,
        phone: lead.phone,
        email: lead.email,
        funnelState: String(lead.state),
        crmStatus: lead.crmStatus,
        crmStage: lead.crmStage,
        crmIntent: lead.crmIntent,
        crmCallQueue: lead.crmCallQueue,
        adCampaign: lead.adCampaign,
        hasPhone: Boolean(lead.phone?.trim()),
        userMessageCount,
        assistantMessageCount,
        lastMessageAt,
        updatedAt,
        hoursSinceUpdate: hoursSince(updatedAt),
    };
}
async function buildHarveyContext(deps) {
    const [snapshot, allLeadsRaw] = await Promise.all([(0, db_js_1.getDashboardSnapshot)(), (0, db_js_1.listAllLeads)()]);
    const allSummaries = await Promise.all(allLeadsRaw.map((l) => summarizeLead(l)));
    let adsRaw = null;
    const adsLinked = Boolean(deps.adDashboardBaseUrl.trim());
    if (adsLinked) {
        try {
            adsRaw = await (0, adsUpstream_js_1.fetchAdsSummaryFromUpstream)(deps.adDashboardBaseUrl, deps.adDashboardApiKey);
        }
        catch {
            adsRaw = null;
        }
    }
    const byPlatform = { instagram: 0, tiktok: 0, other: 0 };
    const funnelDistribution = {};
    const crmStatusBreakdown = {};
    const crmStageBreakdown = {};
    const callQueue = { urgent: 0, routine: 0, none: 0 };
    let phonesLast24h = 0;
    const now = Date.now();
    for (const s of allSummaries) {
        byPlatform[platformBucket(s.platform)]++;
        funnelDistribution[s.funnelState] = (funnelDistribution[s.funnelState] ?? 0) + 1;
        crmStatusBreakdown[s.crmStatus] = (crmStatusBreakdown[s.crmStatus] ?? 0) + 1;
        crmStageBreakdown[s.crmStage] = (crmStageBreakdown[s.crmStage] ?? 0) + 1;
        if (s.crmCallQueue === "urgent")
            callQueue.urgent++;
        else if (s.crmCallQueue === "routine")
            callQueue.routine++;
        else
            callQueue.none++;
        if (s.hasPhone && s.updatedAt) {
            const t = new Date(s.updatedAt).getTime();
            if (Number.isFinite(t) && now - t <= MS_24H)
                phonesLast24h++;
        }
    }
    const totalAll = snapshot.totals.leads;
    const withPhone = snapshot.totals.withPhone;
    const phoneCaptureRatePct = totalAll > 0 ? Math.round((100 * withPhone) / totalAll) : 0;
    const byAd = snapshot.byAdCampaign || {};
    const byAdPhone = snapshot.byAdCampaignWithPhone || {};
    const canyon = byAd.canyon_lake_ad ?? 0;
    const lowInt = byAd.low_interest_ad ?? 0;
    const attributed = canyon + lowInt;
    const hotLeads = allSummaries.filter((s) => s.hasPhone &&
        s.crmStatus !== "dead" &&
        (s.crmStatus === "not_contacted" || s.crmStatus === "contacted"));
    const noInteractionLeads = allSummaries.filter((s) => {
        if (s.crmStatus === "dead")
            return false;
        if (s.crmStatus === "not_contacted")
            return true;
        const msgCount = s.userMessageCount + s.assistantMessageCount;
        if (msgCount === 0)
            return true;
        return s.hoursSinceUpdate >= 336;
    });
    const stalledOpeningLeads = allSummaries.filter((s) => {
        const openingStates = [
            "opening_asked_first_time",
            "opening_offered_details",
            "new",
        ];
        if (!openingStates.includes(s.funnelState))
            return false;
        if (s.userMessageCount === 0)
            return false;
        return s.hoursSinceUpdate >= 48 && s.assistantMessageCount > 0;
    });
    const recentLeads = [...allSummaries]
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
        .slice(0, 20);
    return {
        generatedAt: snapshot.generatedAt,
        totals: {
            allLeads: totalAll,
            withPhone,
            withEmail: snapshot.totals.withEmail,
            phoneCaptureRatePct,
            phonesLast24h,
        },
        byPlatform,
        byAdCampaign: {
            canyon_lake_ad: canyon,
            low_interest_ad: lowInt,
            unattributed: Math.max(0, totalAll - attributed),
            canyonWithPhone: byAdPhone.canyon_lake_ad ?? 0,
            lowInterestWithPhone: byAdPhone.low_interest_ad ?? 0,
        },
        funnelDistribution,
        crmStatusBreakdown,
        crmStageBreakdown,
        callQueue,
        hotLeads: hotLeads.slice(0, 12),
        noInteractionLeads: noInteractionLeads.slice(0, 12),
        stalledOpeningLeads: stalledOpeningLeads.slice(0, 8),
        recentLeads,
        ads: (0, adsUpstream_js_1.adsTotalsToHarveySnapshot)(adsRaw, adsLinked),
        systems: {
            anthropicConfigured: (0, index_js_1.isAnthropicApiKeyConfigured)(),
            twilioConfigured: (0, index_js_2.isTwilioConfigured)(),
            sendblueConfigured: (0, index_js_2.isTwilioConfigured)(),
            adsLinked,
        },
    };
}
function contextToMetricsPanel(ctx) {
    const hotNeedsSms = ctx.hotLeads.filter((l) => l.crmStatus === "not_contacted" || l.crmStatus === "contacted").length;
    return {
        totalLeads: ctx.totals.allLeads,
        phonesCaptured: ctx.totals.withPhone,
        emailsCaptured: ctx.totals.withEmail,
        instagram: ctx.byPlatform.instagram,
        tiktok: ctx.byPlatform.tiktok,
        canyonLakeAd: ctx.byAdCampaign.canyon_lake_ad,
        lowInterestAd: ctx.byAdCampaign.low_interest_ad,
        noInteraction: ctx.noInteractionLeads.length,
        hotNeedsSms,
        phoneCaptureRatePct: ctx.totals.phoneCaptureRatePct,
        phonesLast24h: ctx.totals.phonesLast24h,
    };
}
