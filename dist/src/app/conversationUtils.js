"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectAdCampaign = detectAdCampaign;
exports.normalizeUserMessageText = normalizeUserMessageText;
exports.normalizeForMarcoDuplicateCompare = normalizeForMarcoDuplicateCompare;
exports.messagesAreSubstantiallyDuplicate = messagesAreSubstantiallyDuplicate;
exports.getRecentAssistantTexts = getRecentAssistantTexts;
exports.getLastUserMessageText = getLastUserMessageText;
exports.getLastAssistantMessageText = getLastAssistantMessageText;
exports.lastTwoAssistantMessagesAreDuplicate = lastTwoAssistantMessagesAreDuplicate;
exports.latestAssistantEchoesEarlierInThread = latestAssistantEchoesEarlierInThread;
exports.threadContainsAgentQuestion = threadContainsAgentQuestion;
exports.threadContainsFirstTimeBuyingQuestion = threadContainsFirstTimeBuyingQuestion;
exports.leadThreadSignalsExperiencedBuyer = leadThreadSignalsExperiencedBuyer;
exports.messageAsksPropertyPriceOrCost = messageAsksPropertyPriceOrCost;
exports.signalsWantsInfoInDmOnly = signalsWantsInfoInDmOnly;
exports.signalsWantsBreakdownImmediately = signalsWantsBreakdownImmediately;
exports.signalsEmailDeliveryRequest = signalsEmailDeliveryRequest;
exports.messageAsksBuilderIdentity = messageAsksBuilderIdentity;
exports.leadTextSignalsNoAgent = leadTextSignalsNoAgent;
exports.isDuplicateMarcoReply = isDuplicateMarcoReply;
exports.candidateMatchesRecentMarco = candidateMatchesRecentMarco;
exports.isLastUserMessageRepeated = isLastUserMessageRepeated;
exports.messageAsksListingLocation = messageAsksListingLocation;
exports.signalsLookingOutsideSanAntonio = signalsLookingOutsideSanAntonio;
exports.isShortDuplicateUserPair = isShortDuplicateUserPair;
/**
 * Map first inbound message phrases to internal ad campaign ids (Instagram ad attribution).
 */
function detectAdCampaign(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return null;
    if (t.includes("low intrest") ||
        t.includes("low interest") ||
        t.includes("how fast can i close") ||
        t.includes("time i can tour")) {
        return "low_interest_ad";
    }
    if (t.includes("rent from this property") || t.includes("available for a tour")) {
        return "canyon_lake_ad";
    }
    return null;
}
/** Normalize for comparing lead messages (repeat taps, etc.). */
function normalizeUserMessageText(text) {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
}
/** Strip punctuation variance and unicode noise for Marco duplicate checks. */
function normalizeForMarcoDuplicateCompare(text) {
    let s = text
        .trim()
        .toLowerCase()
        .normalize("NFKC")
        .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
        .replace(/\s+/g, " ");
    s = s.replace(/[^\p{L}\p{N}\s]/gu, " ");
    return s.replace(/\s+/g, " ").trim();
}
function diceBigramSimilarity(a, b) {
    const t = (x) => normalizeForMarcoDuplicateCompare(x).replace(/\s/g, "");
    const A = t(a);
    const B = t(b);
    if (A.length < 2 || B.length < 2)
        return 0;
    const bigramCounts = (s) => {
        const m = new Map();
        for (let i = 0; i < s.length - 1; i++) {
            const g = s.slice(i, i + 2);
            m.set(g, (m.get(g) ?? 0) + 1);
        }
        return m;
    };
    const mA = bigramCounts(A);
    const mB = bigramCounts(B);
    let inter = 0;
    for (const [g, c] of mA)
        inter += Math.min(c, mB.get(g) ?? 0);
    return (2 * inter) / (A.length - 1 + (B.length - 1));
}
function wordJaccard(a, b) {
    const words = (s) => {
        const set = new Set();
        for (const w of normalizeForMarcoDuplicateCompare(s).split(/\s+/)) {
            if (w.length > 2)
                set.add(w);
        }
        return set;
    };
    const A = words(a);
    const B = words(b);
    if (A.size === 0 || B.size === 0)
        return 0;
    let inter = 0;
    for (const w of A)
        if (B.has(w))
            inter++;
    return inter / (A.size + B.size - inter);
}
/**
 * True if two Marco-sized replies are the same idea (fuzzy), not only exact match.
 */
