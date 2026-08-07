"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.process = process;
const state_js_1 = require("../../core/state.js");
const conversationUtils_js_1 = require("../../app/conversationUtils.js");
const funnelDeterministic_js_1 = require("../../app/funnelDeterministic.js");
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
/** Phone in thread (e.g. IG contact card echo) — must advance even when ManyChat sends the same line twice. */
function capturablePhoneFromThread(conversation, lastUserText) {
    return (0, funnelDeterministic_js_1.extractPhone)(lastUserText) ?? (0, funnelDeterministic_js_1.extractPhoneFromConversation)(conversation) ?? null;
}
/**
 * After this turn's outbound, where the funnel should sit before the next inbound.
 * Repeat turns do not advance. Agent + not open stays in OpeningOfferedDetails for exclusivity ask.
 */
function nextOpeningState(lead, lastUserText, repeat, conversation) {
    if (capturablePhoneFromThread(conversation, lastUserText)) {
        return state_js_1.FunnelStage.PhoneRequested;
    }
    /* ── COLLAPSED OPENER (Aug 2026) ────────────────────────────────────────
       The opener used to be a three-beat ladder: ask the first-time-buyer
       question, wait; offer the breakdown, wait; ask for the number, wait.
       Three round trips before a phone number ever landed.
  
       Kendrick's TikTok threads on Wesley's account (the screenshots this was
       modelled on) get there in ONE: value plus options plus the number ask in
       the first message. That matters because the observed gaps between DM
       turns are DAYS, not minutes, so every extra beat is a real chance to
       lose the lead entirely rather than a small delay.
  
       So the first outbound now carries the ask, and the funnel goes straight
       to PhoneRequested, where 04-phone-extraction takes over.
  
       Legacy stages still resolve: leads that were mid-ladder when this
       shipped advance rather than being stranded waiting for a beat that no
       longer exists. The one thing preserved from the old ladder is the
       has-an-agent hold, which is a real objection and not a pacing step. */
    if (lead.state === state_js_1.FunnelStage.New ||
        lead.state === state_js_1.FunnelStage.OpeningAskedFirstTime ||
        lead.state === state_js_1.FunnelStage.OpeningOfferedDetails) {
        /* Deterministic escape kept from the old ladder: agent question already
           asked and answered "no agent" always advances, never freezes. */
        if ((0, conversationUtils_js_1.threadContainsAgentQuestion)(conversation) && (0, conversationUtils_js_1.leadTextSignalsNoAgent)(lastUserText)) {
            return state_js_1.FunnelStage.PhoneRequested;
        }
        /* A lead who says they already have an agent is a genuine objection, so
           hold the opening phase and let the reply address it. Not a pacing
           beat, which is why it survives the collapse. */
        if (saysHasAgent(lastUserText) && !openToAdvisor(lastUserText)) {
            return state_js_1.FunnelStage.OpeningOfferedDetails;
        }
        /* A repeated message means the lead said nothing new; re-asking the
           number on a loop reads as nagging, so hold position. */
        if (repeat && lead.state !== state_js_1.FunnelStage.New) {
            return lead.state;
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
    const phoneDigits = lead.phone ?? capturablePhoneFromThread(conversation, last.text);
    if (phoneDigits) {
        const justCaptured = !lead.phone;
        return {
            lead: { ...lead, phone: phoneDigits, state: state_js_1.FunnelStage.PropertySent },
            reply: justCaptured ? funnelDeterministic_js_1.PHONE_JUST_CAPTURED_REPLY : null,
        };
    }
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
