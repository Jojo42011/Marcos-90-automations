/**
 * CRM Overview funnels: buyers Views → Close, sellers Call → Close.
 *
 * Built from real stores only:
 *   - Social analytics (buyer Views + Comments)
 *   - Lead conversations / phones (buyer DMs + number)
 *   - CRM lead stages + Tracker buyer stages (appt set → closed)
 *   - Lead activity (seller Calls)
 *   - Tracker seller stages (Contacted → closed)
 *
 * Buyer people steps follow Marco's Overview funnel (Call is intentionally
 * omitted). Stage buckets are cumulative (reached this step or further).
 * Agent filter matches assignedTo / assignedUserName loosely
 * (Marco / Wesley — Carlos is not an agent) so spelling variants do not drop rows.
 * Views/Comments are account-level social totals and only appear when the filter
 * is All or includes Marco; Wesley-only must not keep showing Marco's social.
 */
import { getInboundDmCount, listAllLeads } from "./db.js";
import { getSocialAnalytics } from "./socialAnalytics.js";
import { listTrackerRecords } from "./trackerStore.js";
import type { Lead, SellerStage, TrackerRecord } from "./types.js";
import { CRM_STAGE_LEGACY, SELLER_STAGES } from "./types.js";

export type FunnelStepKind = "metric" | "people";

export interface FunnelStep {
  key: string;
  label: string;
  kind: FunnelStepKind;
  count: number;
  /** Conversion into this step from the previous step (null for the first). */
  rateFromPrev: number | null;
}

export interface SideFunnel {
  side: "buyer" | "seller";
  title: string;
  subtitle: string;
  steps: FunnelStep[];
  inPipeline: number;
  unstaged: number;
  closed: number;
}

export interface PipelineOverview {
  ok: true;
  agent: string | null;
  agents: string[];
  buyers: SideFunnel;
  sellers: SideFunnel;
  /** Stage keys (cumulative) for Overview → Tracker click-through. */
  deepLinks: {
    buyer: Record<string, string[]>;
    seller: Record<string, string[]>;
  };
  notes: string[];
  generatedAt: string;
}

const SELLER_ORDER = SELLER_STAGES.map((s) => s.key);

/**
 * Buyer Overview people steps after number.
 * CRM lead stages are the primary rank; Tracker buyer stages fill gaps when a
 * deal is on the board but the CRM stage has not moved yet.
 */
const BUYER_PEOPLE_STEPS: Array<{
  key: string;
  label: string;
  /** Minimum rank (0-based) in BUYER_FUNNEL_ORDER to count. */
  minRank: number;
  /** Tracker stages used for Overview → Tracker click-through. */
  trackerStages: string[];
}> = [
  {
    key: "appt_set",
    label: "Appt set",
    minRank: 0,
    trackerStages: ["buyer_rep_signed", "actively_showing", "offer_submitted", "under_contract", "option_period", "clear_to_close", "closed", "past_client"],
  },
  {
    key: "appt_show",
    label: "Appt show",
    minRank: 1,
    trackerStages: ["actively_showing", "offer_submitted", "under_contract", "option_period", "clear_to_close", "closed", "past_client"],
  },
  {
    key: "showing",
    label: "Showing",
    minRank: 2,
    trackerStages: ["actively_showing", "offer_submitted", "under_contract", "option_period", "clear_to_close", "closed", "past_client"],
  },
  {
    key: "contract",
    label: "U/C",
    minRank: 4,
    trackerStages: ["under_contract", "option_period", "clear_to_close", "closed", "past_client"],
  },
  {
    key: "closed",
    label: "Closed",
    minRank: 5,
    trackerStages: ["closed", "past_client"],
  },
];

/** Ordered CRM (+ legacy) stages that advance the buyer Overview funnel. */
const BUYER_FUNNEL_ORDER: string[] = [
  "appointment_set",
  "met_with_customer",
  "showing_homes",
  "submitting_offers",
  "under_contract",
  "sale_closed",
];