function messagesAreSubstantiallyDuplicate(a, b) {
    if (!a?.trim() || !b?.trim())
        return false;
    const c = normalizeForMarcoDuplicateCompare(a);
    const l = normalizeForMarcoDuplicateCompare(b);
    if (!c || !l)
        return false;
    if (c === l)
        return true;
    const minLen = Math.min(c.length, l.length);
    const maxLen = Math.max(c.length, l.length);
    if (minLen >= 24) {
        const prefix = Math.min(72, minLen);
        if (c.slice(0, prefix) === l.slice(0, prefix))
            return true;
    }
    if (minLen >= 30 && maxLen > 0 && minLen / maxLen >= 0.92) {
        if (c.includes(l.slice(0, Math.min(40, l.length))) || l.includes(c.slice(0, Math.min(40, c.length)))) {
            return true;
        }
    }
    const wcA = c.split(/\s+/).filter((w) => w.length > 2).length;
    const wcB = l.split(/\s+/).filter((w) => w.length > 2).length;
    if (wcA >= 6 && wcB >= 6) {
        const j = wordJaccard(a, b);
        if (j >= 0.68)
            return true;
    }
    if (minLen >= 40) {
        const d = diceBigramSimilarity(a, b);
        if (d >= 0.78)
            return true;
    }
    return false;
}
/** Last N assistant lines, newest first. */
function getRecentAssistantTexts(conversation, n) {
    const out = [];
    for (let i = conversation.messages.length - 1; i >= 0 && out.length < n; i--) {
        const m = conversation.messages[i];
        if (m.role === "assistant" && m.text?.trim())
            out.push(m.text.trim());
    }
    return out;
}
/** Last user line in the thread (most recent Lead message). */
function getLastUserMessageText(conversation) {
    const reversed = [...conversation.messages].reverse();
    const m = reversed.find((x) => x.role === "user");
    return m?.text?.trim() ?? "";
}
/** Last Marco outbound before the reply we are about to generate (most recent assistant message). */
function getLastAssistantMessageText(conversation) {
    const reversed = [...conversation.messages].reverse();
    const m = reversed.find((x) => x.role === "assistant");
    return m?.text?.trim() ? m.text.trim() : null;
}
/**
 * True if Marco's last two outbound messages are the same or nearly the same (stuck loop).
 */
function lastTwoAssistantMessagesAreDuplicate(conversation) {
    const assistant = [];
    for (const m of conversation.messages) {
        if (m.role === "assistant" && m.text?.trim())
            assistant.push(m.text.trim());
    }
    if (assistant.length < 2)
        return false;
    const last = assistant[assistant.length - 1];
    const prev = assistant[assistant.length - 2];
    return messagesAreSubstantiallyDuplicate(last, prev);
}
/**
 * True if the most recent Marco outbound substantially matches ANY earlier Marco line (catches A→B→A loops).
 */
function latestAssistantEchoesEarlierInThread(conversation) {
    const assistant = [];
    for (const m of conversation.messages) {
        if (m.role === "assistant" && m.text?.trim())
            assistant.push(m.text.trim());
    }
    if (assistant.length < 2)
        return false;
    const last = assistant[assistant.length - 1];
    for (let i = 0; i < assistant.length - 1; i++) {
        if (messagesAreSubstantiallyDuplicate(last, assistant[i]))
            return true;
    }
    return false;
}
/** Thread already contains Marco's agent question (used for deterministic funnel escape). */
function threadContainsAgentQuestion(conversation) {
    return conversation.messages.some((m) => m.role === "assistant" && /\bworking with an agent\b/i.test(m.text));
}
/**
 * Any Marco line already asked the TikTok-style first-time-through-the-buying-process question
 * (manual DM or AI). Used to block repeating that opener in later turns.
 */
