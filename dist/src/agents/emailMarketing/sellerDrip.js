"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.__testSellerSteps = void 0;
exports.startSellerDrip = startSellerDrip;
exports.processDueSellerDrips = processDueSellerDrips;
exports.scheduleSellerDripProcessor = scheduleSellerDripProcessor;
const index_js_1 = require("../../integrations/email/index.js");
const emailStore_js_1 = require("../../core/emailStore.js");
const db_js_1 = require("../../core/db.js");
const index_js_2 = require("../../integrations/simplyrets/index.js");
const listingMatch_js_1 = require("../../core/listingMatch.js");
/**
 * WHAT THIS DRIP CAN AND CANNOT SAY.
 *
 * The SABOR feed Marco is entitled to returns Active and Pending listings. It
 * does NOT carry sold prices. So this drip talks about what a seller is
 * COMPETING WITH — how many homes are on the market in their city, what those
 * homes are asking, how many are already under contract — and never about what
 * anything sold for. A seller who prices against a "sold" figure that was
 * really someone's asking price sits on the market for months.
 *
 * The CMA Marco produces by hand does use sold comps; he pulls those from his
 * agent MLS access. The email says he will pull them, which is true, rather
 * than pretending this feed already did.
 */
const SELLER_DRIP_DAYS = [0, 2, 5, 9, 14];
/** Market context for this seller's city, or null when we cannot name one. */
function market(lead) {
    if (!(0, index_js_2.isMlsFeedConfigured)())
        return null;
    try {
        return (0, listingMatch_js_1.marketForLead)(lead);
    }
    catch (err) {
        /* A drip must never fail to send because a lookup broke. */
        console.error("[SellerDrip] market lookup failed:", err);
        return null;
    }
}
/**
 * The seller's own home as it reads in the MLS today.
 *
 * Only present once their property is actually listed and we matched it with
 * certainty. Live rather than cached, so a price change or a move to Pending
 * shows up instead of whatever was true the day they were added.
 */
function theirHome(lead) {
    if (!(0, index_js_2.isMlsFeedConfigured)())
        return null;
    try {
        const { listing } = (0, listingMatch_js_1.liveListingForLead)(lead);
        if (!listing)
            return null;
        const where = [listing.street, listing.city].filter(Boolean).join(", ");
        const spec = (0, listingMatch_js_1.specLine)(listing);
        const status = listing.status ? ` — currently ${listing.status}` : "";
        return `${where} at ${(0, listingMatch_js_1.money)(listing.listPrice)}${spec ? ` (${spec})` : ""}${status}`;
    }
    catch {
        return null;
    }
}
const SELLER_DRIP_STEPS = [
    {
        subject: (n) => `Welcome, ${n} — let's get your home sold`,
        body: (n, lead) => {
            const line = (0, listingMatch_js_1.marketSentence)(market(lead));
            const context = line ? `\n\nFor context on where things stand: ${line}` : "";
            return `Hi ${n},\n\nThanks for reaching out about selling! Over the next couple weeks I'll send a few things that'll help as we get your home ready to list. Let me know if you'd like to set up a time to talk pricing and strategy sooner.${context}\n\nMarco`;
        },
    },
    {
        subject: () => `What buyers notice first`,
        body: (n) => `Hi ${n},\n\nA few small things make a big difference in how buyers perceive a home in the first 10 seconds. Happy to do a quick walkthrough and point out anything worth addressing before we list.\n\nMarco`,
    },
    {
        /* Was a promise of "real numbers, not guesses" containing no numbers. Now
           it carries the inventory a seller is genuinely competing against, and
           labels every figure as an asking price, because that is what it is. */
        subject: () => `How we'll price your home to sell`,
        body: (n, lead) => {
            const m = market(lead);
            if (!m) {
                return `Hi ${n},\n\nPricing strategy can make or break how fast a home sells and for how much. I'll pull together a comparative market analysis so we go in with real numbers, not guesses.\n\nMarco`;
            }
            const lines = [
                `Hi ${n},`,
                "",
                `Pricing comes down to what a buyer sees next to your home. Here is what they are looking at in ${m.city} today:`,
                "",
                `• ${m.active.toLocaleString("en-US")} homes actively for sale`,
            ];
            if (m.medianActivePrice)
                lines.push(`• Median asking price: ${(0, listingMatch_js_1.money)(m.medianActivePrice)}`);
            if (m.medianSqft) {
                lines.push(`• Typical size on the market: ${Math.round(m.medianSqft).toLocaleString("en-US")} sqft`);
            }
            if (m.newLast30)
                lines.push(`• ${m.newLast30.toLocaleString("en-US")} of those came on in the last 30 days`);
            if (m.pending)
                lines.push(`• ${m.pending.toLocaleString("en-US")} homes are already under contract`);
            lines.push("", 
            /* The distinction that keeps this email honest. */
            "Those are asking prices, not sale prices. I'll pull the actual solds and put together a full comparative market analysis for your street — that's the number we price against.", "", "Marco");
            return lines.join("\n");
        },
    },
    {
        subject: () => `What happens once we list`,
        body: (n, lead) => {
            const m = market(lead);
            /* Pending against active is the one real absorption signal this feed
               supports. Skipped entirely when there is nothing under contract. */
            const pace = m && m.pending && m.active
                ? `\n\nRight now ${m.pending.toLocaleString("en-US")} homes in ${m.city} are under contract against ${m.active.toLocaleString("en-US")} still available, which is a decent read on how quickly buyers are moving.`
                : "";
            return `Hi ${n},\n\nOnce we're live, here's what the next few weeks typically look like — showings, feedback, and how we'll adjust if needed. Want to set a target list date?${pace}\n\nMarco`;
        },
    },
    {
        subject: () => `Ready when you are`,
        body: (n, lead) => {
            const home = theirHome(lead);
            const status = home ? `\n\nYour listing as it reads today: ${home}` : "";
            return `Hi ${n},\n\nJust checking in — happy to answer any questions or get things moving whenever you're ready. No pressure, just here when you need me.${status}\n\nMarco`;
        },
    },
];
/**
 * Exported so the copy can be exercised directly against the listings mirror.
 * There is no test runner in this repo, so the alternative is asserting on a
 * regex over the source, which does not catch an email that renders "$NaN".
 */