/** Collapsed seller pipeline after Calls. */
const SELLER_BUCKETS: Array<{ key: string; label: string; stages: SellerStage[] }> = [
  { key: "contacted", label: "Contacted", stages: ["contacted", "cma_requested"] },
  {
    key: "appointment",
    label: "Appointment",
    stages: ["listing_appointment_set", "appointment_held", "listing_agreement_signed", "prep_pre_market"],
  },
  {
    key: "listed",
    label: "Listed",
    stages: ["active_on_mls", "price_adjustment", "offer_received"],
  },
  {
    key: "contract",
    label: "Under Contract",
    stages: ["under_contract", "option_period", "clear_to_close"],
  },
  { key: "closed", label: "Closed", stages: ["closed", "past_client"] },
];

/** Tracker buyerStage → same rank ladder as CRM stages. */
const TRACKER_BUYER_RANK: Record<string, number> = {
  buyer_rep_signed: 0, // appt set
  actively_showing: 2, // showing (appt show is CRM met_with; dialer Appt Set lands here)
  offer_submitted: 3,
  under_contract: 4,
  option_period: 4,
  clear_to_close: 4,
  closed: 5,
  past_client: 5,
};

function normAgent(s: string | null | undefined): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Map free-text assignee to a team key. */
export function agentKey(name: string | null | undefined): "marco" | "wesley" | "carlos" | "other" | "" {
  const n = normAgent(name);
  if (!n) return "";
  if (n.includes("marco")) return "marco";
  if (n.includes("wesley") || n === "wes") return "wesley";
  if (n.includes("carlos")) return "carlos";
  return "other";
}

/** Sentinel: client asked for an empty pick (no agents checked) — match nobody. */
export const AGENT_FILTER_NONE = "__none__";

export function parseAgentFilter(raw: string | null | undefined): string[] {
  if (!raw || !String(raw).trim() || /^all$/i.test(String(raw).trim())) return [];
  const parts = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 1 && parts[0] === AGENT_FILTER_NONE) return [AGENT_FILTER_NONE];
  // Carlos is not an agent on this Overview — ignore if a stale client sends him.
  return parts.filter((p) => p !== AGENT_FILTER_NONE && agentKey(p) !== "carlos");
}

export function matchesAgentFilter(assignee: string | null | undefined, filter: string[]): boolean {
  if (!filter.length) return true;
  if (filter.includes(AGENT_FILTER_NONE)) return false;
  const key = agentKey(assignee);
  if (!key) return false; // unassigned — do not invent ownership
  return filter.some((f) => {
    const want = agentKey(f);
    if (want === "carlos") return false;
    if (want && want !== "other") return key === want;
    return normAgent(assignee) === normAgent(f) || normAgent(assignee).includes(normAgent(f));
  });
}

/** Account social Views/Comments only when All or Marco is in the pick. */
export function socialAllowedForAgentFilter(filter: string[]): boolean {
  if (!filter.length) return true;
  if (filter.includes(AGENT_FILTER_NONE)) return false;
  return filter.some((f) => agentKey(f) === "marco");
}

function leadAssignee(l: Lead): string | undefined {
  return (l.assignedUserName || (l as { assignedTo?: string }).assignedTo || undefined) as
    | string
    | undefined;
}

function stageIndex(order: string[], stage: string | undefined): number {
  if (!stage) return -1;
  return order.indexOf(stage);
}

function normalizeLeadStage(raw: string | null | undefined): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  if ((CRM_STAGE_LEGACY as Record<string, string>)[s]) return (CRM_STAGE_LEGACY as Record<string, string>)[s];
  return s;
}

/** Buyer-funnel rank from a CRM stage, or -1 if it is not on the ladder. */
export function buyerCrmRank(stage: string | null | undefined): number {
  const n = normalizeLeadStage(stage);
  if (!n) return -1;
  // Candidate appoint stages share the same Overview meaning.
  if (n === "appointment_set_candidate") return 0;
  if (n === "met_with_candidate") return 1;
  return stageIndex(BUYER_FUNNEL_ORDER, n);
}