function threadContainsFirstTimeBuyingQuestion(conversation) {
    return conversation.messages.some((m) => {
        if (m.role !== "assistant" || !m.text?.trim())
            return false;
        const t = m.text;
        if (!/\bfirst\s*time\b/i.test(t) && !/\bfirst-time\b/i.test(t))
            return false;
        if (!/\b(buying|buy)\b/i.test(t))
            return false;
        return /\bprocess\b/i.test(t) || /\bgoing\s+through\b/i.test(t);
    });
}
/** Lead already indicated they are not a first-time buyer (thread-wide). */
function leadThreadSignalsExperiencedBuyer(conversation) {
    for (const m of conversation.messages) {
        if (m.role !== "user" || !m.text?.trim())
            continue;
        const t = m.text;
        if (/\bnot\s+my\s+first\b/i.test(t))
            return true;
        if (/\b(we|i)('?ve?| have)\s+(both\s+)?(bought|owned|purchased)\b/i.test(t))
            return true;
        if (/\bbought\s+(two|2|three|3|several|a few|multiple)\s+(homes?|houses?|properties)\b/i.test(t)) {
            return true;
        }
        if (/\bsecond\s+(home|house)\b/i.test(t))
            return true;
        if (/^\s*no\b/i.test(t) && /\b(own|owned|bought|house|home|properties)\b/i.test(t))
            return true;
        if (/\b(we|i)\s+also\s+own\b/i.test(t))
            return true;
        if (/\bcurrently\s+own\b/i.test(t))
            return true;
    }
    return false;
}
/** Lead is asking price / cost for the listing (TikTok: never answer in DM). */
function messageAsksPropertyPriceOrCost(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    const pointsAtListing = /\b(it|this|that|the (house|home|place|property|listing|one)|video|that home|this home)\b/.test(t);
    if (/\bhow much\b/.test(t) &&
        !/\bhow much (can|do) (you|i) (afford|need)\b/.test(t) &&
        !/\bhow much (room|space|time|land|acre)\b/.test(t)) {
        return true;
    }
    if (/\bwhat'?s?\s+the\s+(price|cost)\b/.test(t))
        return true;
    if (/\bhow much is (it|this|that|the (house|home|place))\b/.test(t))
        return true;
    if (/\bis it (expensive|cheap|affordable)\b/.test(t))
        return true;
    if (pointsAtListing && /\b(price|cost|pricing)\b/.test(t) && /\b(what|how much|is)\b/.test(t))
        return true;
    return false;
}
/** Lead wants details or the packet kept in app DM only, not SMS (resistance to giving a number). */
function signalsWantsInfoInDmOnly(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/\byou can send (it|them|that|everything|the info|details) here\b/.test(t))
        return true;
    if (/\bsend (it|them|that|everything) here\b/.test(t))
        return true;
    if (/\bkeep (it )?in (the )?(dm|chat)\b/.test(t))
        return true;
    if (/\b(all )?in (the )?dm\b/.test(t) && /\b(send|stay|keep|want)\b/.test(t))
        return true;
    if (/\bhere in (the )?(dm|chat)\b/.test(t))
        return true;
    if (/\bhere is fine\b/.test(t))
        return true;
    if (/\bthis is fine\b/.test(t))
        return true;
    if (/\bin here is fine\b/.test(t))
        return true;
    if (/\b(here|in the (dm|dms|chat)|in here|on here) is (fine|good|ok|okay|cool)\b/.test(t))
        return true;
    if (/\b(fine|good|ok|okay|cool|works) (here|in here|on here|in the (dm|dms|chat))\b/.test(t))
        return true;
    if (/\bjust (here|in the (dm|dms|chat)|in here)\b/.test(t))
        return true;
    if (/\b(send|put|drop) (it|that|everything|the (info|details|breakdown)) (here|in here|in the (dm|dms|chat))\b/.test(t)) {
        return true;
    }
    if (/\b(i want|want) (it|that|the (info|details|breakdown)) (here|in the (dm|dms|chat))\b/.test(t))
        return true;
    if (/\b(let'?s|we can) keep it (on here|here|in the (dm|dms|chat))\b/.test(t))
        return true;
    if (/\bprefer (to get|getting|it) (here|in the (dm|dms|chat))\b/.test(t))
        return true;
    if (/\b(in the app|on the app|in this chat|in this thread) is (fine|good|ok)\b/.test(t))
        return true;
    return false;
}
/** Lead is pushing urgency after phone capture (wants breakdown immediately). */
function signalsWantsBreakdownImmediately(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/\basap\b/.test(t))
        return true;
    if (/\bright now\b/.test(t))
        return true;
    if (/\b(need|want)\s+it\s+now\b/.test(t))
        return true;
    if (/\bsend\s+(it|that|everything|the breakdown|the packet)\s+now\b/.test(t))
        return true;
    if (/\bimmediately\b/.test(t))
        return true;
    if (/\burgent\b/.test(t))
        return true;
    if (/\b(today|this morning|this afternoon)\b/.test(t) && /\b(send|need|want|asap)\b/.test(t))
        return true;
    return false;
}
/**
 * Lead is asking to receive the packet / details by email instead of text/DM.
 * Narrow patterns so "my email is …" does not trigger.
 */
function signalsEmailDeliveryRequest(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/\bcan (you|we)\s+email\b/.test(t))
        return true;
    if (/\bcould you email\b/.test(t))
        return true;
    if (/\bare you able to email\b/.test(t))
        return true;
    if (/\bdo you mind emailing\b/.test(t))
        return true;
    if (/\bemail (me )?(the |this |it )?(info|information|details|packet|specs|materials|breakdown|list|sheet)\b/.test(t)) {
        return true;
    }
    if (/\bemail (it|this|that)\b/.test(t))
        return true;
    if (/\bsend (me )?(it|this|that|everything|the (info|information|details|packet))\s+(by|through|via|over|in)\s+email\b/.test(t)) {
        return true;
    }
    if (/\bsend (it|this|that)\s+to\s+(my\s+)?email\b/.test(t))
        return true;
    if (/\b(via|through|over|by)\s+email\b/.test(t) && /\b(send|get|receive|want|can you|could you)\b/.test(t)) {
        return true;
    }
    if (/\b(prefer|rather)\s+(it\s+)?(by|through)\s+email\b/.test(t))
        return true;
    return false;
}
/** Lead is asking for builder / developer identity (never disclose). */
function messageAsksBuilderIdentity(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/\bwho\s+(built|builds)\b/.test(t))
        return true;
    if (/\bwho\s+is\s+the\s+(builder|developer)\b/.test(t))
        return true;
    if (/\bwhat('?s| is)\s+the\s+builder\b/.test(t))
        return true;
    if (/\bwhich\s+builder\b/.test(t))
        return true;
    if (/\b(builder|developer)\s+(name|is|for this|on this)\b/.test(t))
        return true;
    if (/\bwho'?s\s+the\s+builder\b/.test(t))
        return true;
    return false;
}
/** Lead text signals they are not represented / no agent (incl. "not working with anyone"). */
function leadTextSignalsNoAgent(text) {
    const t = text.toLowerCase();
    if (/\bno agent\b|\bnot an agent\b/.test(t))
        return true;
    if (/\bon my own\b|\bby myself\b/.test(t))
        return true;
    if (/\bnot\s+(currently\s+)?working\s+with\s+(anyone|anybody|an agent|a realtor|a broker)\b/.test(t)) {
        return true;
    }
    if (/\bdon'?t have an agent\b|\bwithout an agent\b/.test(t))
        return true;
    if (/\bnobody yet\b|\bno one yet\b/.test(t))
        return true;
    return false;
}
/**
 * True if candidate reply duplicates Marco's previous outbound (model stuck repeating).
 */
function isDuplicateMarcoReply(candidate, lastAssistant) {
    if (!lastAssistant?.trim() || !candidate.trim())
        return false;
    return messagesAreSubstantiallyDuplicate(candidate, lastAssistant);
}
/** True if candidate is substantially the same as any recent Marco outbound (anti-loop). */
function candidateMatchesRecentMarco(candidate, recentAssistantTexts) {
    if (!candidate.trim())
        return false;
    for (const prev of recentAssistantTexts) {
        if (messagesAreSubstantiallyDuplicate(candidate, prev))
            return true;
    }
    return false;
}
/**
 * True if the latest user message matches the immediately previous user message (normalized).
 */
function isLastUserMessageRepeated(conversation) {
    const userTexts = [];
    for (const m of conversation.messages) {
        if (m.role === "user") {
            userTexts.push(normalizeUserMessageText(m.text));
        }
    }
    if (userTexts.length < 2)
        return false;
    const last = userTexts[userTexts.length - 1];
    const prev = userTexts[userTexts.length - 2];
    if (!last || !prev)
        return false;
    if (last !== prev)
        return false;
    // Short duplicates like "yes"/"ok" twice — still let the funnel advance normally.
    if (last.length < 12)
        return false;
    return true;
}
/**
 * True if the lead is asking where *this* listing is (area, address, etc.).
 * Used so Marco only gives the approved hint (west of Stone Oak), not other regions.
 */
function messageAsksListingLocation(text) {
    const t = text.trim().toLowerCase();
    const pointsAtListing = /\b(it|this|that|the (house|home|place|property|listing))\b/.test(t) ||
        /\bwhere'?s it\b/.test(t) ||
        /\bwhere is it\b/.test(t);
    if (/\b(what'?s|what is) (the )?(address|location)\b/.test(t))
        return true;
    if (/\b(the )?address (for|of) (this|it|the|that)\b/.test(t))
        return true;
    if (/\bcross streets?\b/.test(t))
        return true;
    if (/\bwhere\b/.test(t) && pointsAtListing)
        return true;
    if (/\bhow far\b/.test(t) && pointsAtListing)
        return true;
    if (/\b(what|which) area\b/.test(t) && pointsAtListing)
        return true;
    if (/\bwhat neighborhood\b/.test(t) && pointsAtListing)
        return true;
    if (/\bwhat part of town\b/.test(t) && pointsAtListing)
        return true;
    if (/\bdo you know where\b/.test(t) && pointsAtListing)
        return true;
    if (/\blocated\b/.test(t) && pointsAtListing)
        return true;
    return false;
}
/**
 * Lead is shopping / searching for a home outside San Antonio (another Texas market or explicit "not SA").
 * Triggers Marco's Texas-wide service line ($600k+) without claiming SA-only coverage for that buyer.
 */
function signalsLookingOutsideSanAntonio(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    const explicitOutsideSa = /\b(outside|outside of|not in|not around|away from|other than)\s+(san antonio|\bsa\b)\b/.test(t) ||
        /\b(not|isn't|is not)\s+(really\s+)?(in\s+)?san antonio\b/.test(t) ||
        /\b(home|house|buy|buying|looking).{0,60}\b(outside|not in).{0,30}\bsan antonio\b/.test(t);
    if (explicitOutsideSa)
        return true;
    // Major Texas metros / markets outside SA proper (not exhaustive; catches common DMs)
    const txMarket = /\b(austin|dallas|houston|fort worth|ft\.?\s*worth|el paso|corpus christi|plano|frisco|mckinney|arlington|laredo|lubbock|amarillo|waco|midland|odessa|tyler|new braunfels|round rock|katy|spring tx|pearland|sugar land|college station|killeen|beaumont|abilene|wichita falls|brownsville|pasadena tx|mesquite|denton|carrollton|lewisville|allen|richardson|conroe|georgetown tx|cedar park|san marcos tx)\b/i.test(t);
    const housingIntent = /\b(looking|search|buy|buying|home|house|move|relocat|market|area|city|live in|moving to)\b/i.test(t);
    const sanAntonioPrimary = /\b(in|around|near)\s+san antonio\b/.test(t) ||
        /\bsan antonio\b.{0,40}\b(looking|buy|home|house)\b/.test(t) ||
        /\b(sa|san antonio)\s+(area|market|homes)\b/.test(t);
    if (txMarket && housingIntent && !sanAntonioPrimary)
        return true;
    return false;
}
/** Same short line twice (e.g. double-tap "yes") — do not treat as stuck/repeat for funnel logic. */
function isShortDuplicateUserPair(conversation) {
    const userTexts = [];
    for (const m of conversation.messages) {
        if (m.role === "user") {
            userTexts.push(normalizeUserMessageText(m.text));
        }
    }
    if (userTexts.length < 2)
        return false;
    const last = userTexts[userTexts.length - 1];
    const prev = userTexts[userTexts.length - 2];
    return last === prev && last.length < 12;
}
