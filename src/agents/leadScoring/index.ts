import { listAllLeads, getLeadById, getInboundDmCount, getLastInboundDmAt } from "../../core/db.js";
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

/**
 * What makes a lead worth calling next.
 *
 * THE OLD MODEL COULD NOT PRODUCE A HOT LEAD. It put 50 of its 100 points on
 * `timeline` and `preApproval`, which the type itself documents as manual CRM
 * entries, and nobody fills them. Another 30 sat on property views and booked
 * showings, signals the Instagram/TikTok DM funnel never emits. So the ceiling
 * was 20/100 against a hot threshold of 80: every one of 1,306 leads scored
 * cold forever, and "0 hot leads" was an artefact of the scoring model rather
 * than a fact about the business.
 *
 * This model scores what the system ACTUALLY CAPTURES, automatically, on every
 * lead: did they reply, how far did they get, how recently, and can we phone
 * them. Those four reach 85 with no manual data entry at all, so hot is
 * genuinely reachable. The manual fields are kept, but demoted to a bonus, so a
 * CRM entry still helps and its absence no longer flattens everything.
 */
export const WEIGHTS = {
  /** Replies from the lead, on whichever channel they used. */
  engagement: 30,
  /** How deep into the funnel they got. */
  funnelDepth: 25,
  /** How recently they last spoke to us. */
  recency: 20,
  /** Phone on file, i.e. can this be acted on at all. */
  contactable: 10,
  /** Timeline, pre-approval, property views, booked showing: bonuses now. */
  intentSignals: 15,
};

/**
 * Intent by stage, as a fraction of the funnel weight.
 *
 * Ordered by what the stage SAYS about the lead, not by its position in the
 * sequence: handing over a phone number or stating criteria is a bigger signal
 * than being asked a question. `closed` scores zero on purpose. This score
 * answers "who should Carlos call next", and a finished conversation is not a
 * call to make.
 */
const STAGE_INTENT: Record<string, number> = {
  new: 0,
  closed: 0,
  opening_asked_first_time: 0.15,
  opening_offered_details: 0.35,
  identity_requested: 0.45,
  phone_requested: 0.5,
  email_sent: 0.6,
  phone_captured: 0.8,
  follow_up_due: 0.85,
  criteria_collected: 0.9,
  property_sent: 1.0,
  flag_for_call: 1.0,
};

function scoreFunnelDepth(lead: Lead): number {
  const f = STAGE_INTENT[String(lead.state).toLowerCase()];
  return Math.round(WEIGHTS.funnelDepth * (f ?? 0));
}

/**
 * Engagement, on whichever channel the lead actually used.
 *
 * Reads BOTH stores and takes the higher rather than the sum: a lead who moved
 * from DM to text is one conversation, and adding them would reward switching
 * channels over actual interest. Reading SMS alone was the original bug, since
 * Twilio is unconfigured and the funnel runs on DMs.
 */
function scoreEngagement(leadId: string): number {
  let sms = 0;
  try {
    sms = getInboundMessageCount(leadId);
  } catch {
    /* No SMS store configured must not zero out a real DM history. */
  }
  const replies = Math.max(sms, getInboundDmCount(leadId));
  if (replies === 0) return 0;
  if (replies === 1) return Math.round(WEIGHTS.engagement * 0.35);
  if (replies <= 3) return Math.round(WEIGHTS.engagement * 0.6);
  if (replies <= 7) return Math.round(WEIGHTS.engagement * 0.85);
  return WEIGHTS.engagement;
}

/**
 * How recently the lead last spoke, which the old model ignored entirely.
 *
 * Without this a March lead who replied twice outranked a lead who replied
 * twice this morning, and 741 leads sat stalled since spring looking exactly as
 * warm as they did the day they went quiet. Decay is what stops a call list
 * from being a fossil.
 *
 * Falls back to `lastActivity` when there is no inbound message, so a logged
 * call or text still counts as contact.
 */
function scoreRecency(lead: Lead): number {
  const iso = getLastInboundDmAt(lead.id) || lead.lastActivity || null;
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  const days = (Date.now() - t) / 86_400_000;
  if (days <= 2) return WEIGHTS.recency;
  if (days <= 7) return Math.round(WEIGHTS.recency * 0.8);
  if (days <= 14) return Math.round(WEIGHTS.recency * 0.6);
  if (days <= 30) return Math.round(WEIGHTS.recency * 0.35);
  if (days <= 60) return Math.round(WEIGHTS.recency * 0.15);
  return 0;
}

/** A lead nobody can phone is not a call list entry, however interested. */
function scoreContactable(lead: Lead): number {
  return lead.phone?.trim() ? WEIGHTS.contactable : 0;
}

/**
 * The old model's four factors, collapsed into one bonus.
 *
 * Each is real when present and none is reliably present, so together they top
 * a score up rather than deciding it.
 */
