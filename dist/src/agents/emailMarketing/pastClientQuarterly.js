"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPastClientQuarterlyTouch = runPastClientQuarterlyTouch;
exports.schedulePastClientQuarterly = schedulePastClientQuarterly;
const index_js_1 = require("../../integrations/email/index.js");
const emailStore_js_1 = require("../../core/emailStore.js");
const db_js_1 = require("../../core/db.js");
const QUARTERLY_CONTENT = {
    1: {
        subject: (n) => `Happy home anniversary, ${n}!`,
        body: (n) => `Hi ${n},\n\nJust thinking of you as another year goes by in your home! Hope everything's going great. As always, here if you ever need anything — even just a contractor recommendation.\n\nMarco`,
    },
    2: {
        subject: () => `Quick market update for your area`,
        body: (n) => `Hi ${n},\n\nWanted to share a quick update on how home values have been trending in your neighborhood — always good info to have, even if you're not planning to move anytime soon.\n\nMarco`,
    },
    3: {
        subject: () => `A small favor, if you don't mind`,
        body: (n) => `Hi ${n},\n\nHope things are going well! If you know anyone thinking about buying or selling, I'd really appreciate the introduction. Always happy to take great care of anyone you send my way.\n\nMarco`,
    },
    4: {
        subject: () => `Happy holidays from our family to yours`,
        body: (n) => `Hi ${n},\n\nWishing you and your family a wonderful holiday season! Thank you for being part of our story — it means a lot. Looking forward to staying in touch in the new year.\n\nMarco`,
    },
};
function getCurrentQuarter() {
    return Math.ceil((new Date().getMonth() + 1) / 3);
}
async function runPastClientQuarterlyTouch() {
    const leads = await (0, db_js_1.listAllLeads)();
    const pastClients = leads.filter((l) => l.isPastClient && l.email);
    const quarter = getCurrentQuarter();
    const quarterKey = `${new Date().getFullYear()}-Q${quarter}`;
    const content = QUARTERLY_CONTENT[quarter];
    let sent = 0;
    for (const lead of pastClients) {
        const seq = (0, emailStore_js_1.getSequenceForLead)(lead.id, "past_client_quarterly");
        if (seq?.lastQuarterSent === quarterKey)
            continue;
        const firstName = lead.name?.trim().split(/\s+/)[0] || "there";
        const subject = content.subject(firstName);
        const body = content.body(firstName);
        const emailRecord = (0, emailStore_js_1.logEmail)({
            leadId: lead.id,
            subject,
            body,
            emailType: "past_client_quarterly",
            sendStatus: "pending",
        });
        const result = await (0, index_js_1.sendEmail)(lead.email, subject, body);
        if (result.success)
            (0, emailStore_js_1.markEmailSent)(emailRecord.id, result.messageId);
        else
            (0, emailStore_js_1.markEmailFailed)(emailRecord.id, result.error || "unknown");
        if (seq) {
            (0, emailStore_js_1.updateDripSequence)(seq.id, { lastQuarterSent: quarterKey });
        }
        else {
            const newSeq = (0, emailStore_js_1.startDripSequence)(lead.id, "past_client_quarterly");
            (0, emailStore_js_1.updateDripSequence)(newSeq.id, { lastQuarterSent: quarterKey });
        }
        sent++;
    }
    console.log("[PastClientQuarterly] Q" + quarter, "— sent", sent);
    return { sent };
}
function schedulePastClientQuarterly() {
    let lastRunQuarter = null;
    setInterval(() => {
        const now = new Date();
        const centralHour = parseInt(now.toLocaleString("en-US", { timeZone: "America/Chicago", hour: "2-digit", hour12: false }), 10);
        const centralDate = parseInt(now.toLocaleString("en-US", { timeZone: "America/Chicago", day: "numeric" }), 10);
        const centralMonth = parseInt(now.toLocaleString("en-US", { timeZone: "America/Chicago", month: "numeric" }), 10);
        const quarterKey = `${now.getFullYear()}-Q${getCurrentQuarter()}`;
        const isQuarterStart = [1, 4, 7, 10].includes(centralMonth) && centralDate === 1;
        if (isQuarterStart && centralHour === 9 && lastRunQuarter !== quarterKey) {
            lastRunQuarter = quarterKey;
            runPastClientQuarterlyTouch().catch((err) => console.error("[PastClientQuarterly]", err));
        }
    }, 60 * 60 * 1000);
    console.log("[PastClientQuarterly] Scheduled — 1st of each quarter, 9am Central");
}
