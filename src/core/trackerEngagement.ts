import type { Lead, TrackerRecord, TrackerSide } from "./types.js";
import {
  createTrackerRecord,
  getTrackerRecordByLead,
  listTrackerRecords,
  updateTrackerRecord,
} from "./trackerStore.js";

/**
 * Stage the tracker from real DM engagement — the only reliable signal that
 * exists for most of the 1,219 records.
 *
 * Two things ruled out simpler approaches before this was written:
 *   - The CRM's `crmStage` is "new" for essentially everyone (that is WHY the
 *     tracker exists), and Brivity's own stage field is no better (2,591 of
 *     2,595 contacts are stage "new"). Neither carries any pipeline signal.
 *   - Message TEXT does carry signal, but reading and judging free text per
 *     lead is exactly the kind of silent guess this codebase's conventions
 *     rule out (see trackerMigration.ts's BEST-GUESS discipline).
 *
 * What DOES exist: `Lead.state`, the DM funnel's own step tracker
 * (FunnelStage: new → ... → criteria_collected → property_sent → closed).
 * `criteria_collected` / `property_sent` / `closed` are non-"new" values the
 * pipeline only sets after a real two-way exchange — phone or criteria given,
 * a property breakdown sent. That is genuine evidence of contact.
 *
 * IMPORTANT: FunnelStage.Closed means the DM CONVERSATION concluded (property
 * list sent, handed off) — NOT a sold or bought property. It must never be
 * read as the tracker's "closed" stage. See funnelDeterministic.ts:
 * chainEmailSentToClosed() only ever sets it after EmailSent, nothing to do
 * with a transaction.
 *
 * So the only defensible move is a single step out of Unstaged, for whichever
 * side(s) the record has, and ONLY when that side has no stage yet: buyers go
 * to Not Contacted (a number is in hand, the first call has not happened) and
 * sellers to New. Contacted needs a real call — the Dialer moves it there.
 */

/** First stage a DM-sourced contact lands on, per side. */
export const ENGAGED_ENTRY_STAGE: Record<TrackerSide, string> = {
  buyer: "not_contacted",
  seller: "new",
};

/** DM funnel states that only occur after a genuine two-way exchange. */
export const ENGAGED_FUNNEL_STATES = new Set(["criteria_collected", "property_sent", "closed"]);

export function isEngagedFunnelState(state: string | null | undefined): boolean {
  return ENGAGED_FUNNEL_STATES.has(String(state || ""));
}

export interface EngagementStageOptions {
  dryRun?: boolean;
  /** When set, only consider tracker rows linked to these lead ids. */
  leadIds?: string[];
}

export interface EngagementStageChange {
  recordId: string;
  name: string;
  side: TrackerSide;
  leadState: string;
}

export interface EngagementStageResult {
  dryRun: boolean;
  /** Tracker records checked that have a linked lead. */
  scanned: number;
  /** Linked lead had no engagement signal (state === "new" or missing). */
  noSignal: number;
  /** Had signal, but the side was already staged — left untouched. */
  alreadyStaged: number;
  changes: EngagementStageChange[];
}

export function stageTrackerFromEngagement(
  leads: Lead[],
  opts: EngagementStageOptions = {},
): EngagementStageResult {
  const dryRun = opts.dryRun !== false;
  const leadById = new Map(leads.map((l) => [l.id, l]));

  const out: EngagementStageResult = {
    dryRun,
    scanned: 0,
    noSignal: 0,
    alreadyStaged: 0,
    changes: [],
  };

  const scope = opts.leadIds?.length
    ? new Set(opts.leadIds.map((id) => String(id)))
    : null;

  const records: TrackerRecord[] = listTrackerRecords({});
  for (const rec of records) {
    if (!rec.leadId) continue;
    if (scope && !scope.has(rec.leadId)) continue;
    const lead = leadById.get(rec.leadId);
    if (!lead) continue;
    out.scanned++;

    const state = String(lead.state || "new");
    if (!isEngagedFunnelState(state)) {
      out.noSignal++;
      continue;
    }

    const sides = rec.sides || [];
    const patch: Record<string, unknown> = {};
    let touched = false;

    if (sides.includes("buyer") && !rec.buyerStage) {
      patch.buyerStage = ENGAGED_ENTRY_STAGE.buyer;
      out.changes.push({ recordId: rec.id, name: rec.name, side: "buyer", leadState: state });
      touched = true;
    }
    if (sides.includes("seller") && !rec.sellerStage) {
      patch.sellerStage = ENGAGED_ENTRY_STAGE.seller;
      out.changes.push({ recordId: rec.id, name: rec.name, side: "seller", leadState: state });
      touched = true;
    }

    if (!touched) {
      out.alreadyStaged++;
      continue;
    }

    // Real contact happened; the timestamp is worth carrying over if the
    // tracker record does not already have one of its own.
    if (!rec.lastInteractionAt && lead.lastActivity) {
      patch.lastInteractionAt = lead.lastActivity;
    }

    if (!dryRun) updateTrackerRecord(rec.id, patch as never);
  }

  return out;
}

/**
 * A phone number just arrived in the DM funnel. Put the person on the Tracker
 * at the entry stage so the first call is visible, without ever moving a side
 * that is already staged. Sellers stay seller-side; everyone else is a buyer.
 */
export function stageTrackerFromPhoneCapture(
  lead: Pick<Lead, "id" | "name" | "username" | "phone" | "email" | "source" | "platform" | "crmIntent" | "assignedUserName">,
): { created: boolean; recordId: string; changed: TrackerSide[] } | null {
  if (!String(lead.phone || "").replace(/\D/g, "")) return null;
  const intent = String(lead.crmIntent || "").toLowerCase();
  const sides: TrackerSide[] =
    intent === "seller" ? ["seller"] : intent === "buyer_seller" ? ["buyer", "seller"] : ["buyer"];
  const existing = getTrackerRecordByLead(lead.id);
  if (!existing) {
    const rec = createTrackerRecord({
      leadId: lead.id,
      name: lead.name || lead.username || lead.phone || "Unnamed",
      phone: lead.phone || undefined,
      email: lead.email || undefined,
      source: lead.source || lead.platform || undefined,
      assignedTo: lead.assignedUserName || undefined,
      sides,
      status: "new",
      buyerStage: sides.includes("buyer") ? ENGAGED_ENTRY_STAGE.buyer : undefined,
      sellerStage: sides.includes("seller") ? ENGAGED_ENTRY_STAGE.seller : undefined,
      stageMeta: Object.fromEntries(
        sides.map((side) => [`${side}:${ENGAGED_ENTRY_STAGE[side]}`, { enteredAt: new Date().toISOString() }]),
      ),
    });
    return { created: true, recordId: rec.id, changed: sides };
  }
  const patch: Record<string, unknown> = {};
  const changed: TrackerSide[] = [];
  const stageMeta = { ...(existing.stageMeta || {}) };
  for (const side of existing.sides) {
    const current = side === "buyer" ? existing.buyerStage : existing.sellerStage;
    if (current) continue;
    patch[side === "buyer" ? "buyerStage" : "sellerStage"] = ENGAGED_ENTRY_STAGE[side];
    stageMeta[`${side}:${ENGAGED_ENTRY_STAGE[side]}`] = { enteredAt: new Date().toISOString() };
    changed.push(side);
  }
  if (changed.length) updateTrackerRecord(existing.id, { ...patch, stageMeta } as never);
  return { created: false, recordId: existing.id, changed };
}