function scoreIntentSignals(lead: Lead): number {
  let pts = 0;
  const timeline = (lead.criteria?.timeline ?? "").toLowerCase().trim();
  if (timeline) {
    if (/asap|immediately|now|this month|urgent/.test(timeline)) pts += 5;
    else if (/1-3 months|soon|next few months|1 to 3/.test(timeline)) pts += 4;
    else if (/3-6 months|3 to 6/.test(timeline)) pts += 2;
    else if (/6\+|6 plus|just looking|exploring|no rush/.test(timeline)) pts += 1;
    else pts += 2;
  }
  const pre = lead.preApprovalStatus;
  if (pre === "approved" || pre === "cash") pts += 5;
  else if (pre === "in_progress") pts += 3;

  const views =
    typeof lead.propertyViewsCount === "number" && lead.propertyViewsCount > 0
      ? lead.propertyViewsCount
      : (lead.activity ?? []).filter((a) =>
          ["home_clicked", "home_hearted", "web_visit"].includes(a.type),
        ).length;
  if (views > 2) pts += 3;
  else if (views > 0) pts += 2;

  const showing = lead.showingAppointment;
  if (showing) pts += showing.confirmationStatus === "confirmed" ? 2 : 1;

  return Math.min(WEIGHTS.intentSignals, pts);
}

export function calculateLeadScore(lead: Lead): { score: number; factors: ScoringFactors } {
  const factors: ScoringFactors = {
    engagement: scoreEngagement(lead.id),
    funnelDepth: scoreFunnelDepth(lead),
    recency: scoreRecency(lead),
    contactable: scoreContactable(lead),
    intentSignals: scoreIntentSignals(lead),
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

  /* Only write when something actually moved. Scoring now runs every few hours
     rather than monthly, and an unconditional insert would add 1,306 rows per
     pass — roughly half a million a year of "nothing happened". Skipping no-ops
     keeps a row meaning "this lead changed", which is what makes the score
     history readable, and leaves MAX(score_date) pointing at the last real
     change. */
  const unchanged = previous && previous.score === score && previous.tier === tier;
  if (!unchanged) {
    recordLeadScore({
      leadId: lead.id,
      score,
      previousScore: previous?.score,
      scoreDate: new Date().toISOString(),
      scoringFactors: factors,
      tier,
    });
  }

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

/** Leave a little slack so a run that starts slightly early still counts. */
const RESCORE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RESCORE_DUE_MS = RESCORE_INTERVAL_MS - 5 * 60 * 1000;

/**
 * Re-score every lead if enough time has passed.
 *
 * Was: cold leads only, at most once every THIRTY DAYS. That cannot work now
 * that the model includes recency — a score decays every day, so a monthly
 * refresh means the tiers are wrong for twenty-nine days out of thirty, and
 * scoring only the cold ones meant a hot lead could never cool off.
 *
 * Every lead, every few hours. The pass is a pure recompute over leads already
 * in memory and writes nothing when a score is unchanged, so running it often
 * is cheap.
 */
export async function checkAndRunAutoRescoreIfDue(force = false): Promise<{
  ran: boolean;
  result?: { scored: number; hot: number; warm: number; cold: number };
}> {
  const lastRunAt = getLastRescoreRunAt();
  if (!force && lastRunAt && Date.now() - new Date(lastRunAt).getTime() < RESCORE_DUE_MS) {
    return { ran: false };
  }

  const result = await scoreAllLeads();
  recordRescoreRun(new Date().toISOString());
  return { ran: true, result };
}

/**
 * Keep scores fresh.
 *
 * The old scheduler only fired if the process happened to be alive during a
 * TWO-MINUTE wall-clock window at 09:00 Central, tracked by an in-memory flag.
 * This app deploys several times a day, and a restart inside that window meant
 * the day was simply skipped — with a thirty-day gate behind it, a couple of
 * unlucky restarts could push a "monthly" rescore out indefinitely. The scores
 * were last written on 25 June and were still being reported as current in
 * August.
 *
 * Now: run shortly after boot, then on a fixed interval. No wall-clock window
 * to miss, no dependence on surviving a particular minute, and a deploy makes
 * scores fresher rather than skipping them. `checkAndRunAutoRescoreIfDue` still
 * gates on the persisted last-run time, so frequent restarts do not mean
 * constant rescoring.
 */
export function scheduleAutoRescore(): void {
  const run = () =>
    checkAndRunAutoRescoreIfDue()
      .then((r) => {
        if (r.ran && r.result) {
          console.log(
            `[AutoRescore] ${r.result.scored} leads — ${r.result.hot} hot, ${r.result.warm} warm, ${r.result.cold} cold`,
          );
        }
      })
      .catch((err) => console.error("[AutoRescore]", err));

  /* Not immediate: let the lead store finish loading from disk first, or the
     first pass scores an empty book and records a run that suppresses the
     next one. */
  setTimeout(run, 2 * 60 * 1000);
  setInterval(run, RESCORE_INTERVAL_MS);
  console.log(
    `[AutoRescore] Scheduled — first pass in 2 min, then every ${RESCORE_INTERVAL_MS / 3600000}h`,
  );
}
