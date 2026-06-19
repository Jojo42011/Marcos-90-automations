import {
  getLatestSocialDashboardData,
  getLatestMorningScanFromDb,
  type SocialDashboardVideo,
} from "../../core/socialStore.js";
import { getLatestReportingSnapshot } from "./index.js";
import { getSmsDb } from "../../core/smsStore.js";
import {
  getAllTransactions,
  getUpcomingDeadlines,
  getOverdueDeadlines,
} from "../../core/transactionsStore.js";
import { listAllLeads } from "../../core/db.js";
import { getLeadsByTier, getScoreEntriesSince } from "../../core/leadScoreStore.js";
import { getTierForScore } from "../leadScoring/index.js";
import { centralDateString, startOfCentralDayIso } from "./centralTime.js";
import type {
  SocialSection,
  EmailSection,
  TextsSection,
  TransactionsSection,
  PipelineSection,
  BusinessHealthSection,
} from "../../core/reportingStore.js";

function videoCaption(v: SocialDashboardVideo): string {
  return (v.caption || "").trim();
}

function videoScore(v: SocialDashboardVideo): number {
  return v.scoreBreakdown?.score ?? v.score ?? 0;
}

export function collectSocialSection(): SocialSection {
  try {
    const data = getLatestSocialDashboardData();
    const videos = data.videos || [];

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentVideos = videos.filter((v) => new Date(v.postedAt || 0).getTime() >= sevenDaysAgo);

    const avgViews =
      recentVideos.length > 0
        ? Math.round(
            recentVideos.reduce((s, v) => s + (v.views || 0), 0) / recentVideos.length,
          )
        : data.summary?.avgViews ?? 0;

    const sorted = [...videos].sort((a, b) => (b.views || 0) - (a.views || 0));
    const top = sorted[0];
    const topPost = top
      ? {
          description: videoCaption(top).substring(0, 80),
          views: top.views || 0,
          score: videoScore(top),
        }
      : null;

    const morning = getLatestMorningScanFromDb();
    const evening = getLatestReportingSnapshot("evening");

    let followersChangeWeek = 0;
    if (evening?.data && typeof evening.data === "object") {
      const prevFollowers = (evening.data as Record<string, unknown>).followerCount;
      if (typeof prevFollowers === "number" && data.profile?.followers) {
        followersChangeWeek = data.profile.followers - prevFollowers;
      }
    }

    return {
      followers: data.profile?.followers ?? 0,
      followersChangeWeek,
      avgViewsLast7Days: avgViews,
      topPost,
      newDmLeads: morning?.newComments ?? 0,
      leadIntentFlags: morning?.leadIntentFlags?.length ?? 0,
    };
  } catch (err) {
    console.error("[Reporting] Social section error:", err);
    return {
      followers: 0,
      followersChangeWeek: 0,
      avgViewsLast7Days: 0,
      topPost: null,
      newDmLeads: 0,
      leadIntentFlags: 0,
    };
  }
}

export async function collectEmailSection(): Promise<EmailSection> {
  try {
    const { getEmailStats, countActiveDripSequences } = await import("../../core/emailStore.js");
    const todayStart = startOfCentralDayIso();
    const stats = getEmailStats(todayStart);

    const openRate =
      stats.sent > 0 ? Math.round((stats.opened / stats.sent) * 100) / 100 : null;

    return {
      sent: stats.sent,
      openRate,
      replies: stats.replied,
      sequences: countActiveDripSequences(),
      gap: stats.sent === 0 ? "No emails sent yet today." : "",
    };
  } catch (err) {
    console.error("[Reporting] Email section error:", err);
    return { sent: 0, openRate: null, replies: 0, sequences: 0, gap: "Email data unavailable." };
  }
}

export async function collectTextsSection(): Promise<TextsSection> {
  try {
    const db = getSmsDb();
    const todayStartIso = startOfCentralDayIso();

    const sentRow = db
      .prepare(
        `SELECT COUNT(*) AS count FROM sms_threads WHERE direction = 'outbound' AND sent_at >= ?`,
      )
      .get(todayStartIso) as { count: number };
    const receivedRow = db
      .prepare(
        `SELECT COUNT(*) AS count FROM sms_threads WHERE direction = 'inbound' AND sent_at >= ?`,
      )
      .get(todayStartIso) as { count: number };

    const sentToday = Number(sentRow.count) || 0;
    const receivedToday = Number(receivedRow.count) || 0;
    const replyRate = sentToday > 0 ? Math.round((receivedToday / sentToday) * 100) / 100 : 0;

    const leads = await listAllLeads();
    const appointmentsBooked = leads.filter((l) => {
      if (!l.showingAppointment?.scheduledAt) return false;
      return new Date(l.showingAppointment.scheduledAt).getTime() >= new Date(todayStartIso).getTime();
    }).length;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const activeRow = db
      .prepare(`SELECT COUNT(DISTINCT lead_id) AS count FROM sms_threads WHERE sent_at >= ?`)
      .get(sevenDaysAgo) as { count: number };

    return {
      sentToday,
      receivedToday,
      replyRate,
      appointmentsBooked,
      activeThreads: Number(activeRow.count) || 0,
    };
  } catch (err) {
    console.error("[Reporting] Texts section error:", err);
    return {
      sentToday: 0,
      receivedToday: 0,
      replyRate: 0,
      appointmentsBooked: 0,
      activeThreads: 0,
    };
  }
}

