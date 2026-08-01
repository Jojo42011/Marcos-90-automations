import { listAllLeads, getLeadById, getInboundDmCount } from "../../core/db.js";
import { getInboundMessageCount } from "../../core/smsStore.js";
import {
  recordLeadScore,
  getLatestScore,
  getLeadsByTier,
  getLastRescoreRunAt,
  recordRescoreRun,
} from "../../core/leadScoreStore.js";
import { triggerHotLeadAlert } from "../leadNurture/hotLeadFlow.js";
import type { Lead } from "../../core/types.js";
import type { ScoringFactors } from "../../core/leadScoreStore.js";

/** Weights sum to 100. Timeline + pre-approval need manual CRM fields to score > 0. */
export const WEIGHTS = {
  timeline: 25,
  preApproval: 25,
  responseCount: 20,
  propertyViews: 15,
  showingRequests: 15,
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function scoreTimeline(lead: Lead): number {
  const timeline = (lead.criteria?.timeline ?? "").toLowerCase().trim();
  if (!timeline) return 0;

  if (/asap|immediately|now|this month|urgent/.test(timeline)) return WEIGHTS.timeline;
  if (/1-3 months|soon|next few months|1 to 3/.test(timeline)) return Math.round(WEIGHTS.timeline * 0.7);
  if (/3-6 months|3 to 6/.test(timeline)) return Math.round(WEIGHTS.timeline * 0.4);
  if (/6\+|6 plus|just looking|exploring|no rush/.test(timeline)) return Math.round(WEIGHTS.timeline * 0.1);

  return Math.round(WEIGHTS.timeline * 0.3);
}

function scorePreApproval(lead: Lead): number {
  const status = lead.preApprovalStatus;
  if (!status) return 0;

  if (status === "approved" || status === "cash") return WEIGHTS.preApproval;
  if (status === "in_progress") return Math.round(WEIGHTS.preApproval * 0.5);
  if (status === "not_approved") return Math.round(WEIGHTS.preApproval * 0.1);

  return 0;
}

/**
 * How engaged this lead is, measured on the channel they actually used.
 *
 * This read `sms_threads` alone, which is why every one of 1,306 leads scored
 * 0/100 and the board showed ZERO hot leads: Twilio is not configured in
 * production, so that table is empty, while the entire funnel runs on Instagram
 * and TikTok DMs. A lead who had replied fifteen times scored the same as one
 * who never answered. Twenty of the hundred points were dead.
 *
 * Both channels now count, and the higher wins rather than the sum: a lead who
 * moved from DM to text is one conversation, not two, and adding them would
 * quietly reward channel-switching over actual interest.
 */
function scoreResponseCount(leadId: string): number {
  let sms = 0;
  try {
    sms = getInboundMessageCount(leadId);
  } catch {
    /* No SMS store configured is not a reason to score the DM history at zero. */
  }
  const inboundCount = Math.max(sms, getInboundDmCount(leadId));

  if (inboundCount === 0) return 0;
  if (inboundCount <= 2) return Math.round(WEIGHTS.responseCount * 0.4);
  if (inboundCount <= 5) return Math.round(WEIGHTS.responseCount * 0.7);
  return WEIGHTS.responseCount;
}

function countPropertyInterestSignals(lead: Lead): number {
  const manual =
    typeof lead.propertyViewsCount === "number" && lead.propertyViewsCount > 0
      ? lead.propertyViewsCount
      : 0;
  const fromActivity = (lead.activity ?? []).filter((a) =>
    ["home_clicked", "home_hearted", "web_visit"].includes(a.type),
  ).length;
  return Math.max(manual, fromActivity);
}

function scorePropertyViews(lead: Lead): number {
  const views = countPropertyInterestSignals(lead);
  if (views === 0) return 0;
  if (views <= 2) return Math.round(WEIGHTS.propertyViews * 0.5);
  return WEIGHTS.propertyViews;
}

function scoreShowingRequests(lead: Lead): number {
  if (!lead.showingAppointment) return 0;

  if (lead.showingAppointment.confirmationStatus === "confirmed") return WEIGHTS.showingRequests;
  if (lead.showingAppointment.confirmationStatus === "pending") {
    return Math.round(WEIGHTS.showingRequests * 0.7);
  }

  return Math.round(WEIGHTS.showingRequests * 0.3);
}

export function calculateLeadScore(lead: Lead): { score: number; factors: ScoringFactors } {
  const factors: ScoringFactors = {
    timeline: scoreTimeline(lead),
    preApproval: scorePreApproval(lead),
    responseCount: scoreResponseCount(lead.id),
    propertyViews: scorePropertyViews(lead),
    showingRequests: scoreShowingRequests(lead),
  };

  const score = Object.values(factors).reduce((sum, v) => sum + v, 0);
  return { score: Math.min(100, score), factors };
}

export function getTierForScore(score: number): "hot" | "warm" | "cold" {
  if (score >= 80) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}

export function scoreAndRecordLead(lead: Lead): {
  score: number;
  tier: "hot" | "warm" | "cold";
  previousScore?: number;
  tierChanged: boolean;
} {
  const previous = getLatestScore(lead.id);
  const { score, factors } = calculateLeadScore(lead);
  const tier = getTierForScore(score);

  recordLeadScore({
    leadId: lead.id,
    score,
    previousScore: previous?.score,
    scoreDate: new Date().toISOString(),
    scoringFactors: factors,
    tier,
  });

  const tierChanged = previous ? previous.tier !== tier : true;

  if (tier === "hot" && (!previous || previous.tier !== "hot")) {
    triggerHotLeadAlert(lead, score, factors).catch((err) => console.error("[HotLeadFlow]", err));
  }

  return { score, tier, previousScore: previous?.score, tierChanged };
}

export async function scoreAllLeads(): Promise<{
  scored: number;
  hot: number;
  warm: number;
  cold: number;
}> {
  const leads = await listAllLeads();
  let hot = 0;
  let warm = 0;
  let cold = 0;

  for (const lead of leads) {
    const { tier } = scoreAndRecordLead(lead);
    if (tier === "hot") hot++;
    else if (tier === "warm") warm++;
    else cold++;
  }

  console.log("[LeadScoring] Scored", leads.length, "leads —", hot, "hot,", warm, "warm,", cold, "cold");
  return { scored: leads.length, hot, warm, cold };
}

export async function scoreColdLeads(): Promise<{ rescored: number; promoted: number }> {
  const coldScores = getLeadsByTier("cold");
  let rescored = 0;
  let promoted = 0;

  for (const scoreEntry of coldScores) {
    const lead = await getLeadById(scoreEntry.leadId);
    if (!lead) continue;

    const { tier } = scoreAndRecordLead(lead);
    rescored++;
    if (tier !== "cold") promoted++;
  }

  console.log("[AutoRescore] Re-scored", rescored, "cold leads —", promoted, "promoted out of cold");
  return { rescored, promoted };
}

export async function checkAndRunAutoRescoreIfDue(): Promise<{
  ran: boolean;
  result?: { rescored: number; promoted: number };
}> {
  const lastRunAt = getLastRescoreRunAt();
  if (lastRunAt && Date.now() - new Date(lastRunAt).getTime() < THIRTY_DAYS_MS) {
    return { ran: false };
  }

  const result = await scoreColdLeads();
  recordRescoreRun(new Date().toISOString());
  return { ran: true, result };
}

let lastAutoRescoreCheckDate: string | null = null;

export function scheduleAutoRescore(): void {
  const checkAndRun = () => {
    const now = new Date();
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? -1);

    if (hour === 9 && minute >= 0 && minute < 2 && lastAutoRescoreCheckDate !== dateStr) {
      lastAutoRescoreCheckDate = dateStr;
      checkAndRunAutoRescoreIfDue().catch((err) => console.error("[AutoRescore]", err));
    }
  };

  setInterval(checkAndRun, 60 * 1000);
  console.log("[AutoRescore] Scheduled — checks daily at 9am Central, fires every 30 days");
}
