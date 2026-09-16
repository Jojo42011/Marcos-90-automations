/**
 * Harvey perception — fresh business snapshot each request.
 *
 * SPEED NOTE (2026-09-16): chatting used to call getConversation for every
 * lead on the board. Aggregates never needed message counts — only the capped
 * list slices do. So we summarize lite for the whole board and only open
 * conversations for a shortlist (recent + opening-state + sparse no-touch
 * candidates), capped at MAX_CONV_SUMMARIES.
 */

import { getDashboardSnapshot, listAllLeads, getConversation } from "../core/db.js";
import type { Lead } from "../core/types.js";
import { isAnthropicApiKeyConfigured } from "../integrations/llm/index.js";
import { isTwilioConfigured } from "../integrations/twilio/index.js";
import {
  fetchAdsSummaryFromUpstream,
  adsTotalsToHarveySnapshot,
  type AdsUpstreamSummary,
} from "./adsUpstream.js";
import type { HarveyContext, HarveyLeadSummary, HarveyMetricsPanel } from "./types.js";

const MS_24H = 24 * 60 * 60 * 1000;
/** Hard cap on conversation reads per perception pass. */
const MAX_CONV_SUMMARIES = 60;

function hoursSince(iso: string | null | undefined): number {
  if (!iso) return 9999;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 9999;
  return (Date.now() - t) / (60 * 60 * 1000);
}

function platformBucket(platform: string): "instagram" | "tiktok" | "other" {
  const p = (platform || "").toLowerCase();
  if (p.includes("insta")) return "instagram";
  if (p.includes("tik")) return "tiktok";
  return "other";
}

function leadDisplayName(lead: Lead): string | null {
  return lead.name || lead.username || null;
}

function summarizeLeadLite(lead: Lead): HarveyLeadSummary {
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
    userMessageCount: 0,
    assistantMessageCount: 0,
    lastMessageAt: null,
    updatedAt,
    hoursSinceUpdate: hoursSince(updatedAt),
  };
}

async function summarizeLeadWithConv(lead: Lead): Promise<HarveyLeadSummary> {
  const base = summarizeLeadLite(lead);
  const conv = await getConversation(lead.id);
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let lastMessageAt: string | null = null;
  for (const m of conv.messages) {
    if (m.role === "user") userMessageCount++;
    else assistantMessageCount++;
    if (m.at && (!lastMessageAt || m.at > lastMessageAt)) lastMessageAt = m.at;
  }
  return { ...base, userMessageCount, assistantMessageCount, lastMessageAt };
}

export type PerceptionDeps = {
  adDashboardBaseUrl: string;
  adDashboardApiKey: string;
};

