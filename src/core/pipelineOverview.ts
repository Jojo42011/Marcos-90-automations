import { hasDmPhoneCapture } from "./dmMetrics.js";
/**
 * CRM Overview funnels: buyers Views → Close, sellers Call → Close.
 *
 * Built from real stores only:
 *   - Social analytics (buyer Views + Comments)
 *   - Lead conversations / phones (buyer DMs + number)
 *   - CRM lead stages + Tracker buyer stages (appt set → closed)
 *   - Shared Dialer calls (seller talk time, numbers called, conversations)
 *   - Tracker seller stages (appointment set → sold), windowed by stage entry
 *
 * Buyer people steps follow Marco's Overview funnel (Call is intentionally
 * omitted). Stage buckets are cumulative (reached this step or further).
 * Agent filter matches assignedTo / assignedUserName loosely
 * (Marco / Wesley — Carlos is not an agent) so spelling variants do not drop rows.
 * Views/Comments are account-level social totals and only appear when the filter
 * is All or includes Marco; Wesley-only must not keep showing Marco's social.
 */
import { getConversation, getInboundDmCount, listAllLeads } from "./db.js";
import { dialerStore } from "../dialer/store.js";
import { getDialerTeam } from "./users.js";
import { getSocialAnalytics } from "./socialAnalytics.js";
import { listTrackerRecords } from "./trackerStore.js";
import type { Lead, SellerStage, TrackerRecord, TrackerSide } from "./types.js";
import { CRM_STAGE_LEGACY, SELLER_STAGES } from "./types.js";

export type FunnelStepKind = "metric" | "people";

export interface FunnelStep {
  key: string;
  label: string;
  kind: FunnelStepKind;
  count: number;
  /** "duration" counts are seconds (talk time); rates never cross one. */
  format?: "duration";
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
  /** Seller card only: the window the Dialer and stage-entry counts cover. */
  window?: SellerWindow;
  dial?: SellerDialMetrics;
}

export type SellerWindowKey = "7d" | "30d" | "month" | "90d" | "all";

export interface SellerWindow {
  key: SellerWindowKey;
  label: string;
  /** ISO start, or null for all time. */
  since: string | null;
}

export interface SellerDialMetrics {
  talkSeconds: number;
  numbersCalled: number;
  conversations: number;
  appointmentsFromCalls: number;
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
    trackerStages: ["appointment_set", "appointment_show", "actively_showing", "under_contract", "closed"],
  },
  {
    key: "appt_show",
    label: "Appt show",
    minRank: 1,
    trackerStages: ["appointment_show", "actively_showing", "under_contract", "closed"],
  },
  {
    key: "showing",
    label: "Showing",
    minRank: 2,
    trackerStages: ["actively_showing", "under_contract", "closed"],
  },
  {
    key: "contract",
    label: "U/C",
    minRank: 4,
    trackerStages: ["under_contract", "closed"],
  },
  {
    key: "closed",
    label: "Closed",
    minRank: 5,
    trackerStages: ["closed"],
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

/**
 * Seller chain after the Dialer numbers (Marco's Mojo-style read):
 * conversations → appts set → appts shown → listed/signed → U/C → sold.
 * Each bucket is "reached this stage or later".
 */
const SELLER_BUCKETS: Array<{ key: string; label: string; stages: SellerStage[] }> = [
  { key: "appt_set", label: "Appts set", stages: ["listing_appointment_set"] },
  { key: "appt_show", label: "Appts shown", stages: ["appointment_held"] },
  { key: "listed", label: "Listed / signed", stages: ["listing_agreement_signed"] },
  { key: "contract", label: "Under contract", stages: ["under_contract"] },
  { key: "closed", label: "Sold", stages: ["closed"] },
];

/** Tracker buyerStage → same rank ladder as CRM stages (pre-appointment stages are not on it). */
const TRACKER_BUYER_RANK: Record<string, number> = {
  appointment_set: 0,
  appointment_show: 1,
  actively_showing: 2,
  under_contract: 4,
  closed: 5,
};

const SELLER_WINDOWS: Record<SellerWindowKey, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "This month",
  "90d": "Last 90 days",
  all: "All time",
};
const TEAM_ZONE = "America/Chicago";

