"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
/**
 * Run modules in order by lead state. Single entry for webhook-driven flow.
 */
const db = __importStar(require("../core/db.js"));
const state_js_1 = require("../core/state.js");
const index_js_1 = require("../modules/03-tone-matched-dm/index.js");
const index_js_2 = require("../modules/01-comment-dm-monitor/index.js");
const index_js_3 = require("../modules/08-brivity-auto-sync/index.js");
const index_js_4 = require("../integrations/llm/index.js");
const funnelDeterministic_js_1 = require("./funnelDeterministic.js");
const conversationUtils_js_1 = require("./conversationUtils.js");
async function run(payload) {
    let lead = await db.getLead(payload.platform, payload.userId);
    if (!lead) {
        // Ambiguous listing fragments ("Stone") fail the strict intent gate but are real
        // inquiries in production — let them through so module 03 can ask for a screenshot.
        const interested = (0, conversationUtils_js_1.isAmbiguousPropertyReference)(payload.message) ||
            (await (0, index_js_4.classifyNewLeadBuyingIntent)(payload.message));
        if (!interested) {
            return { lead: null, reply: null };
        }
        lead = await db.createLead({
            platform: payload.platform,
            userId: payload.userId,
            username: payload.username,
            name: null,
            phone: null,
            email: null,
            state: state_js_1.FunnelStage.New,
            source: payload.platform,
            propertyInquired: null,
            criteria: null,
            brivityId: null,
        });
    }
    await db.appendMessage(lead.id, "user", payload.message);
    const conversation = await db.getConversation(lead.id);
    const hadPhone = Boolean(lead.phone);
    const hadEmail = Boolean(lead.email);
    const userTurnCount = conversation.messages.filter((m) => m.role === "user").length;
    const preflightRaw = userTurnCount >= 2
        ? await (0, index_js_4.preflightLeadTurnReview)({ conversation, leadState: lead.state })
        : { repeatedMessage: false, coachingNote: "" };
    const deterministicRepeat = (0, conversationUtils_js_1.isLastUserMessageRepeated)(conversation);
    const shortDup = (0, conversationUtils_js_1.isShortDuplicateUserPair)(conversation);
    const treatAsRepeat = deterministicRepeat || (preflightRaw.repeatedMessage && !shortDup);
    let coachingNote = preflightRaw.coachingNote;
    if (treatAsRepeat && !coachingNote.trim()) {
        coachingNote =
            "The lead may have repeated the same message; acknowledge briefly, stay on the current funnel step, and do not restart from the beginning. Do not repeat or closely mirror Marco's earlier outbound. Keep it casual like a real text, especially on phone resistance. If the latest lead tone is resistant or negative, avoid upbeat affirmations and match their sentiment. Keep moving naturally through Marco's flow: value first, then agent context, then number ask.";
    }
    const preflight = {
        repeatedMessage: treatAsRepeat,
        coachingNote: treatAsRepeat ? coachingNote : "",
    };
    let reply = null;
    if (lead.state === state_js_1.FunnelStage.New ||
        lead.state === state_js_1.FunnelStage.ListingClarificationRequested ||
        lead.state === state_js_1.FunnelStage.OpeningAskedFirstTime ||
        lead.state === state_js_1.FunnelStage.OpeningOfferedDetails) {
        lead = (await (0, index_js_2.process)(lead, conversation)).lead;
        const result = await (0, index_js_1.process)(lead, conversation, {
            treatAsRepeat,
            coachingNote: preflight.coachingNote,
        });
        lead = result.lead;
        reply = result.reply;
    }
    else if (lead.state === state_js_1.FunnelStage.PhoneRequested ||
        lead.state === state_js_1.FunnelStage.PropertySent ||
        lead.state === state_js_1.FunnelStage.CriteriaCollected ||
        lead.state === state_js_1.FunnelStage.EmailSent) {
        const { lead: advanced, meta } = (0, funnelDeterministic_js_1.advanceFunnelDeterministic)(lead, conversation);
        lead = advanced;
        const skipLlm = lead.state === state_js_1.FunnelStage.Closed && !meta.phoneJustCaptured && !meta.listSendPromised;
        if (!skipLlm) {
            reply = await (0, index_js_4.generateMarcoPipelineReply)({ lead, conversation, meta, preflight });
        }
    }
    if (reply) {
        await db.appendMessage(lead.id, "assistant", reply);
    }
    const hasNewPhone = !hadPhone && Boolean(lead.phone);
    const hasNewEmail = !hadEmail && Boolean(lead.email);
    if (hasNewPhone || hasNewEmail) {
        lead = (await (0, index_js_3.process)(lead, conversation)).lead;
    }
    await db.updateLead(lead);
    return { lead, reply };
}
