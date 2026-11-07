/**
 * Dialer call outcome → Tracker stage bump.
 *
 * When the Dialer logs a call through /api/crm/lead/:id/activity, move an
 * existing tracker row forward from real contact evidence only:
 *   - Talked / answered → Contacted (never Closed; never invent a row)
 *   - Appointment Set   → seller listing_appointment_set / buyer actively_showing
 *
 * Forward-only: a side already further along is left alone. Missing tracker
 * rows are a no-op — the dialer does not create pipeline people.
 */
import type { BuyerStage, CrmIntent, Lead, SellerStage, TrackerRecord, TrackerSide } from "./types.js";
import { BUYER_STAGES, SELLER_STAGES } from "./types.js";
import { getTrackerRecordByLead, setTrackerStage } from "./trackerStore.js";

const BUYER_ORDER = BUYER_STAGES.map((s) => s.key);
const SELLER_ORDER = SELLER_STAGES.map((s) => s.key);

/** Dialer UI keys (public/crm-brivity.html DIAL_OUTCOMES) plus CRM synonyms. */
const TALKED_OUTCOMES = new Set([
  "talked",
  "answered",
  "spoke with customer",
  "spoke_with_customer",
  "spoke with candidate",
  "spoke_with_candidate",
  "positive contact",
]);

const APPOINTMENT_OUTCOMES = new Set([
  "appointment set",
  "appointment_set",
  "appointment set candidate",
  "appointment_set_candidate",
  "showing set",
  "showing_set",
]);

export type DialerBumpKind = "contacted" | "appointment" | null;

export interface DialerBumpChange {
  side: TrackerSide;
  from: string | null;
  to: string;
}

export interface DialerBumpResult {
  applied: boolean;
  reason: string;
  kind: DialerBumpKind;
  recordId?: string;
  changes: DialerBumpChange[];
}

export interface DialerBumpInput {
  leadId: string;
  /** meta.Outcome / subType / description lead — e.g. "Talked". */
  outcome: string;
  /** meta.Source — Dialer UI sends "Dialer". */
  source?: string | null;
  /** Lead crmIntent / intent — picks side when tracker has both. */
  leadIntent?: CrmIntent | string | null;
  dryRun?: boolean;
}

export function normalizeDialerOutcome(raw: string | null | undefined): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function isDialerActivitySource(source: string | null | undefined): boolean {
  const s = String(source || "").trim().toLowerCase();
  if (!s) return false;
  return s === "dialer" || s.includes("dialer");
}

export function classifyDialerOutcome(outcome: string | null | undefined): DialerBumpKind {
  const n = normalizeDialerOutcome(outcome);
  if (!n) return null;
  if (TALKED_OUTCOMES.has(n)) return "contacted";
  if (APPOINTMENT_OUTCOMES.has(n)) return "appointment";
  return null;
}

function stageIndex(side: TrackerSide, stage: string | null | undefined): number {
  if (!stage) return -1;
  const order = side === "buyer" ? BUYER_ORDER : SELLER_ORDER;
  return order.indexOf(stage as never);
}

/** True when `target` is strictly ahead of `current` (empty current always qualifies). */
export function canAdvanceStage(
  side: TrackerSide,
  current: string | null | undefined,
  target: string,
): boolean {
  const curIdx = stageIndex(side, current);
  const tgtIdx = stageIndex(side, target);
  if (tgtIdx < 0) return false;
  return curIdx < tgtIdx;
}

/**
 * Which pipeline side(s) to bump. Prefer tracker sides; when both are present,
 * narrow by lead intent. Unknown intent with both sides → bump both.
 */
export function resolveBumpSides(
  rec: Pick<TrackerRecord, "sides">,
  leadIntent?: CrmIntent | string | null,
): TrackerSide[] {
  const sides = (rec.sides || []).filter((s): s is TrackerSide => s === "buyer" || s === "seller");
  if (!sides.length) return ["buyer"];
  if (sides.length === 1) return sides;

  const intent = String(leadIntent || "")
    .trim()
    .toLowerCase();
  if (intent === "buyer") return ["buyer"];
  if (intent === "seller") return ["seller"];
  // buyer_seller / empty / other — touch both sides that exist
  return sides;
}

export function targetStageForKind(side: TrackerSide, kind: DialerBumpKind): string | null {
  if (kind === "contacted") return "contacted";
  if (kind === "appointment") {
    return side === "seller" ? "listing_appointment_set" : "actively_showing";
  }
  return null;
}

export function planDialerBump(
  rec: TrackerRecord,
  kind: DialerBumpKind,
  leadIntent?: CrmIntent | string | null,
): DialerBumpChange[] {
  if (!kind) return [];
  const changes: DialerBumpChange[] = [];
  for (const side of resolveBumpSides(rec, leadIntent)) {
    const target = targetStageForKind(side, kind);
    if (!target) continue;
    const current = side === "buyer" ? rec.buyerStage : rec.sellerStage;
    // Talked: only when unstaged (empty) OR seller still at pipeline "new".
    // Appointment: empty or earlier than the appointment-equivalent step.
    if (kind === "contacted") {
      const unstaged = !current;
      const sellerNew = side === "seller" && current === "new";
      if (!unstaged && !sellerNew) continue;
      if (!canAdvanceStage(side, current, target)) continue;
    } else if (!canAdvanceStage(side, current, target)) {
      continue;
    }
    changes.push({ side, from: current || null, to: target });
  }
  return changes;
}

/**
 * Apply a Dialer activity outcome to the linked tracker row, if any.
 * No-op when source is not Dialer, outcome is irrelevant, or no tracker exists.
 */
export function bumpTrackerFromDialerActivity(input: DialerBumpInput): DialerBumpResult {
  const empty: DialerBumpResult = { applied: false, reason: "noop", kind: null, changes: [] };

  if (!isDialerActivitySource(input.source)) {
    return { ...empty, reason: "not_dialer" };
  }

  const kind = classifyDialerOutcome(input.outcome);
  if (!kind) {
    return { ...empty, reason: "outcome_ignored", kind: null };
  }

  const leadId = String(input.leadId || "").trim();
  if (!leadId) return { ...empty, reason: "missing_lead", kind };

  const rec = getTrackerRecordByLead(leadId);
  if (!rec) {
    return { applied: false, reason: "no_tracker", kind, changes: [] };
  }

  const changes = planDialerBump(rec, kind, input.leadIntent);
  if (!changes.length) {
    return { applied: false, reason: "already_ahead", kind, recordId: rec.id, changes: [] };
  }

  if (input.dryRun) {
    return { applied: false, reason: "dry_run", kind, recordId: rec.id, changes };
  }

  for (const c of changes) {
    setTrackerStage(rec.id, c.side, c.to);
  }
  return { applied: true, reason: "bumped", kind, recordId: rec.id, changes };
}

/** Convenience for callers that already have the lead loaded. */
export function bumpTrackerFromDialerLeadCall(
  lead: Pick<Lead, "id" | "crmIntent">,
  outcome: string,
  source?: string | null,
  dryRun = false,
): DialerBumpResult {
  return bumpTrackerFromDialerActivity({
    leadId: lead.id,
    outcome,
    source,
    leadIntent: lead.crmIntent,
    dryRun,
  });
}