export function buyerTrackerRank(stage: string | null | undefined): number {
  if (!stage) return -1;
  const r = TRACKER_BUYER_RANK[stage];
  return typeof r === "number" ? r : -1;
}

/**
 * Is this lead in the buyer social/deal funnel?
 * Pure sellers stay on the seller card; everyone else can appear on buyer steps.
 */
function isBuyerFunnelLead(l: Lead): boolean {
  const intent = String(l.crmIntent || "")
    .trim()
    .toLowerCase();
  if (intent === "seller") return false;
  return true;
}

function leadHasPhone(l: Lead): boolean {
  const d = String(l.phone || "").replace(/\D/g, "");
  return d.length >= 10;
}

/**
 * Cumulative funnel: each bucket counts people who have reached that stage or
 * further. Rates between steps then mean real conversion, not inventory mix.
 */
function countInBuckets(
  records: TrackerRecord[],
  side: "buyer" | "seller",
  buckets: Array<{ key: string; label: string; stages: string[] }>,
  order: string[],
): { steps: Array<{ key: string; label: string; count: number }>; unstaged: number; total: number; closed: number } {
  const sideRecs = records.filter((r) => r.sides.includes(side));
  let unstaged = 0;
  const idxs: number[] = [];

  for (const r of sideRecs) {
    const stage = side === "buyer" ? r.buyerStage : r.sellerStage;
    if (!stage) {
      unstaged++;
      continue;
    }
    const idx = stageIndex(order, stage);
    if (idx < 0) {
      unstaged++;
      continue;
    }
    idxs.push(idx);
  }

  const steps = buckets.map((b) => {
    const minIdx = Math.min(...b.stages.map((s) => stageIndex(order, s)).filter((i) => i >= 0));
    const count = idxs.filter((i) => i >= minIdx).length;
    return { key: b.key, label: b.label, count };
  });

  const closedKey = buckets[buckets.length - 1]?.key;
  const closed = steps.find((s) => s.key === closedKey)?.count || 0;

  return {
    total: sideRecs.length,
    unstaged,
    closed,
    steps,
  };
}

function rate(curr: number, prev: number): number | null {
  if (prev <= 0) return null;
  return Math.round((curr / prev) * 1000) / 10;
}

function countCalls(leads: Lead[], filter: string[]): number {
  let n = 0;
  for (const l of leads) {
    if (!matchesAgentFilter(leadAssignee(l), filter)) continue;
    for (const a of l.activity || []) {
      const t = String(a.type || "").toLowerCase();
      if (t.includes("call") || t === "dialer") n += 1;
    }
  }
  return n;
}

async function socialTop(): Promise<{
  views: number | null;
  comments: number | null;
  note: string | null;
}> {
  try {
    const payload = await getSocialAnalytics();
    const views = payload.combined?.views;
    const comments = payload.combined?.comments;
    const vOk = typeof views === "number" && Number.isFinite(views);
    const cOk = typeof comments === "number" && Number.isFinite(comments);
    if (vOk || cOk) {
      return {
        views: vOk ? views : null,
        comments: cOk ? comments : null,
        note: "Buyer Views and Comments are this account's connected social totals (Analytics), not per-lead attribution.",
      };
    }
    return {
      views: null,
      comments: null,
      note: "Social Views/Comments are not available yet — buyer funnel starts at DMs when those exist.",
    };
  } catch {
    return {
      views: null,
      comments: null,
      note: "Social Views/Comments could not be loaded — buyer funnel starts at DMs when those exist.",
    };
  }
}

function withRates(
  steps: Array<{ key: string; label: string; kind: FunnelStepKind; count: number }>,
): FunnelStep[] {
  return steps.map((s, i) => {
    let rateFromPrev: number | null = null;
    if (i > 0) rateFromPrev = rate(s.count, steps[i - 1].count);
    return { ...s, rateFromPrev };
  });
}

