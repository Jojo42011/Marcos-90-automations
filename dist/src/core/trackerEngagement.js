"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stageTrackerFromEngagement = stageTrackerFromEngagement;
const trackerStore_js_1 = require("./trackerStore.js");
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
 * So the only defensible move is a single step: Unstaged → Contacted, for
 * whichever side(s) the record has, and ONLY when that side has no stage yet.
 * Nothing here claims Qualified, Actively Showing, or anything past first
 * contact — those require real work (a call, a showing) this data cannot see.
 */
/** DM funnel states that only occur after a genuine two-way exchange. */
const ENGAGED_STATES = new Set(["criteria_collected", "property_sent", "closed"]);
function stageTrackerFromEngagement(leads, opts = {}) {
    const dryRun = opts.dryRun !== false;
    const leadById = new Map(leads.map((l) => [l.id, l]));
    const out = {
        dryRun,
        scanned: 0,
        noSignal: 0,
        alreadyStaged: 0,
        changes: [],
    };
    const records = (0, trackerStore_js_1.listTrackerRecords)({});
    for (const rec of records) {
        if (!rec.leadId)
            continue;
        const lead = leadById.get(rec.leadId);
        if (!lead)
            continue;
        out.scanned++;
        const state = String(lead.state || "new");
        if (!ENGAGED_STATES.has(state)) {
            out.noSignal++;
            continue;
        }
        const sides = rec.sides || [];
        const patch = {};
        let touched = false;
        if (sides.includes("buyer") && !rec.buyerStage) {
            patch.buyerStage = "contacted";
            out.changes.push({ recordId: rec.id, name: rec.name, side: "buyer", leadState: state });
            touched = true;
        }
        if (sides.includes("seller") && !rec.sellerStage) {
            patch.sellerStage = "contacted";
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
        if (!dryRun)
            (0, trackerStore_js_1.updateTrackerRecord)(rec.id, patch);
    }
    return out;
}