/** Midnight on the 1st of the current month in the team's zone, as an instant. */
function startOfMonthInZone(now: Date, zone = TEAM_ZONE): Date {
  const ym = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit" }).formatToParts(now);
  const y = Number(ym.find((p) => p.type === "year")?.value);
  const m = Number(ym.find((p) => p.type === "month")?.value);
  const desired = Date.UTC(y, m - 1, 1);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  let instant = desired;
  for (let i = 0; i < 3; i++) {
    const p = fmt.formatToParts(new Date(instant));
    const v = (k: string) => Number(p.find((x) => x.type === k)?.value);
    instant += desired - Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"));
  }
  return new Date(instant);
}

export function resolveSellerWindow(raw: string | null | undefined, now = new Date()): SellerWindow {
  const key = (Object.keys(SELLER_WINDOWS) as SellerWindowKey[]).includes(raw as SellerWindowKey)
    ? (raw as SellerWindowKey)
    : "30d";
  const days = key === "7d" ? 7 : key === "30d" ? 30 : key === "90d" ? 90 : 0;
  const since =
    key === "all" ? null : key === "month" ? startOfMonthInZone(now) : new Date(now.getTime() - days * 86400000);
  return { key, label: SELLER_WINDOWS[key], since: since ? since.toISOString() : null };
}

const TALKED = new Set(["talked", "appointment_set"]);

/**
 * Seller dial numbers from the shared Dialer, attributed by the caller's team
 * identity. Interrupted attempts were never placed, so they count nowhere.
 * Talk time is the logged span from opening the phone app to saving the
 * outcome; calls run in the device's phone app, so no carrier duration exists.
 */
export function sellerDialMetrics(filter: string[], window: SellerWindow): SellerDialMetrics {
  const out: SellerDialMetrics = { talkSeconds: 0, numbersCalled: 0, conversations: 0, appointmentsFromCalls: 0 };
  if (filter.includes(AGENT_FILTER_NONE)) return out;
  let calls: Array<{ actorId?: string; outcome?: string | null; endedAt?: string; elapsedSeconds?: number }>;
  try {
    calls = dialerStore().all("call");
  } catch {
    return out;
  }
  const names = new Map(getDialerTeam().map((u) => [u.id, u.name]));
  const since = window.since ? Date.parse(window.since) : null;
  for (const c of calls) {
    if (!c.endedAt || !c.outcome || c.outcome === "interrupted") continue;
    if (since != null && Date.parse(c.endedAt) < since) continue;
    if (filter.length && !matchesAgentFilter(names.get(String(c.actorId)) || "", filter)) continue;
    out.numbersCalled += 1;
    out.talkSeconds += Math.max(0, Number(c.elapsedSeconds) || 0);
    if (TALKED.has(c.outcome)) out.conversations += 1;
    if (c.outcome === "appointment_set") out.appointmentsFromCalls += 1;
  }
  return out;
}

