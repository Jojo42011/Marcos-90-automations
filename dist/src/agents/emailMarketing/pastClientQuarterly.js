"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.__testQuarterlyContent = void 0;
exports.runPastClientQuarterlyTouch = runPastClientQuarterlyTouch;
exports.schedulePastClientQuarterly = schedulePastClientQuarterly;
const index_js_1 = require("../../integrations/email/index.js");
const emailStore_js_1 = require("../../core/emailStore.js");
const db_js_1 = require("../../core/db.js");
const index_js_2 = require("../../integrations/simplyrets/index.js");
const listingMatch_js_1 = require("../../core/listingMatch.js");
/**
 * What the mirror can honestly tell a past client about their area.
 *
 * NOT "how home values have been trending" — that needs sold prices, and this
 * feed carries Active and Pending only. What it can say is what is on the
 * market and what those homes are asking, labelled as exactly that. A past
 * client who reads an asking-price median as "what my house is worth" and
 * lists on it is the exact harm this wording avoids.
 */
function marketLine(lead) {
    if (!(0, index_js_2.isMlsFeedConfigured)())
        return null;
    try {
        return (0, listingMatch_js_1.marketSentence)((0, listingMatch_js_1.marketForLead)(lead));
    }
    catch (err) {
        /* A quarterly touch must never fail to send because a lookup broke. */
        console.error("[PastClientQuarterly] market lookup failed:", err);
        return null;
    }
}
const QUARTERLY_CONTENT = {
    1: {
        subject: (n) => `Happy home anniversary, ${n}!`,
        body: (n) => `Hi ${n},\n\nJust thinking of you as another year goes by in your home! Hope everything's going great. As always, here if you ever need anything — even just a contractor recommendation.\n\nMarco`,
    },
    2: {
        /* Was a market update containing no market. Now it carries live inventory
           when we know their area, and falls back to the original wording when we
           do not, rather than promising an update twice. */
        subject: () => `Quick market update for your area`,
        body: (n, lead) => {
            const line = marketLine(lead);
            if (!line) {
                return `Hi ${n},\n\nWanted to share a quick update on how home values have been trending in your neighborhood — always good info to have, even if you're not planning to move anytime soon.\n\nMarco`;
            }
            return `Hi ${n},\n\nQuick snapshot of your area: ${line} Those are asking prices, not sale prices — if you ever want to know what your own home would actually fetch, I'll pull the solds and put real numbers to it.\n\nAlways good info to have, even if you're not planning to move anytime soon.\n\nMarco`;
        },
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
/** Exported so the copy can be exercised against the listings mirror directly. */
exports.__testQuarterlyContent = QUARTERLY_CONTENT;
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
        const body = content.body(firstName, lead);
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