exports.__testSellerSteps = SELLER_DRIP_STEPS;
function startSellerDrip(leadId) {
    (0, emailStore_js_1.startDripSequence)(leadId, "seller_drip", new Date().toISOString());
    console.log("[SellerDrip] Started for lead", leadId);
}
async function processDueSellerDrips() {
    const due = (0, emailStore_js_1.getActiveSequencesDueNow)("seller_drip");
    let sent = 0;
    for (const seq of due) {
        const lead = await (0, db_js_1.findLeadById)(seq.leadId);
        if (!lead || !lead.email) {
            (0, emailStore_js_1.updateDripSequence)(seq.id, { status: "stopped" });
            continue;
        }
        const step = seq.currentStep;
        if (step >= SELLER_DRIP_STEPS.length) {
            (0, emailStore_js_1.updateDripSequence)(seq.id, { status: "completed" });
            continue;
        }
        const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
        const stepDef = SELLER_DRIP_STEPS[step];
        const subject = stepDef.subject(firstName, lead);
        const body = stepDef.body(firstName, lead);
        const emailRecord = (0, emailStore_js_1.logEmail)({
            leadId: lead.id,
            subject,
            body,
            emailType: "seller_drip",
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
        if (nextStep >= SELLER_DRIP_STEPS.length) {
            (0, emailStore_js_1.updateDripSequence)(seq.id, { currentStep: nextStep, status: "completed" });
        }
        else {
            const daysUntilNext = SELLER_DRIP_DAYS[nextStep] - SELLER_DRIP_DAYS[step];
            const nextSendDate = new Date(Date.now() + daysUntilNext * 24 * 60 * 60 * 1000).toISOString();
            (0, emailStore_js_1.updateDripSequence)(seq.id, { currentStep: nextStep, nextSendDate });
        }
    }
    console.log("[SellerDrip] Processed", sent, "due emails");
    return { sent };
}
function scheduleSellerDripProcessor() {
    setInterval(() => {
        processDueSellerDrips().catch((err) => console.error("[SellerDrip]", err));
    }, 60 * 60 * 1000);
    console.log("[SellerDrip] Scheduled — checking hourly");
}
