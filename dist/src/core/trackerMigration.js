"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.backfillTrackerFromLeads = backfillTrackerFromLeads;
const trackerStore_js_1 = require("./trackerStore.js");
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
const BUYER_FROM_LEGACY = {
    new: undefined, // not yet in the pipeline; buyer track starts at Contacted
    hot: "contacted",
    warm: "contacted",
    cold: "contacted",
    appointment_set: "actively_showing", // BEST-GUESS: buyers have no "appointment set"
    showing_set: "actively_showing",
    pending: "under_contract", // BEST-GUESS: "Pending" is a status in the new model
    under_contract: "under_contract",
    closed: "closed",
};
/** Legacy CRM stage -> seller pipeline. */
const SELLER_FROM_LEGACY = {
    new: "new",
    hot: "contacted",
    warm: "contacted",
    cold: "contacted",
    appointment_set: "listing_appointment_set",
    showing_set: "appointment_held", // BEST-GUESS: closest seller-side equivalent
    pending: "under_contract", // BEST-GUESS: see above
    under_contract: "under_contract",
    closed: "closed",
};
/** CRM status -> tracker status. The tracker adds "pending", which no CRM status maps to. */
function statusFromLead(lead) {
    const s = String(lead.crmStatus || "");
    if (s === "hot")
        return "hot";
    if (s === "watch")
        return "watch";
    if (s === "nurture" || s === "contacted")
        return "nurture";
    if (s === "dead" || s === "unresponsive")
        return "unqualified";
    // A lead already under contract reads better as Pending than New.
    if (lead.crmStage === "pending" || lead.crmStage === "under_contract")
        return "pending";
    return "new";
}
function sidesFromIntent(intent) {
    if (intent === "seller")
        return ["seller"];
    if (intent === "buyer_seller")
        return ["buyer", "seller"];
    return ["buyer"];
}
function bump(map, key) {
    map[key] = (map[key] || 0) + 1;
}
const BEST_GUESS_LEGACY = new Set(["appointment_set", "showing_set", "pending"]);
/**
 * @param leads   every CRM lead
 * @param dryRun  when true, nothing is written; the caller sees what would happen
 */
function backfillTrackerFromLeads(leads, dryRun = false) {
    const out = {
        scanned: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        needsReview: [],
        breakdown: { legacyStage: {}, sides: {}, status: {}, buyerStage: {}, sellerStage: {} },
        dryRun,
    };
    for (const lead of leads) {
        out.scanned++;
        const name = (lead.name || lead.username || "").trim();
        // A record with no name and no way to reach them is not worth a tracker row.
        if (!name && !lead.phone && !lead.email) {
            out.skipped++;
            continue;
        }
        const legacy = (lead.crmStage || "new");
        const sides = sidesFromIntent(lead.crmIntent);
        const buyerStage = sides.includes("buyer") ? BUYER_FROM_LEGACY[legacy] : undefined;
        const sellerStage = sides.includes("seller") ? SELLER_FROM_LEGACY[legacy] : undefined;
        bump(out.breakdown.legacyStage, legacy);
        bump(out.breakdown.sides, sides.join("+"));
        bump(out.breakdown.status, statusFromLead(lead));
        bump(out.breakdown.buyerStage, buyerStage || (sides.includes("buyer") ? "none" : "n/a"));
        bump(out.breakdown.sellerStage, sellerStage || (sides.includes("seller") ? "none" : "n/a"));
        const existing = (0, trackerStore_js_1.getTrackerRecordByLead)(lead.id);
        if (existing) {
            // Never clobber work done in the tracker: only fill gaps.
            const patch = {};
            if (!existing.buyerStage && buyerStage)
                patch.buyerStage = buyerStage;
            if (!existing.sellerStage && sellerStage)
                patch.sellerStage = sellerStage;
            if (!existing.legacyStage)
                patch.legacyStage = legacy;
            if (Object.keys(patch).length) {
                if (!dryRun)
                    (0, trackerStore_js_1.updateTrackerRecord)(existing.id, patch);
                out.updated++;
            }
            else {
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
        const created = dryRun ? { ...rec, id: `dry_${out.created}` } : (0, trackerStore_js_1.createTrackerRecord)(rec);
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
