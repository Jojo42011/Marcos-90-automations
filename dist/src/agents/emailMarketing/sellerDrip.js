"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSellerDrip = startSellerDrip;
exports.processDueSellerDrips = processDueSellerDrips;
exports.scheduleSellerDripProcessor = scheduleSellerDripProcessor;
const index_js_1 = require("../../integrations/email/index.js");
const emailStore_js_1 = require("../../core/emailStore.js");
const db_js_1 = require("../../core/db.js");
const SELLER_DRIP_DAYS = [0, 2, 5, 9, 14];
const SELLER_DRIP_STEPS = [
    {
        subject: (n) => `Welcome, ${n} — let's get your home sold`,
        body: (n) => `Hi ${n},\n\nThanks for reaching out about selling! Over the next couple weeks I'll send a few things that'll help as we get your home ready to list. Let me know if you'd like to set up a time to talk pricing and strategy sooner.\n\nMarco`,
    },
    {
        subject: () => `What buyers notice first`,
        body: (n) => `Hi ${n},\n\nA few small things make a big difference in how buyers perceive a home in the first 10 seconds. Happy to do a quick walkthrough and point out anything worth addressing before we list.\n\nMarco`,
    },
    {
        subject: () => `How we'll price your home to sell`,
        body: (n) => `Hi ${n},\n\nPricing strategy can make or break how fast a home sells and for how much. I'll pull together a comparative market analysis so we go in with real numbers, not guesses.\n\nMarco`,
    },
    {
        subject: () => `What happens once we list`,
        body: (n) => `Hi ${n},\n\nOnce we're live, here's what the next few weeks typically look like — showings, feedback, and how we'll adjust if needed. Want to set a target list date?\n\nMarco`,
    },
    {
        subject: () => `Ready when you are`,
        body: (n) => `Hi ${n},\n\nJust checking in — happy to answer any questions or get things moving whenever you're ready. No pressure, just here when you need me.\n\nMarco`,
    },
];
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
        const subject = stepDef.subject(firstName);
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