export async function buildHarveyContext(deps: PerceptionDeps): Promise<HarveyContext> {
  const [snapshot, allLeadsRaw] = await Promise.all([getDashboardSnapshot(), listAllLeads()]);
  const byId = new Map(allLeadsRaw.map((l) => [l.id, l]));
  const lite = allLeadsRaw.map(summarizeLeadLite);

  /* Shortlist who actually needs a conversation read for the returned lists. */
  const openingStates = new Set([
    "opening_asked_first_time",
    "opening_offered_details",
    "new",
  ]);
  const recentIds = [...lite]
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, 20)
    .map((s) => s.id);
  const openingIds = lite
    .filter((s) => openingStates.has(s.funnelState) && s.crmStatus !== "dead")
    .sort((a, b) => a.hoursSinceUpdate - b.hoursSinceUpdate)
    .map((s) => s.id);
  const noTouchIds = lite
    .filter((s) => s.crmStatus !== "dead" && s.crmStatus !== "not_contacted")
    .sort((a, b) => b.hoursSinceUpdate - a.hoursSinceUpdate)
    .map((s) => s.id);

  const needConv: string[] = [];
  const seen = new Set<string>();
  for (const id of [...recentIds, ...openingIds, ...noTouchIds]) {
    if (seen.has(id)) continue;
    seen.add(id);
    needConv.push(id);
    if (needConv.length >= MAX_CONV_SUMMARIES) break;
  }

  const convSummaries = await Promise.all(
    needConv.map((id) => summarizeLeadWithConv(byId.get(id)!)),
  );
  const richById = new Map(convSummaries.map((s) => [s.id, s]));
  const allSummaries = lite.map((s) => richById.get(s.id) || s);

  let adsRaw: AdsUpstreamSummary | null = null;
  const adsLinked = Boolean(deps.adDashboardBaseUrl.trim());
  if (adsLinked) {
    try {
      adsRaw = await fetchAdsSummaryFromUpstream(deps.adDashboardBaseUrl, deps.adDashboardApiKey);
    } catch {
      adsRaw = null;
    }
  }

  const byPlatform = { instagram: 0, tiktok: 0, other: 0 };
  const funnelDistribution: Record<string, number> = {};
  const crmStatusBreakdown: Record<string, number> = {};
  const crmStageBreakdown: Record<string, number> = {};
  const callQueue = { urgent: 0, routine: 0, none: 0 };

  let phonesLast24h = 0;
  const now = Date.now();

  for (const s of allSummaries) {
    byPlatform[platformBucket(s.platform)]++;
    funnelDistribution[s.funnelState] = (funnelDistribution[s.funnelState] ?? 0) + 1;
    crmStatusBreakdown[s.crmStatus] = (crmStatusBreakdown[s.crmStatus] ?? 0) + 1;
    crmStageBreakdown[s.crmStage] = (crmStageBreakdown[s.crmStage] ?? 0) + 1;
    if (s.crmCallQueue === "urgent") callQueue.urgent++;
    else if (s.crmCallQueue === "routine") callQueue.routine++;
    else callQueue.none++;

    if (s.hasPhone && s.updatedAt) {
      const t = new Date(s.updatedAt).getTime();
      if (Number.isFinite(t) && now - t <= MS_24H) phonesLast24h++;
    }
  }

  const totalAll = snapshot.totals.leads;
  const withPhone = snapshot.totals.withPhone;
  const phoneCaptureRatePct =
    totalAll > 0 ? Math.round((100 * withPhone) / totalAll) : 0;

  const byAd = snapshot.byAdCampaign || {};
  const byAdPhone = snapshot.byAdCampaignWithPhone || {};
  const canyon = byAd.canyon_lake_ad ?? 0;
  const lowInt = byAd.low_interest_ad ?? 0;
  const attributed = canyon + lowInt;

  const hotLeads = allSummaries.filter(
    (s) =>
      s.hasPhone &&
      s.crmStatus !== "dead" &&
      (s.crmStatus === "not_contacted" || s.crmStatus === "contacted"),
  );

  const noInteractionLeads = allSummaries.filter((s) => {
    if (s.crmStatus === "dead") return false;
    if (s.crmStatus === "not_contacted") return true;
    /* Without a conversation read we cannot claim msgCount===0 honestly —
       only include sparse rows we actually summarized. */
    if (!richById.has(s.id)) return s.hoursSinceUpdate >= 336;
    const msgCount = s.userMessageCount + s.assistantMessageCount;
    if (msgCount === 0) return true;
    return s.hoursSinceUpdate >= 336;
  });

  const stalledOpeningLeads = allSummaries.filter((s) => {
    if (!openingStates.has(s.funnelState)) return false;
    if (!richById.has(s.id)) return false;
    if (s.userMessageCount === 0) return false;
    return s.hoursSinceUpdate >= 48 && s.assistantMessageCount > 0;
  });

  const recentLeads = [...allSummaries]
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, 20)
    .map((s) => richById.get(s.id) || s);

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
    ads: adsTotalsToHarveySnapshot(adsRaw, adsLinked),
    systems: {
      anthropicConfigured: isAnthropicApiKeyConfigured(),
      twilioConfigured: isTwilioConfigured(),
      sendblueConfigured: isTwilioConfigured(),
      adsLinked,
    },
  };
}

export function contextToMetricsPanel(ctx: HarveyContext): HarveyMetricsPanel {
  const hotNeedsSms = ctx.hotLeads.filter(
    (l) => l.crmStatus === "not_contacted" || l.crmStatus === "contacted",
  ).length;
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
