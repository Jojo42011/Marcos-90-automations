"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PHONE_JUST_CAPTURED_REPLY = void 0;
exports.extractPhone = extractPhone;
exports.extractPhoneFromConversation = extractPhoneFromConversation;
exports.advanceFunnelDeterministic = advanceFunnelDeterministic;
const state_js_1 = require("../core/state.js");
const prompts_js_1 = require("../../config/prompts.js");
function getLastUserMessage(conversation) {
    const reversed = [...conversation.messages].reverse();
    return reversed.find((m) => m.role === "user") ?? null;
}
/** Shown when we detect a number in-thread the same turn we leave the opening funnel (or override a bad sanitizer). */
exports.PHONE_JUST_CAPTURED_REPLY = prompts_js_1.MARCO_PHONE_CAPTURED_REPLY;
const MAX_USER_MESSAGES_PHONE_SCAN = 12;
/**
 * US-ish mobile: strip non-digits; accept 10 digits, or 11 starting with country code 1.
 * If one bubble contains extra digits (zip + phone, two numbers), prefer the last 10-digit run.
 */
function extractPhone(text) {
    const digits = text.replace(/\D/g, "");
    if (digits.length === 10)
        return digits;
    if (digits.length === 11 && digits.startsWith("1"))
        return digits.slice(1);
    if (digits.length > 11) {
        const tail = digits.slice(-10);
        if (tail.length === 10)
            return tail;
    }
    return null;
}
/**
 * Newest user messages first — catches numbers sent one bubble before "ok"/"thanks".
 */
function extractPhoneFromConversation(conversation, maxUserMessages = MAX_USER_MESSAGES_PHONE_SCAN) {
    let seen = 0;
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
        const m = conversation.messages[i];
        if (m.role !== "user")
            continue;
        seen++;
        const p = extractPhone(m.text);
        if (p)
            return p;
        if (seen >= maxUserMessages)
            break;
    }
    return null;
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
function extractArea(text) {
    const m = text.match(/\b(in|area)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,3})\b/i) ??
        text.match(/\b([A-Za-z]+(?:\s+[A-Za-z]+){0,3})\s+(area)\b/i);
    if (!m)
        return null;
    return (m[2] ?? m[1] ?? "").trim() || null;
}
function extractPriceCap(text) {
    const m = text.match(/\b\$?\s?(\d{3,}(?:,\d{3})*)\s?\b/);
    if (!m)
        return null;
    const raw = m[1].replace(/,/g, "");
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 50000)
        return null;
    return n;
}
/** Module 06 state + criteria/email extraction only (no reply strings). */
function applyModule06Deterministic(lead, lastText) {
    const email = lead.email ?? extractEmail(lastText);
    const beds = lead.criteria?.beds ?? extractBeds(lastText);
    const baths = lead.criteria?.baths ?? extractBaths(lastText);
    const area = lead.criteria?.area ?? extractArea(lastText);
    const priceCap = lead.criteria?.priceCap ?? extractPriceCap(lastText);
    const criteria = lead.criteria
        ? {
            ...lead.criteria,
            beds: beds ?? lead.criteria.beds,
            baths: baths ?? lead.criteria.baths,
            area: area ?? lead.criteria.area,
            priceCap: priceCap ?? lead.criteria.priceCap,
        }
        : {
            priceCap: priceCap ?? null,
            beds: beds ?? null,
            baths: baths ?? null,
            area: area ?? null,
        };
    const isAffirmative = /\b(yes|that.?s the (one|house)|correct|exactly|perfect|sounds good)\b/i.test(lastText);
    if (isAffirmative) {
        if (!email) {
            return { ...lead, email: null, criteria, state: state_js_1.FunnelStage.CriteriaCollected };
        }
        return { ...lead, email, criteria, state: state_js_1.FunnelStage.EmailSent };
    }
    return {
        ...lead,
        email: email ?? lead.email,
        criteria,
        state: email ? state_js_1.FunnelStage.EmailSent : state_js_1.FunnelStage.CriteriaCollected,
    };
}
function chainEmailSentToClosed(lead, meta) {
    if (lead.state === state_js_1.FunnelStage.EmailSent && lead.email) {
        meta.listSendPromised = true;
        return { ...lead, state: state_js_1.FunnelStage.Closed };
    }
    return lead;
}
/**
 * Apply regex extractions and stage transitions for one inbound turn (after user message is appended).
 */
function advanceFunnelDeterministic(lead, conversation) {
    const meta = {};
    let l = lead;
    if (l.state === state_js_1.FunnelStage.PhoneRequested) {
        const phone = l.phone ?? extractPhoneFromConversation(conversation);
        if (phone) {
            const justCaptured = !l.phone;
            l = { ...l, phone, state: state_js_1.FunnelStage.PropertySent };
            if (justCaptured)
                meta.phoneJustCaptured = true;
        }
        return { lead: l, meta };
    }
    if (l.state === state_js_1.FunnelStage.PropertySent || l.state === state_js_1.FunnelStage.CriteriaCollected) {
        const last = getLastUserMessage(conversation);
        if (!last)
            return { lead: l, meta };
        l = applyModule06Deterministic(l, last.text);
        l = chainEmailSentToClosed(l, meta);
        return { lead: l, meta };
    }
    if (l.state === state_js_1.FunnelStage.EmailSent) {
        l = chainEmailSentToClosed(l, meta);
        return { lead: l, meta };
    }
    return { lead: l, meta };
}