/** Cumulative stage keys for a collapsed Overview bucket (that stage and later). */
export function deepLinkStages(
  side: "buyer" | "seller",
  bucketKey: string,
): string[] {
  if (side === "buyer") {
    const step = BUYER_PEOPLE_STEPS.find((b) => b.key === bucketKey);
    return step ? [...step.trackerStages] : [];
  }
  const order = SELLER_ORDER;
  const buckets = SELLER_BUCKETS;
  const bucket = buckets.find((b) => b.key === bucketKey);
  if (!bucket) return [];
  const minIdx = Math.min(
    ...bucket.stages.map((s) => stageIndex(order, s)).filter((i) => i >= 0),
  );
  if (!Number.isFinite(minIdx) || minIdx < 0) return [];
  return order.slice(minIdx);
}

function buildDeepLinks(): PipelineOverview["deepLinks"] {
  const buyer: Record<string, string[]> = {};
  for (const b of BUYER_PEOPLE_STEPS) buyer[b.key] = deepLinkStages("buyer", b.key);
  const seller: Record<string, string[]> = { sellers: [] };
  for (const b of SELLER_BUCKETS) seller[b.key] = deepLinkStages("seller", b.key);
  return { buyer, seller };
}

/**
 * Best buyer-funnel rank for a lead: max of CRM stage and linked Tracker stage.
 */
function buyerLeadRank(l: Lead, trackerByLead: Map<string, TrackerRecord>): number {
  let rank = buyerCrmRank(l.crmStage);
  const tr = trackerByLead.get(l.id);
  if (tr?.sides.includes("buyer")) {
    rank = Math.max(rank, buyerTrackerRank(tr.buyerStage));
  }
  return rank;
}

function countBuyerPeopleSteps(
  leads: Lead[],
  tracker: TrackerRecord[],
  filter: string[],
): {
  steps: Array<{ key: string; label: string; count: number }>;
  dms: number;
  numbers: number;
  inPipeline: number;
  unstaged: number;
  closed: number;
} {
  const trackerByLead = new Map<string, TrackerRecord>();
  for (const r of tracker) {
    if (r.leadId) trackerByLead.set(r.leadId, r);
  }

  const buyerLeads = leads.filter(
    (l) => isBuyerFunnelLead(l) && matchesAgentFilter(leadAssignee(l), filter),
  );

  let dms = 0;
  let numbers = 0;
  const ranks: number[] = [];

  for (const l of buyerLeads) {
    if (getInboundDmCount(l.id) > 0) dms += 1;
    if (leadHasPhone(l)) numbers += 1;
    const rank = buyerLeadRank(l, trackerByLead);
    if (rank >= 0) ranks.push(rank);
  }

  // Tracker buyer rows with no lead (or lead filtered out) still count in people steps.
  let trackerOnlyUnstaged = 0;
  for (const r of tracker) {
    if (!r.sides.includes("buyer")) continue;
    if (!matchesAgentFilter(r.assignedTo, filter)) continue;
    if (r.leadId && buyerLeads.some((l) => l.id === r.leadId)) continue;
    const rank = buyerTrackerRank(r.buyerStage);
    if (rank < 0) {
      trackerOnlyUnstaged += 1;
      continue;
    }
    ranks.push(rank);
  }

  const steps = BUYER_PEOPLE_STEPS.map((b) => ({
    key: b.key,
    label: b.label,
    count: ranks.filter((i) => i >= b.minRank).length,
  }));

  const buyerTracker = tracker.filter(
    (r) => r.sides.includes("buyer") && matchesAgentFilter(r.assignedTo, filter),
  );
  const unstaged =
    buyerTracker.filter((r) => !r.buyerStage).length + trackerOnlyUnstaged;
  const closed = steps.find((s) => s.key === "closed")?.count || 0;

  return {
    steps,
    dms,
    numbers,
    inPipeline: buyerTracker.length,
    unstaged,
    closed,
  };
}

