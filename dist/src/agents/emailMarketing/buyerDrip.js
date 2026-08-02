"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.__testBuyerSteps = void 0;
exports.startBuyerDrip = startBuyerDrip;
exports.processDueBuyerDrips = processDueBuyerDrips;
exports.scheduleBuyerDripProcessor = scheduleBuyerDripProcessor;
const index_js_1 = require("../../integrations/email/index.js");
const emailStore_js_1 = require("../../core/emailStore.js");
const db_js_1 = require("../../core/db.js");
const index_js_2 = require("../../integrations/simplyrets/index.js");
const listingMatch_js_1 = require("../../core/listingMatch.js");
/**
 * Real homes for this lead, as email lines.
 *
 * Returns null — not an empty string — when there is nothing genuine to show,
 * so a step can fall back to its original copy. An email titled "a few homes
 * worth a look" containing no homes, or homes picked at random because we had
 * no criteria, is worse than the generic version it replaced.
 */
function listingLines(lead, limit = 3) {
    if (!(0, index_js_2.isMlsFeedConfigured)())
        return null;
    try {
        const rows = (0, listingMatch_js_1.listingsForCriteria)(lead, limit);
        if (!rows.length)
            return null;
        return rows
            .map((l) => {
            const spec = (0, listingMatch_js_1.specLine)(l);
            const where = [l.street, l.city].filter(Boolean).join(", ");
            return `• ${where} — ${(0, listingMatch_js_1.money)(l.listPrice)}${spec ? ` (${spec})` : ""}`;
        })
            .join("\n");
    }
    catch (err) {
        /* A drip must never fail to send because a lookup broke. */
        console.error("[BuyerDrip] listing lookup failed:", err);
        return null;
    }
}
/** The property this lead asked about, if we ever matched one with certainty. */
function theirProperty(lead) {
    if (!(0, index_js_2.isMlsFeedConfigured)())
        return null;
    try {
        const { listing } = (0, listingMatch_js_1.liveListingForLead)(lead);
        if (!listing)
            return null;
        const where = [listing.street, listing.city].filter(Boolean).join(", ");
        const spec = (0, listingMatch_js_1.specLine)(listing);
        const status = listing.status && listing.status.toLowerCase() !== "active"
            ? ` It is currently ${listing.status}.`
            : "";
        return `${where} is listed at ${(0, listingMatch_js_1.money)(listing.listPrice)}${spec ? ` (${spec})` : ""}.${status}`;
    }
    catch {
        return null;
    }
}
const BUYER_DRIP_DAYS = [0, 3, 7, 10, 14, 21];
const BUYER_DRIP_STEPS = [
    {
        subject: (n) => `Welcome, ${n} — let's find your next home`,
        body: (n) => `Hi ${n},\n\nThanks for connecting! I'm excited to help you find the right home. Over the next few weeks I'll send a few helpful resources — but if you ever want to jump straight to looking at properties, just let me know.\n\nMarco`,
    },
    {
        subject: (n) => `${n}, here's what to know about getting pre-approved`,
        body: (n) => `Hi ${n},\n\nOne of the biggest advantages in today's market is having a pre-approval ready before you fall in love with a home. If you haven't started that process yet, I'm happy to point you toward a few great local lenders.\n\nMarco`,
    },
    {
        /* Was: "want me to send a curated list?" and then no list. If the feed can
           supply real homes for this lead's criteria it now sends them; otherwise
           it falls back to the original ask rather than promising twice. */
        subject: (_n, lead) => (listingLines(lead) ? `A few homes worth a look` : `A few neighborhoods worth a look`),
        body: (n, lead) => {
            const lines = listingLines(lead, 3);
            if (!lines) {
                return `Hi ${n},\n\nDepending on what you're looking for, a few San Antonio-area neighborhoods have been getting a lot of buyer interest lately. Want me to send a curated list based on your price range and must-haves?\n\nMarco`;
            }
            return `Hi ${n},\n\nHere are a few that are active right now and line up with what you told me:\n\n${lines}\n\nHappy to send full details or set up a showing on any of them. Just reply and let me know.\n\nMarco`;
        },
    },
    {
        subject: () => `What to expect when you make an offer`,
        body: (n) => `Hi ${n},\n\nWhen the right home comes along, here's a quick rundown of what the offer process looks like so there are no surprises. Happy to walk through it on a call anytime.\n\nMarco`,
    },
    {
        subject: () => `Quick market check-in`,
        body: (n, lead) => {
            const theirs = theirProperty(lead);
            const lines = listingLines(lead, 3);
            if (!theirs && !lines) {
                return `Hi ${n},\n\nWanted to share a quick update on how the market's moving in your target area. Let me know if your timeline or criteria have changed at all!\n\nMarco`;
            }
            const parts = [`Hi ${n},`, ""];
            /* Their own property first: if it went Pending, that is the only thing in
               this email they actually need to know. */
            if (theirs)
                parts.push(`On the home you asked about: ${theirs}`, "");
            if (lines)
                parts.push(`A few others active in your range right now:`, "", lines, "");
            parts.push(`Let me know if your timeline or criteria have changed at all.`, "", `Marco`);
            return parts.join("\n");
        },
    },
    {
        subject: () => `Still here whenever you're ready`,
        body: (n) => `Hi ${n},\n\nNo pressure at all — just wanted to check in one more time. Whenever you're ready to take the next step, or if you have any questions in the meantime, I'm just a text or email away.\n\nMarco`,
    },
];
/** Exported for the same reason as the seller drip's — see the note there. */
exports.__testBuyerSteps = BUYER_DRIP_STEPS;
function startBuyerDrip(leadId) {
    (0, emailStore_js_1.startDripSequence)(leadId, "buyer_drip", new Date().toISOString());
    console.log("[BuyerDrip] Started for lead", leadId);
}
async function processDueBuyerDrips() {
    const due = (0, emailStore_js_1.getActiveSequencesDueNow)("buyer_drip");
    let sent = 0;
    for (const seq of due) {
        const lead = await (0, db_js_1.findLeadById)(seq.leadId);
        if (!lead || !lead.email) {
            (0, emailStore_js_1.updateDripSequence)(seq.id, { status: "stopped" });
            continue;
        }
        const step = seq.currentStep;
        if (step >= BUYER_DRIP_STEPS.length) {
            (0, emailStore_js_1.updateDripSequence)(seq.id, { status: "completed" });
            continue;
        }
        const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
        const stepDef = BUYER_DRIP_STEPS[step];
        const subject = stepDef.subject(firstName, lead);
        const body = stepDef.body(firstName, lead);
        const emailRecord = (0, emailStore_js_1.logEmail)({
            leadId: lead.id,
            subject,
            body,
            emailType: "buyer_drip",
            sequenceStep: step,
            sendStatus: "pending",
        });
        const result = await (0, index_js_1.sendEmail)(lead.email, subject, body);
        if (result.success)
            (0, emailStore_js_1.markEmailSent)(emailRecord.id, result.messageId);
        else
            (0, emailStore_js_1.markEmailFailed)(emailRecord.id, result.error || "unknown");
        sent++;
        const nextStep = step + 1;
        if (nextStep >= BUYER_DRIP_STEPS.length) {
            (0, emailStore_js_1.updateDripSequence)(seq.id, { currentStep: nextStep, status: "completed" });
        }
        else {
            const daysUntilNext = BUYER_DRIP_DAYS[nextStep] - BUYER_DRIP_DAYS[step];
            const nextSendDate = new Date(Date.now() + daysUntilNext * 24 * 60 * 60 * 1000).toISOString();
            (0, emailStore_js_1.updateDripSequence)(seq.id, { currentStep: nextStep, nextSendDate });
        }
    }
    console.log("[BuyerDrip] Processed", sent, "due emails");
    return { sent };
}
function scheduleBuyerDripProcessor() {
    setInterval(() => {
        processDueBuyerDrips().catch((err) => console.error("[BuyerDrip]", err));
    }, 60 * 60 * 1000);
    console.log("[BuyerDrip] Scheduled — checking hourly");
}
