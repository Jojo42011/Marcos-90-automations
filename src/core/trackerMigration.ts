import type { BuyerStage, CrmIntent, CrmStage, Lead, SellerStage, TrackerSide, TrackerStatus } from "./types.js";
import {
  createTrackerRecord,
  getTrackerRecordByLead,
  updateTrackerRecord,
} from "./trackerStore.js";

/**
 * Backfill the Buyers & Sellers Tracker from existing CRM leads.
 *
 * The old model had ONE stage list shared by buyers and sellers; the tracker has
 * two separate pipelines. There is no lossless mapping — `APPOINTMENT SET` means
 * a showing to a buyer and a listing appointment to a seller — so every record
 * keeps its original value in `legacyStage`. That makes this re-runnable and
 * lets a wrong guess be corrected in bulk later instead of re-entered by hand.
 *
 * Judgement calls are marked BEST-GUESS below; those are the ones worth a human
 * eye before the tracker is treated as authoritative.
 */

/** Legacy CRM stage -> buyer pipeline. */
const BUYER_FROM_LEGACY: Record<CrmStage, BuyerStage | undefined> = {
  new: undefined,                    // not yet in the pipeline; buyer track starts at Contacted
  hot: "contacted",
  warm: "contacted",
  cold: "contacted",
  appointment_set: "actively_showing",   // BEST-GUESS: buyers have no "appointment set"
  showing_set: "actively_showing",
  pending: "under_contract",             // BEST-GUESS: "Pending" is a status in the new model
  under_contract: "under_contract",
  closed: "closed",
};

/** Legacy CRM stage -> seller pipeline. */
const SELLER_FROM_LEGACY: Record<CrmStage, SellerStage | undefined> = {
  new: "new",
  hot: "contacted",
  warm: "contacted",
  cold: "contacted",
  appointment_set: "listing_appointment_set",
  showing_set: "appointment_held",       // BEST-GUESS: closest seller-side equivalent
  pending: "under_contract",             // BEST-GUESS: see above
  under_contract: "under_contract",
  closed: "closed",
};

/** CRM status -> tracker status. The tracker adds "pending", which no CRM status maps to. */
function statusFromLead(lead: Lead): TrackerStatus {
  const s = String(lead.crmStatus || "");
  if (s === "hot") return "hot";
  if (s === "watch") return "watch";
  if (s === "nurture" || s === "contacted") return "nurture";
  if (s === "dead" || s === "unresponsive") return "unqualified";
  // A lead already under contract reads better as Pending than New.
  if (lead.crmStage === "pending" || lead.crmStage === "under_contract") return "pending";
  return "new";
}

function sidesFromIntent(intent: CrmIntent | undefined): TrackerSide[] {
  if (intent === "seller") return ["seller"];
  if (intent === "buyer_seller") return ["buyer", "seller"];
  return ["buyer"];
}

export interface TrackerBackfillResult {
  scanned: number;
  created: number;
  updated: number;
  skipped: number;
  /** Records whose stage came from a BEST-GUESS mapping and deserve review. */
  needsReview: Array<{ id: string; name: string; legacyStage: string; mappedTo: string }>;
  /** Existing tracker records whose name was refreshed from the lead. */
  refreshed: number;
  /**
   * What the run would actually produce, so a dry run shows shape and not just
   * a total. `buyerStage.none` counting most of the set means the source data
   * has no pipeline information to carry over — worth knowing before applying.
   */
  breakdown: {
    legacyStage: Record<string, number>;
    sides: Record<string, number>;
    status: Record<string, number>;
    buyerStage: Record<string, number>;
    sellerStage: Record<string, number>;
  };
  dryRun: boolean;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1;
}

const BEST_GUESS_LEGACY = new Set<CrmStage>(["appointment_set", "showing_set", "pending"]);

/**
 * ManyChat merge fields that never resolved come through as literal
 * `{{full_name}}`. That is not a name — treating it as one imported 44 nameless,
 * phoneless rows on the first production run. Anything left is a real name.
 */
function cleanName(raw: string | undefined): string {
  const s = String(raw || "").replace(/\{\{[^}]*\}\}/g, "").trim();
  return s;
}