export async function buildPipelineOverview(opts: {
  agent?: string | null;
}): Promise<PipelineOverview> {
  const filter = parseAgentFilter(opts.agent);
  const allTracker = listTrackerRecords({});
  const tracker = allTracker.filter((r) => matchesAgentFilter(r.assignedTo, filter));
  const leads = await listAllLeads();
  const includeSocial = socialAllowedForAgentFilter(filter);
  const social = includeSocial
    ? await socialTop()
    : {
        views: null,
        comments: null,
        note: filter.includes(AGENT_FILTER_NONE)
          ? null
          : "Views/Comments are account social totals — shown only for All or when Marco is selected.",
      };
  const calls = countCalls(leads, filter);

  const buyer = countBuyerPeopleSteps(leads, tracker, filter);
  const seller = countInBuckets(tracker, "seller", SELLER_BUCKETS, SELLER_ORDER);

  const buyerStepsRaw: Array<{ key: string; label: string; kind: FunnelStepKind; count: number }> = [];
  if (includeSocial && social.views != null) {
    buyerStepsRaw.push({ key: "views", label: "Views", kind: "metric", count: social.views });
  }
  if (includeSocial && social.comments != null) {
    buyerStepsRaw.push({ key: "comments", label: "Comments", kind: "metric", count: social.comments });
  }
  buyerStepsRaw.push({ key: "dms", label: "DMs", kind: "metric", count: buyer.dms });
  buyerStepsRaw.push({ key: "number", label: "Number", kind: "metric", count: buyer.numbers });
  for (const s of buyer.steps) {
    buyerStepsRaw.push({ key: s.key, label: s.label, kind: "people", count: s.count });
  }

  const sellerStepsRaw: Array<{ key: string; label: string; kind: FunnelStepKind; count: number }> = [
    { key: "calls", label: "Calls", kind: "metric", count: calls },
    { key: "sellers", label: "Sellers", kind: "people", count: seller.total },
  ];
  for (const s of seller.steps) {
    sellerStepsRaw.push({ key: s.key, label: s.label, kind: "people", count: s.count });
  }

  const notes: string[] = [];
  if (social.note) notes.push(social.note);
  notes.push(
    "Buyer funnel: Views → Comments → DMs → Number → Appt set → Appt show → Showing → U/C → Closed (no Call). People steps are cumulative from CRM stages + Tracker.",
  );
  notes.push(
    "Seller pipeline steps are cumulative from the Buyers & Sellers Tracker. Unstaged contacts count in Sellers only.",
  );
  if (filter.includes(AGENT_FILTER_NONE)) {
    notes.push("No agents selected — funnel counts are zero until you pick Marco and/or Wesley.");
  } else if (filter.length) {
    notes.push(
      `Filtered to ${filter.join(", ")}. Unassigned tracker rows are excluded so ownership stays honest.`,
    );
  }

  const agentLabel = filter.includes(AGENT_FILTER_NONE)
    ? null
    : filter.length === 1
      ? filter[0]
      : filter.length
        ? filter.join(", ")
        : null;

  return {
    ok: true,
    agent: agentLabel,
    agents: filter,
    buyers: {
      side: "buyer",
      title: "Buyers",
      subtitle: "Views → Close",
      steps: withRates(buyerStepsRaw),
      inPipeline: buyer.inPipeline,
      unstaged: buyer.unstaged,
      closed: buyer.closed,
    },
    sellers: {
      side: "seller",
      title: "Sellers",
      subtitle: "Call → Close",
      steps: withRates(sellerStepsRaw),
      inPipeline: seller.total,
      unstaged: seller.unstaged,
      closed: seller.closed,
    },
    deepLinks: buildDeepLinks(),
    notes,
    generatedAt: new Date().toISOString(),
  };
}