/** When a record first reached `minIdx` or later on this side, from stage-entry stamps. */
function reachedAt(rec: TrackerRecord, side: TrackerSide, order: string[], minIdx: number): number | null {
  let best: number | null = null;
  for (const [k, meta] of Object.entries(rec.stageMeta || {})) {
    const [s, stage] = k.split(":");
    if (s !== side || stageIndex(order, stage) < minIdx || !meta?.enteredAt) continue;
    const t = Date.parse(meta.enteredAt);
    if (Number.isFinite(t) && (best == null || t < best)) best = t;
  }
  return best;
}

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
  since: string | null = null,
): { steps: Array<{ key: string; label: string; count: number }>; unstaged: number; total: number; closed: number } {
  const sideRecs = records.filter((r) => r.sides.includes(side));
  let unstaged = 0;
  const idxs: Array<{ idx: number; rec: TrackerRecord }> = [];
  const sinceMs = since ? Date.parse(since) : null;

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
    idxs.push({ idx, rec: r });
  }

  // A windowed count needs a stage-entry stamp; rows staged without one (bulk
  // imports) only count in All time rather than being dated by guesswork.
  const steps = buckets.map((b) => {
    const minIdx = Math.min(...b.stages.map((s) => stageIndex(order, s)).filter((i) => i >= 0));
    const count = idxs.filter(({ idx, rec }) => {
      if (idx < minIdx) return false;
      if (sinceMs == null) return true;
      const at = reachedAt(rec, side, order, minIdx);
      return at != null && at >= sinceMs;
    }).length;
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
  steps: Array<{ key: string; label: string; kind: FunnelStepKind; count: number; format?: "duration" }>,
): FunnelStep[] {
  return steps.map((s, i) => {
    let rateFromPrev: number | null = null;
    const prev = steps[i - 1];
    if (prev && !s.format && !prev.format) rateFromPrev = rate(s.count, prev.count);
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
  const seller: Record<string, string[]> = {};
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
  sellerWindow?: string | null;
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
  const sellerWindow = resolveSellerWindow(opts.sellerWindow);
  const dial = sellerDialMetrics(filter, sellerWindow);

  const buyer = countBuyerPeopleSteps(leads, tracker, filter);
  // Match DM Agent analytics, excluding imported CRM-only phone numbers.
  const captureFlags = await Promise.all(leads.filter(l => matchesAgentFilter(leadAssignee(l), filter))
    .map(async l => hasDmPhoneCapture(l, await getConversation(l.id))));
  buyer.numbers = captureFlags.filter(Boolean).length;
  const seller = countInBuckets(tracker, "seller", SELLER_BUCKETS, SELLER_ORDER, sellerWindow.since);

  const buyerStepsRaw: Array<{ key: string; label: string; kind: FunnelStepKind; count: number }> = [];
  if (includeSocial && social.views != null) {
    buyerStepsRaw.push({ key: "views", label: "Views", kind: "metric", count: social.views });
  }
  if (includeSocial && social.comments != null) {
    buyerStepsRaw.push({ key: "comments", label: "Comments", kind: "metric", count: social.comments });
  }
  buyerStepsRaw.push({ key: "dms", label: "DMs", kind: "metric", count: buyer.dms });
  buyerStepsRaw.push({ key: "number", label: "Numbers collected", kind: "metric", count: buyer.numbers });
  for (const s of buyer.steps) {
    buyerStepsRaw.push({ key: s.key, label: s.label, kind: "people", count: s.count });
  }

  const sellerStepsRaw: Array<{ key: string; label: string; kind: FunnelStepKind; count: number; format?: "duration" }> = [
    { key: "talk_time", label: "Talk time", kind: "metric", count: dial.talkSeconds, format: "duration" },
    { key: "called", label: "Numbers called", kind: "metric", count: dial.numbersCalled },
    { key: "conversations", label: "Conversations", kind: "metric", count: dial.conversations },
  ];
  for (const s of seller.steps) {
    sellerStepsRaw.push({ key: s.key, label: s.label, kind: "people", count: s.count });
  }

  const notes: string[] = [];
  if (social.note) notes.push(social.note);
  notes.push(
    "Numbers collected matches DM Agent analytics: conversations with a non-empty captured phone, filtered by assigned agent when selected.",
    "Buyer funnel: Views → Comments → DMs → Number → Appt set → Appt show → Showing → U/C → Closed (no Call). People steps are cumulative from CRM stages + Tracker.",
  );
  notes.push(
    `Seller Dialer numbers (${sellerWindow.label.toLowerCase()}) come from saved Dialer outcomes by the caller's team identity: numbers called excludes interrupted attempts, conversations are Talked + Appointment set, and talk time is the logged span from opening the phone app to saving the outcome.`,
    sellerWindow.since
      ? "Seller stage steps count people who reached that stage or later during the window, using Tracker stage-entry dates. Rows staged without a date only count in All time."
      : "Seller stage steps are cumulative from the Buyers & Sellers Tracker (reached this stage or later).",
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
      subtitle: "Talk time → Sold",
      steps: withRates(sellerStepsRaw),
      inPipeline: seller.total,
      unstaged: seller.unstaged,
      closed: seller.closed,
      window: sellerWindow,
      dial,
    },
    deepLinks: buildDeepLinks(),
    notes,
    generatedAt: new Date().toISOString(),
  };
}
