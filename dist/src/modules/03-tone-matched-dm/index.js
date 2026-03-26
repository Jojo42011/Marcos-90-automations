"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.process = process;
/**
 * Module 03: Opening DM — three-step Marco framework before phone capture.
 * 1) Thanks + first-time buyer question → 2) Details + other options pitch → 3) Phone ask → PhoneRequested.
 */
const prompts_js_1 = require("../../../config/prompts.js");
const state_js_1 = require("../../core/state.js");
const index_js_1 = require("../../integrations/llm/index.js");
function seemsDifferentPricePoint(text) {
    const t = text.toLowerCase();
    return /\b(different|lower|cheaper|less|out of budget|too high|too much|not in my range|another range|price point)\b/.test(t);
}
function mentionsDifferentArea(text) {
    const t = text.toLowerCase();
    return /\b(different area|another area|different location|another location|elsewhere|other side of town)\b/.test(t);
}
function mentionsBedBathCriteria(text) {
    const t = text.toLowerCase();
    return /\b(bed|beds|bath|baths|bd|ba)\b/.test(t);
}
function hasPriceRangeDetail(text) {
    const t = text.toLowerCase();
    if (/\$?\s?\d{2,3}k\b/.test(t))
        return true;
    if (/\$?\s?\d{3,}(?:,\d{3})+\b/.test(t))
        return true;
    if (/\b(under|below|around|between|max|budget)\b/.test(t) && /\d/.test(t))
        return true;
    return false;
}
function hasAreaDetail(text) {
    const t = text.toLowerCase();
    return /\b(in|near|around)\s+[a-z]+/.test(t) || /\b(north|south|east|west|downtown|suburb)\b/.test(t);
}
function hasBedBathDetail(text) {
    const t = text.toLowerCase();
    return /\b\d+(\.\d+)?\s*(bed|beds|bd|bath|baths|ba)\b/.test(t);
}
function saysHasAgent(text) {
    const t = text.toLowerCase();
    if (!/\bagent\b/.test(t))
        return false;
    return /\b(i am|i'm|yes|yeah|yep|already|currently|working with|have)\b/.test(t);
}
function saysNoAgent(text) {
    const t = text.toLowerCase();
    if ((/\b(no|not|don't|do not)\b/.test(t) && /\bagent\b/.test(t)) || /\b(no agent)\b/.test(t)) {
        return true;
    }
    // Context-aware no-agent shorthand often sent right after "Are you working with an agent?"
    if (/^\s*(no|nope|nah|not really)\b/.test(t))
        return true;
    if (/\b(on my own|by myself|just browsing|just looking)\b/.test(t))
        return true;
    return false;
}
function openToAdvisor(text) {
    const t = text.toLowerCase();
    return /\b(open|maybe|i guess|sure|okay|ok|possibly|interview)\b/.test(t);
}
function getLastUserMessage(conversation) {
    const reversed = [...conversation.messages].reverse();
    return reversed.find((m) => m.role === "user") ?? null;
}
/** Greeting name for "Hey {x}": use lead.name, else a cleaned username, else "there". */
function greetingName(lead) {
    if (lead.name?.trim()) {
        return lead.name.trim();
    }
    const u = lead.username?.trim();
    if (!u)
        return "there";
    const first = u.split(/[._]/)[0] ?? u;
    if (!/^[a-zA-Z]+$/.test(first))
        return "there";
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}
async function process(lead, conversation, options) {
    const last = getLastUserMessage(conversation);
    if (!last) {
        return { lead, reply: null };
    }
    const repeat = Boolean(options?.treatAsRepeat && lead.state !== state_js_1.FunnelStage.New);
    const appendix = repeat && options?.coachingNote?.trim() ? options.coachingNote.trim() : undefined;
    if (lead.state === state_js_1.FunnelStage.New) {
        const who = greetingName(lead);
        const deterministic = who !== "there"
            ? `Hey ${who}, I appreciate you reaching out. This home has a strong layout and value for the area, and pricing usually falls in a competitive range depending on finishes. Did this home somewhat align with what you're looking for or something in a different price point?`
            : `Hey, I appreciate you reaching out. This home has a strong layout and value for the area, and pricing usually falls in a competitive range depending on finishes. Did this home somewhat align with what you're looking for or something in a different price point?`;
        const rewritten = await (0, index_js_1.rewriteReplyWithTone)(prompts_js_1.prompts.toneMatchedOpening, deterministic, conversation, appendix);
        const reply = rewritten ?? deterministic;
        return {
            lead: { ...lead, state: state_js_1.FunnelStage.OpeningAskedFirstTime },
            reply,
        };
    }
    if (lead.state === state_js_1.FunnelStage.OpeningAskedFirstTime) {
        const deterministic = repeat
            ? "No worries if that sent twice. Did this home somewhat align with what you're looking for or something in a different price point?"
            : seemsDifferentPricePoint(last.text) && !hasPriceRangeDetail(last.text)
                ? "Makes sense. What price range works better for you?"
                : mentionsDifferentArea(last.text) && !hasAreaDetail(last.text)
                    ? "Makes sense. What area of San Antonio are you looking in?"
                    : mentionsBedBathCriteria(last.text) && !hasBedBathDetail(last.text)
                        ? "Noted. How many beds and baths are you looking for?"
                        : seemsDifferentPricePoint(last.text) || mentionsDifferentArea(last.text) || mentionsBedBathCriteria(last.text)
                            ? "No worries at all, I know of some beautiful homes similar to what you inquired about in that range as well. Are you currently working with an agent?"
                            : "For sure, that helps. Are you currently working with an agent?";
        const rewritten = await (0, index_js_1.rewriteReplyWithTone)(prompts_js_1.prompts.toneMatchedOpening, deterministic, conversation, appendix);
        const reply = rewritten ?? deterministic;
        return {
            lead: {
                ...lead,
                state: repeat ? state_js_1.FunnelStage.OpeningAskedFirstTime : state_js_1.FunnelStage.OpeningOfferedDetails,
            },
            reply,
        };
    }
    if (lead.state === state_js_1.FunnelStage.OpeningOfferedDetails) {
        const deterministic = repeat
            ? "No worries if that sent twice. Are you currently working with an agent?"
            : saysHasAgent(last.text) && !openToAdvisor(last.text)
                ? "I understand, I don't want to step on anyone's toes. But are you exclusive with that agent or open to interviewing a qualified advisor that specializes in what you're looking for?"
                : saysNoAgent(last.text) || openToAdvisor(last.text)
                    ? "Makes sense. Would there be a good number I could send all this info over to?"
                    : "Noted. Would there be a good number I could send all this info over to?";
        const rewritten = await (0, index_js_1.rewriteReplyWithTone)(prompts_js_1.prompts.toneMatchedOpening, deterministic, conversation, appendix);
        const reply = rewritten ?? deterministic;
        return {
            lead: {
                ...lead,
                state: repeat || (saysHasAgent(last.text) && !openToAdvisor(last.text))
                    ? state_js_1.FunnelStage.OpeningOfferedDetails
                    : state_js_1.FunnelStage.PhoneRequested,
            },
            reply,
        };
    }
    return { lead, reply: null };
}