export function collectTransactionsSection(): TransactionsSection {
  try {
    const all = getAllTransactions();

    const dealsInEscrow = all.filter((t) => t.status === "under_contract").length;

    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const closingsThisWeek = all.filter(
      (t) =>
        t.closingDate &&
        new Date(t.closingDate).getTime() >= now &&
        new Date(t.closingDate).getTime() <= now + sevenDaysMs,
    ).length;

    const upcoming = getUpcomingDeadlines(2);
    const deadlinesIn48Hours = upcoming.map((d) => {
      const tx = all.find((t) => t.id === d.dealId);
      return {
        address: tx?.address || "Unknown",
        label: d.label || d.deadlineType,
        dueDate: d.dueDate,
      };
    });

    const missedDeadlines = getOverdueDeadlines().length;

    return { dealsInEscrow, closingsThisWeek, deadlinesIn48Hours, missedDeadlines };
  } catch (err) {
    console.error("[Reporting] Transactions section error:", err);
    return { dealsInEscrow: 0, closingsThisWeek: 0, deadlinesIn48Hours: [], missedDeadlines: 0 };
  }
}

export async function collectPipelineSection(): Promise<PipelineSection> {
  try {
    const todayStartIso = startOfCentralDayIso();
    const todayDateStr = centralDateString();

    const leads = await listAllLeads();
    const newLeadsToday = leads.filter((l) => {
      if (!l.createdAt) return false;
      const createdCentral = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Chicago",
      }).format(new Date(l.createdAt));
      return createdCentral === todayDateStr;
    }).length;

    const hotLeads = getLeadsByTier("hot").length;
    const warmLeads = getLeadsByTier("warm").length;
    const coldLeads = getLeadsByTier("cold").length;

    const tierMovements = getScoreEntriesSince(todayStartIso);
    let promotedToHotToday = 0;
    let goneColdToday = 0;

    for (const movement of tierMovements) {
      const prevTier = getTierForScore(movement.previousScore ?? 0);
      const newTier = movement.tier;
      if (newTier === "hot" && prevTier !== "hot") promotedToHotToday++;
      if (newTier === "cold" && prevTier !== "cold") goneColdToday++;
    }

    return {
      newLeadsToday,
      totalLeads: leads.length,
      hotLeads,
      warmLeads,
      coldLeads,
      promotedToHotToday,
      goneColdToday,
    };
  } catch (err) {
    console.error("[Reporting] Pipeline section error:", err);
    return {
      newLeadsToday: 0,
      totalLeads: 0,
      hotLeads: 0,
      warmLeads: 0,
      coldLeads: 0,
      promotedToHotToday: 0,
      goneColdToday: 0,
    };
  }
}

function transactionGci(price: number | undefined, commissionPercent: number | undefined): number {
  if (!price || !Number.isFinite(price)) return 0;
  const pct = commissionPercent ?? 3;
  return Math.round((price * pct) / 100);
}

export function collectBusinessHealthSection(): BusinessHealthSection {
  try {
    const all = getAllTransactions();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);

    const pipelineGCI = all
      .filter((t) => ["active", "under_contract", "pending"].includes(t.status) && t.price)
      .reduce((sum, t) => sum + transactionGci(t.price, t.parties?.commissionPercent), 0);

    const mtdClosed = all.filter(
      (t) =>
        t.status === "closed" &&
        t.closingDate &&
        new Date(t.closingDate) >= monthStart,
    );
    const mtdClosedVolume = mtdClosed.reduce((s, t) => s + (t.price || 0), 0);
    const mtdClosedGCI = mtdClosed.reduce(
      (s, t) => s + transactionGci(t.price, t.parties?.commissionPercent),
      0,
    );

    const ytdClosed = all.filter(
      (t) =>
        t.status === "closed" &&
        t.closingDate &&
        new Date(t.closingDate) >= yearStart,
    );
    const ytdClosedGCI = ytdClosed.reduce(
      (s, t) => s + transactionGci(t.price, t.parties?.commissionPercent),
      0,
    );

    return {
      pipelineGCI: Math.round(pipelineGCI),
      mtdClosedVolume: Math.round(mtdClosedVolume),
      mtdClosedGCI: Math.round(mtdClosedGCI),
      ytdClosedGCI: Math.round(ytdClosedGCI),
      anomalyFlag: false,
    };
  } catch (err) {
    console.error("[Reporting] Business health error:", err);
    return {
      pipelineGCI: 0,
      mtdClosedVolume: 0,
      mtdClosedGCI: 0,
      ytdClosedGCI: 0,
      anomalyFlag: false,
    };
  }
}