/**
 * @param leads   every CRM lead
 * @param dryRun  when true, nothing is written; the caller sees what would happen
 */
export interface TrackerBackfillOptions {
  /**
   * Also pull name / phone / email down from the lead onto tracker records that
   * already exist. Off by default so a routine re-run can never overwrite
   * something edited by hand in the tracker; turn it on after the lead store
   * gains better data (the Brivity import replaced 159 social handles with real
   * names, and the tracker was still showing "purple kitty 22").
   */
  refreshIdentity?: boolean;
}

export function backfillTrackerFromLeads(
  leads: Lead[],
  dryRun = false,
  options: TrackerBackfillOptions = {},
): TrackerBackfillResult {
  const out: TrackerBackfillResult = {
    scanned: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    needsReview: [],
    refreshed: 0,
    breakdown: { legacyStage: {}, sides: {}, status: {}, buyerStage: {}, sellerStage: {} },
    dryRun,
  };

  for (const lead of leads) {
    out.scanned++;
    const name = cleanName(lead.name) || cleanName(lead.username);
    // A record with no name and no way to reach them is not worth a tracker row.
    if (!name && !lead.phone && !lead.email) {
      out.skipped++;
      continue;
    }

    const legacy = (lead.crmStage || "new") as CrmStage;
    const sides = sidesFromIntent(lead.crmIntent);
    const buyerStage = sides.includes("buyer") ? BUYER_FROM_LEGACY[legacy] : undefined;
    const sellerStage = sides.includes("seller") ? SELLER_FROM_LEGACY[legacy] : undefined;

    bump(out.breakdown.legacyStage, legacy);
    bump(out.breakdown.sides, sides.join("+"));
    bump(out.breakdown.status, statusFromLead(lead));
    bump(out.breakdown.buyerStage, buyerStage || (sides.includes("buyer") ? "none" : "n/a"));
    bump(out.breakdown.sellerStage, sellerStage || (sides.includes("seller") ? "none" : "n/a"));

    const existing = getTrackerRecordByLead(lead.id);
    if (existing) {
      // Never clobber work done in the tracker: only fill gaps.
      const patch: Record<string, unknown> = {};
      if (!existing.buyerStage && buyerStage) patch.buyerStage = buyerStage;
      if (!existing.sellerStage && sellerStage) patch.sellerStage = sellerStage;
      if (!existing.legacyStage) patch.legacyStage = legacy;
      // Gap-fill contact details always; only overwrite when explicitly asked.
      if (!existing.phone && lead.phone) patch.phone = lead.phone;
      if (!existing.email && lead.email) patch.email = lead.email;
      if (options.refreshIdentity) {
        if (name && name !== existing.name) { patch.name = name; out.refreshed++; }
        if (lead.phone && lead.phone !== existing.phone) patch.phone = lead.phone;
        if (lead.email && lead.email !== existing.email) patch.email = lead.email;
      }
      if (Object.keys(patch).length) {
        if (!dryRun) updateTrackerRecord(existing.id, patch);
        out.updated++;
      } else {
        out.skipped++;
      }
      continue;
    }

    const rec = {
      leadId: lead.id,
      sides,
      name: name || lead.phone || "Unnamed",
      phone: lead.phone || undefined,
      email: lead.email || undefined,
      address: lead.criteria?.area || lead.propertyInquired || undefined,
      source: lead.source || undefined,
      status: statusFromLead(lead),
      buyerStage,
      sellerStage,
      lastInteractionAt: lead.lastActivity || undefined,
      addedAt: lead.createdAt,
      legacyStage: legacy,
      assignedTo: lead.assignedUserName || undefined,
    };
    const created = dryRun ? { ...rec, id: `dry_${out.created}` } : createTrackerRecord(rec);
    out.created++;

    if (BEST_GUESS_LEGACY.has(legacy)) {
      out.needsReview.push({
        id: created.id,
        name: rec.name,
        legacyStage: legacy,
        mappedTo: [buyerStage && `buyer:${buyerStage}`, sellerStage && `seller:${sellerStage}`]
          .filter(Boolean)
          .join(" + "),
      });
    }
  }
  return out;
}
