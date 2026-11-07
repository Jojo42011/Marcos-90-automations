/**
 * CRM Overview funnels: buyers Views → Close, sellers Call → Close.
 *
 * Built from real stores only:
 *   - Tracker stages (people in each pipeline bucket)
 *   - Lead activity (outbound calls for the seller top-of-funnel)
 *   - Social analytics views (buyer top-of-funnel; account-local under isolation)
 *
 * Stage buckets are deliberate collapses of BUYER_STAGES / SELLER_STAGES so the
 * Overview stays readable. Unstaged tracker people count as "in pipeline" but
 * not as Contacted+. Agent filter matches assignedTo / assignedUserName loosely
 * (Marco / Wesley / Carlos) so spelling variants do not drop rows.
 */
import { listAllLeads } from "./db.js";
import { getSocialAnalytics } from "./socialAnalytics.js";
import { listTrackerRecords } from "./trackerStore.js";
import type { BuyerStage, Lead, SellerStage, TrackerRecord } from "./types.js";
import { BUYER_STAGES, SELLER_STAGES } from "./types.js";

export type FunnelStepKind = "metric" | "people";

export interface FunnelStep {
  key: string;
  label: string;
  kind: FunnelStepKind;
  count: number;
  /** Conversion into this step from the previous people step (null for first / metrics). */
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

const BUYER_ORDER = BUYER_STAGES.map((s) => s.key);
const SELLER_ORDER = SELLER_STAGES.map((s) => s.key);

/** Collapsed buyer pipeline after Views. */
const BUYER_BUCKETS: Array<{ key: string; label: string; stages: BuyerStage[] }> = [
  { key: "contacted", label: "Contacted", stages: ["contacted", "qualified", "pre_approved"] },
  {
    key: "showing",
    label: "Showing",
    stages: ["buyer_rep_signed", "actively_showing"],
  },
  {
    key: "contract",
    label: "Under Contract",
    stages: ["offer_submitted", "under_contract", "option_period", "clear_to_close"],
  },
  { key: "closed", label: "Closed", stages: ["closed", "past_client"] },
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

export function parseAgentFilter(raw: string | null | undefined): string[] {
  if (!raw || !String(raw).trim() || /^all$/i.test(String(raw).trim())) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function matchesAgentFilter(assignee: string | null | undefined, filter: string[]): boolean {
  if (!filter.length) return true;
  const key = agentKey(assignee);
  if (!key) return false; // unassigned — do not invent ownership
  return filter.some((f) => {
    const want = agentKey(f);
    if (want && want !== "other") return key === want;
    return normAgent(assignee) === normAgent(f) || normAgent(assignee).includes(normAgent(f));
  });
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

async function socialViews(): Promise<{ views: number | null; note: string | null }> {
  try {
    const payload = await getSocialAnalytics();
    const v = payload.combined?.views;
    if (typeof v === "number" && Number.isFinite(v)) {
      return {
        views: v,
        note: "Buyer Views are this account's connected social views (Analytics), not per-lead attribution.",
      };
    }
    return { views: null, note: "Social views are not available yet — buyer funnel starts at Buyers." };
  } catch {
    return { views: null, note: "Social views could not be loaded — buyer funnel starts at Buyers." };
  }
}

function withRates(
  steps: Array<{ key: string; label: string; kind: FunnelStepKind; count: number }>,
): FunnelStep[] {
  let prevPeople: number | null = null;
  return steps.map((s) => {
    let rateFromPrev: number | null = null;
    if (s.kind === "people") {
      if (prevPeople != null) rateFromPrev = rate(s.count, prevPeople);
      prevPeople = s.count;
    }
    return { ...s, rateFromPrev };
  });
}

/** Cumulative stage keys for a collapsed Overview bucket (that stage and later). */
export function deepLinkStages(
  side: "buyer" | "seller",
  bucketKey: string,
): string[] {
  const order = side === "buyer" ? BUYER_ORDER : SELLER_ORDER;
  const buckets = side === "buyer" ? BUYER_BUCKETS : SELLER_BUCKETS;
  const bucket = buckets.find((b) => b.key === bucketKey);
  if (!bucket) return [];
  const minIdx = Math.min(
    ...bucket.stages.map((s) => stageIndex(order, s)).filter((i) => i >= 0),
  );
  if (!Number.isFinite(minIdx) || minIdx < 0) return [];
  return order.slice(minIdx);
}

function buildDeepLinks(): PipelineOverview["deepLinks"] {
  const buyer: Record<string, string[]> = { buyers: [] };
  for (const b of BUYER_BUCKETS) buyer[b.key] = deepLinkStages("buyer", b.key);
  const seller: Record<string, string[]> = { sellers: [] };
  for (const b of SELLER_BUCKETS) seller[b.key] = deepLinkStages("seller", b.key);
  return { buyer, seller };
}

export async function buildPipelineOverview(opts: {
  agent?: string | null;
}): Promise<PipelineOverview> {
  const filter = parseAgentFilter(opts.agent);
  const allTracker = listTrackerRecords({});
  const tracker = allTracker.filter((r) => matchesAgentFilter(r.assignedTo, filter));
  const leads = await listAllLeads();
  const { views, note: viewsNote } = await socialViews();
  const calls = countCalls(leads, filter);

  const buyer = countInBuckets(tracker, "buyer", BUYER_BUCKETS, BUYER_ORDER);
  const seller = countInBuckets(tracker, "seller", SELLER_BUCKETS, SELLER_ORDER);

  const buyerStepsRaw: Array<{ key: string; label: string; kind: FunnelStepKind; count: number }> = [];
  if (views != null) {
    buyerStepsRaw.push({ key: "views", label: "Views", kind: "metric", count: views });
  }
  buyerStepsRaw.push({ key: "buyers", label: "Buyers", kind: "people", count: buyer.total });
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
  if (viewsNote) notes.push(viewsNote);
  notes.push(
    "Pipeline steps are cumulative from the Buyers & Sellers Tracker (reached this stage or further). Unstaged contacts count in Buyers/Sellers only.",
  );
  if (filter.length) {
    notes.push(
      `Filtered to ${filter.join(", ")}. Unassigned tracker rows are excluded so ownership stays honest.`,
    );
  }

  const agentLabel = filter.length === 1 ? filter[0] : filter.length ? filter.join(", ") : null;

  return {
    ok: true,
    agent: agentLabel,
    agents: filter,
    buyers: {
      side: "buyer",
      title: "Buyers",
      subtitle: "Views → Close",
      steps: withRates(buyerStepsRaw),
      inPipeline: buyer.total,
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
