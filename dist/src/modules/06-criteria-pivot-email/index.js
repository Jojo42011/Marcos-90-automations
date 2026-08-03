"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.process = process;
const state_js_1 = require("../../core/state.js");
const areaExtract_js_1 = require("../../core/areaExtract.js");
function getLastUserMessage(conversation) {
    const reversed = [...conversation.messages].reverse();
    return reversed.find((m) => m.role === "user") ?? null;
}
function extractEmail(text) {
    const match = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    return match ? match[0] : null;
}
function extractBeds(text) {
    const m = text.match(/(\d+(?:\.\d+)?)\s*(bed|beds|bd)\b/i);
    if (!m)
        return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
}
function extractBaths(text) {
    const m = text.match(/(\d+(?:\.\d+)?)\s*(bath|baths|ba)\b/i);
    if (!m)
        return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
}
function extractPriceCap(text) {
    // Very small heuristic: find a big number and interpret as dollars.
    const m = text.match(/\b\$?\s?(\d{3,}(?:,\d{3})*)\s?\b/);
    if (!m)
        return null;
    const raw = m[1].replace(/,/g, "");
    const n = Number(raw);
    if (!Number.isFinite(n))
        return null;
    if (n < 50000)
        return null;
    return n;
}
async function process(lead, conversation) {
    const last = getLastUserMessage(conversation);
    if (!last)
        return { lead, reply: null };
    const email = lead.email ?? extractEmail(last.text);
    const beds = lead.criteria?.beds ?? extractBeds(last.text);
    const baths = lead.criteria?.baths ?? extractBaths(last.text);
    /* Normalise what is already stored before trusting it — see the note in
       funnelDeterministic; rows written by the old rule hold sentence fragments. */
    const area = (0, areaExtract_js_1.normalizeArea)(lead.criteria?.area) ?? (0, areaExtract_js_1.extractArea)(last.text);
    const priceCap = lead.criteria?.priceCap ?? extractPriceCap(last.text);
    const criteria = lead.criteria
        ? {
            ...lead.criteria,
            beds: beds ?? lead.criteria.beds,
            baths: baths ?? lead.criteria.baths,
            area: area ?? lead.criteria.area,
            priceCap: priceCap ?? lead.criteria.priceCap,
        }
        : { priceCap: priceCap ?? null, beds: beds ?? null, baths: baths ?? null, area: area ?? null };
    const hasCriteria = Boolean(criteria.area || criteria.priceCap || criteria.beds || criteria.baths);
    const isAffirmative = /\b(yes|that.?s the (one|house)|correct|exactly|perfect|sounds good)\b/i.test(last.text);
    const isNegative = /\b(no|not|different|other|outside|wrong|not really|looking elsewhere)\b/i.test(last.text);
    let reply;
    // If they are saying it's the right fit, we mostly want the email next.
    if (isAffirmative) {
        if (!email) {
            reply = "For sure, what’s the best email I can send everything over to?";
            return { lead: { ...lead, email: null, criteria, state: state_js_1.FunnelStage.CriteriaCollected }, reply };
        }
        reply =
            "Of course, I’ll send the details over to that email next. Was there anything specific about beds/baths you’re looking for?";
        return { lead: { ...lead, email, criteria, state: state_js_1.FunnelStage.EmailSent }, reply };
    }
    // If they say it's not the right fit (or they ask for something else), use pivot + collect criteria + email.
    if (isNegative || !isAffirmative) {
        if (!email || !hasCriteria) {
            reply =
                "No worries — would it help if I sent over similar options in your price range? " +
                    "What price cap are you targeting, and what’s the best email to send them to?";
        }
        else {
            reply =
                "Makes sense — I’ll send similar options based on that. What’s the best email to send everything to?";
        }
        return {
            lead: {
                ...lead,
                email: email ?? lead.email,
                criteria,
                state: email ? state_js_1.FunnelStage.EmailSent : state_js_1.FunnelStage.CriteriaCollected,
            },
            reply,
        };
    }
    return { lead, reply: null };
}
