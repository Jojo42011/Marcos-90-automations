"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.process = process;
const state_js_1 = require("../../core/state.js");
const conversationUtils_js_1 = require("../../app/conversationUtils.js");
const index_js_1 = require("../../integrations/llm/index.js");
function saysHasAgent(text) {
    const t = text.toLowerCase();
    if (!/\bagent\b/.test(t))
        return false;
    return /\b(i am|i'm|yes|yeah|yep|already|currently|working with|have)\b/.test(t);
}
function openToAdvisor(text) {
    const t = text.toLowerCase();
    return /\b(open|maybe|i guess|sure|okay|ok|possibly|interview)\b/.test(t);
}
function getLastUserMessage(conversation) {
    const reversed = [...conversation.messages].reverse();
    return reversed.find((m) => m.role === "user") ?? null;
}
/**
 * After this turn's outbound, where the funnel should sit before the next inbound.
 * Repeat turns do not advance. Agent + not open stays in OpeningOfferedDetails for exclusivity ask.
 */
function nextOpeningState(lead, lastUserText, repeat, conversation) {
    if (lead.state === state_js_1.FunnelStage.New) {
        return state_js_1.FunnelStage.OpeningAskedFirstTime;
    }
    if (lead.state === state_js_1.FunnelStage.OpeningAskedFirstTime) {
        if (repeat)
            return state_js_1.FunnelStage.OpeningAskedFirstTime;
        return state_js_1.FunnelStage.OpeningOfferedDetails;
    }
    if (lead.state === state_js_1.FunnelStage.OpeningOfferedDetails) {
        /** Deterministic escape: agent Q already in thread + lead said no agent — always advance (never freeze on repeat). */
        if ((0, conversationUtils_js_1.threadContainsAgentQuestion)(conversation) && (0, conversationUtils_js_1.leadTextSignalsNoAgent)(lastUserText)) {
            return state_js_1.FunnelStage.PhoneRequested;
        }
        if (repeat)
            return state_js_1.FunnelStage.OpeningOfferedDetails;
        if (saysHasAgent(lastUserText) && !openToAdvisor(lastUserText)) {
            return state_js_1.FunnelStage.OpeningOfferedDetails;
        }
        return state_js_1.FunnelStage.PhoneRequested;
    }
    return lead.state;
}
async function process(lead, conversation, options) {
    const last = getLastUserMessage(conversation);
    if (!last) {
        return { lead, reply: null };
    }
    if (lead.state !== state_js_1.FunnelStage.New &&
        lead.state !== state_js_1.FunnelStage.OpeningAskedFirstTime &&
        lead.state !== state_js_1.FunnelStage.OpeningOfferedDetails) {
        return { lead, reply: null };
    }
    const openingStage = lead.state;
    const repeat = Boolean(options?.leadRepeatedForAdvancement && lead.state !== state_js_1.FunnelStage.New);
    const note = options?.coachingNote?.trim() ?? "";
    const preflight = {
        repeatedMessage: Boolean(options?.leadLineRepeatForModel),
        coachingNote: note,
    };
    const reply = await (0, index_js_1.generateMarcoOpeningReply)({
        lead,
        conversation,
        openingStage,
        preflight,
        inboundChannel: options?.inboundChannel ?? "dm",
        inboundPlatform: options?.inboundPlatform ?? lead.platform,
        log: options?.log,
    });
    const nextState = nextOpeningState(lead, last.text, repeat, conversation);
    return {
        lead: { ...lead, state: nextState },
        reply,
    };
}
