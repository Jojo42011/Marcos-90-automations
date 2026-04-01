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
const _03_tone_matched_dm_1 = require("../modules/03-tone-matched-dm");
const _01_comment_dm_monitor_1 = require("../modules/01-comment-dm-monitor");
const _08_brivity_auto_sync_1 = require("../modules/08-brivity-auto-sync");
const llm_1 = require("../integrations/llm");
const funnelDeterministic_js_1 = require("./funnelDeterministic.js");
const conversationUtils_js_1 = require("./conversationUtils.js");
const marcoLog_js_1 = require("./marcoLog.js");
/** First touch from Instagram comment automation: no comment text, no LLM — DM carries the real opener. */
const COMMENT_HANDSHAKE_REPLY = "Hey! Saw you commented on the home. What would you like to know?";
function normalizeThreadSnippet(s) {
    return s.replace(/\s+/g, " ").trim();
}
/**
 * TikTok: Marco sends the first DM manually in-app. ManyChat passes that text as `marco_previous_outbound`
 * on the lead’s first webhook so the DB thread matches reality and the model does not repeat the opener.
 */
async function maybeSeedTiktokManualOpener(lead, payload, ctx) {
    const raw = payload.marcoPreviousOutbound?.trim() ?? "";
    if (!raw)
        return lead;
    if (!payload.platform.toLowerCase().includes("tik"))
        return lead;
    const conv = await db.getConversation(lead.id);
    if (conv.messages.some((m) => m.role === "assistant")) {
        return lead;
    }
    await db.appendMessage(lead.id, "assistant", raw);
    (0, marcoLog_js_1.marcoLog)("tiktok_manual_opener_seeded", {
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        lead_id: lead.id,
        opener_preview: (0, marcoLog_js_1.previewText)(raw, 200),
        opener_norm_match: normalizeThreadSnippet(raw).slice(0, 80),
    });
    if (lead.state === state_js_1.FunnelStage.New) {
        const advanced = { ...lead, state: state_js_1.FunnelStage.OpeningAskedFirstTime };
        await db.updateLead(advanced);
        return advanced;
    }
    return lead;
}
async function run(payload, log) {
    const requestId = log?.requestId ?? (0, marcoLog_js_1.newMarcoRequestId)();
    const correlationId = log?.correlationId ?? (0, marcoLog_js_1.marcoCorrelationId)(payload.platform, payload.userId);
    const ctx = { requestId, correlationId };
    let lead = await db.getLead(payload.platform, payload.userId);
    const conversationBefore = lead ? await db.getConversation(lead.id) : { messages: [] };
    const isCommentHandshake = payload.commentOrDm === "comment" &&
        !payload.message.trim() &&
        conversationBefore.messages.length === 0;
    if (isCommentHandshake) {
        let createdLeadThisRequest = false;
        if (!lead) {
            lead = await db.createLead({
                platform: payload.platform,
                userId: payload.userId,
                username: payload.username,
                name: payload.displayName,
                phone: null,
                email: null,
                state: state_js_1.FunnelStage.New,
                source: payload.platform,
                propertyInquired: null,
                criteria: null,
                brivityId: null,
            });
            createdLeadThisRequest = true;
        }
        (0, marcoLog_js_1.marcoLog)("comment_handshake", {
            requestId,
            correlationId,
            lead_id: lead.id,
            created_lead_this_request: createdLeadThisRequest,
        });
        (0, marcoLog_js_1.marcoLog)("pipeline_end", {
            requestId,
            correlationId,
            lead_id: lead.id,
            outcome: "comment_handshake",
            reply_chars: COMMENT_HANDSHAKE_REPLY.length,
            reply_preview: (0, marcoLog_js_1.previewText)(COMMENT_HANDSHAKE_REPLY),
            funnel_state_final: lead.state,
            phone_captured_this_turn: false,
            email_captured_this_turn: false,
        });
        return { lead, reply: COMMENT_HANDSHAKE_REPLY };
    }
    if (!lead) {
        const interested = await (0, llm_1.classifyNewLeadBuyingIntent)(payload.message, {
            channel: payload.commentOrDm,
        });
        (0, marcoLog_js_1.marcoLog)("intent_gate", {
            requestId,
            correlationId,
            interested,
            message_preview: (0, marcoLog_js_1.previewText)(payload.message),
        });
        if (!interested) {
            (0, marcoLog_js_1.marcoLog)("pipeline_end", {
                requestId,
                correlationId,
                outcome: "no_reply_intent_rejected",
                reply_chars: 0,
            });
            return { lead: null, reply: null };
        }
        lead = await db.createLead({
            platform: payload.platform,
            userId: payload.userId,
            username: payload.username,
            name: payload.displayName,
            phone: null,
            email: null,
            state: state_js_1.FunnelStage.New,
            source: payload.platform,
            propertyInquired: null,
            criteria: null,
            brivityId: null,
        });
    }
    if (!payload.message.trim()) {
        (0, marcoLog_js_1.marcoLog)("pipeline_end", {
            requestId,
            correlationId,
            lead_id: lead.id,
            outcome: "empty_message_skipped",
            reply_chars: 0,
            funnel_state_final: lead.state,
            phone_captured_this_turn: false,
            email_captured_this_turn: false,
        });
        return { lead, reply: null };
    }
    lead = await maybeSeedTiktokManualOpener(lead, payload, ctx);
    await db.appendMessage(lead.id, "user", payload.message);
    const conversation = await db.getConversation(lead.id);
    const hadPhone = Boolean(lead.phone);
    const hadEmail = Boolean(lead.email);
    const userTurnCount = conversation.messages.filter((m) => m.role === "user").length;
    const assistantTurnCount = conversation.messages.filter((m) => m.role === "assistant").length;
    const preflightRaw = userTurnCount >= 2
        ? await (0, llm_1.preflightLeadTurnReview)({ conversation, leadState: lead.state }, ctx)
        : { repeatedMessage: false, coachingNote: "" };
    const shortDup = (0, conversationUtils_js_1.isShortDuplicateUserPair)(conversation);
    /** Only deterministic lead dup — freezes opening advance (never use Marco self-duplicate for this). */
    const leadRepeatedForAdvancement = (0, conversationUtils_js_1.isLastUserMessageRepeated)(conversation) && !shortDup;
    /** Haiku near-duplicate lead lines → coaching + model flag; does not freeze funnel by itself. */
    const leadLineRepeatForModel = leadRepeatedForAdvancement || (preflightRaw.repeatedMessage && !shortDup);
    const lastTwoAssistantDup = (0, conversationUtils_js_1.lastTwoAssistantMessagesAreDuplicate)(conversation);
    const assistantEchoesEarlier = (0, conversationUtils_js_1.latestAssistantEchoesEarlierInThread)(conversation);
    const marcoAssistantDup = lastTwoAssistantDup || assistantEchoesEarlier;
    (0, marcoLog_js_1.marcoLog)("pipeline_turn", {
        requestId,
        correlationId,
        lead_id: lead.id,
        platform: payload.platform,
        funnel_state_in: lead.state,
        user_turn_count: userTurnCount,
        assistant_turn_count: assistantTurnCount,
        lead_repeated_for_advancement: leadRepeatedForAdvancement,
        lead_line_repeat_for_model: leadLineRepeatForModel,
        short_dup_user_pair: shortDup,
        preflight_haiku_lead_repeat: preflightRaw.repeatedMessage,
        marco_assistant_dup: marcoAssistantDup,
        last_two_assistant_dup: lastTwoAssistantDup,
        assistant_echoes_earlier_thread: assistantEchoesEarlier,
    });
    (0, marcoLog_js_1.marcoLogDebug)("preflight_coaching", {
        requestId,
        correlationId,
        coaching_note: preflightRaw.coachingNote || "(empty)",
    });
    let coachingNote = preflightRaw.coachingNote.trim();
    if (leadLineRepeatForModel && !coachingNote) {
        coachingNote =
            "The lead may have repeated the same message; acknowledge briefly, stay on the current funnel step, and do not restart from the beginning. Do not repeat or closely mirror Marco's earlier outbound. On phone resistance, respond to their exact last message in one or two short sentences, never recycle prior resistance wording, re-ask for a number in a fresh way. Keep it casual like a real text. If the latest lead tone is resistant or negative, avoid upbeat affirmations and match their sentiment. Keep moving naturally through Marco's flow: value first, then agent context, then number ask.";
    }
    if (marcoAssistantDup) {
        coachingNote = [
            coachingNote,
            "CRITICAL_STUCK_LOOP: Marco's last two outbounds repeated the same or nearly the same content. The lead has sent new messages since. Do NOT send that line again. Do NOT re-ask the agent question if the lead already answered it in the thread (including not working with anyone, no agent, on my own). Acknowledge their latest message directly, then advance (phone number ask, VA loan, tour timing). Use completely new wording.",
        ]
            .filter(Boolean)
            .join(" ");
    }
    const latestLeadText = (0, conversationUtils_js_1.getLastUserMessageText)(conversation);
    if ((0, conversationUtils_js_1.messageAsksBuilderIdentity)(latestLeadText)) {
        coachingNote = [
            coachingNote,
            "BUILDER_GUARD: Lead asked who the builder is. NEVER name or hint the builder or developer. Deflect briefly; steer to a good number for the full breakdown (or west of Stone Oak only if they asked location).",
        ]
            .filter(Boolean)
            .join(" ");
    }
    if ((0, conversationUtils_js_1.threadContainsFirstTimeBuyingQuestion)(conversation) || (0, conversationUtils_js_1.leadThreadSignalsExperiencedBuyer)(conversation)) {
        coachingNote = [
            coachingNote,
            "FIRST_TIME_TOPIC_CLOSED: Do NOT ask again about first time going through the buying process or any paraphrase. Marco or the lead already covered it. Reply only to what they said last and move forward.",
        ]
            .filter(Boolean)
            .join(" ");
    }
    const preflight = {
        repeatedMessage: leadLineRepeatForModel,
        coachingNote: coachingNote.trim(),
    };
    (0, marcoLog_js_1.marcoLogDebug)("merged_coaching_for_model", {
        requestId,
        correlationId,
        coaching_chars: preflight.coachingNote.length,
        coaching_full: preflight.coachingNote || "(empty)",
    });
    let reply = null;
    if (lead.state === state_js_1.FunnelStage.New ||
        lead.state === state_js_1.FunnelStage.OpeningAskedFirstTime ||
        lead.state === state_js_1.FunnelStage.OpeningOfferedDetails) {
        const openingStageBefore = lead.state;
        lead = (await (0, _01_comment_dm_monitor_1.process)(lead, conversation)).lead;
        const tOpen = Date.now();
        const result = await (0, _03_tone_matched_dm_1.process)(lead, conversation, {
            leadRepeatedForAdvancement,
            leadLineRepeatForModel,
            coachingNote: preflight.coachingNote,
            inboundChannel: payload.commentOrDm,
            inboundPlatform: payload.platform,
            log: ctx,
        });
        lead = result.lead;
        const rawOpeningReply = result.reply;
        reply = (0, llm_1.sanitizeOpeningReplyAgainstRecentMarco)(rawOpeningReply, lead, conversation, openingStageBefore, ctx, payload.commentOrDm, payload.platform);
        (0, marcoLog_js_1.marcoLog)("opening_branch", {
            requestId,
            correlationId,
            opening_stage_before: openingStageBefore,
            funnel_state_out: lead.state,
            ms_opening_llm: Date.now() - tOpen,
            reply_source: !rawOpeningReply && !reply
                ? "none"
                : rawOpeningReply === reply
                    ? "model"
                    : "sanitized",
            raw_reply_preview: (0, marcoLog_js_1.previewText)(rawOpeningReply),
            final_reply_preview: (0, marcoLog_js_1.previewText)(reply),
        });
    }
    else if (lead.state === state_js_1.FunnelStage.PhoneRequested ||
        lead.state === state_js_1.FunnelStage.PropertySent ||
        lead.state === state_js_1.FunnelStage.CriteriaCollected ||
        lead.state === state_js_1.FunnelStage.EmailSent) {
        const stateBeforeDeterministic = lead.state;
        const { lead: advanced, meta } = (0, funnelDeterministic_js_1.advanceFunnelDeterministic)(lead, conversation);
        lead = advanced;
        const skipLlm = lead.state === state_js_1.FunnelStage.Closed && !meta.phoneJustCaptured && !meta.listSendPromised;
        (0, marcoLog_js_1.marcoLog)("post_opening_branch", {
            requestId,
            correlationId,
            funnel_state_before_deterministic: stateBeforeDeterministic,
            funnel_state_after_deterministic: lead.state,
            skip_llm: skipLlm,
            meta_phone_just_captured: Boolean(meta.phoneJustCaptured),
            meta_list_send_promised: Boolean(meta.listSendPromised),
        });
        if (!skipLlm) {
            const tPipe = Date.now();
            const rawPipelineReply = await (0, llm_1.generateMarcoPipelineReply)({
                lead,
                conversation,
                meta,
                preflight,
                inboundChannel: payload.commentOrDm,
                inboundPlatform: payload.platform,
                log: ctx,
            });
            reply = (0, llm_1.sanitizePipelineReplyAgainstRecentMarco)(rawPipelineReply, lead, conversation, meta, ctx);
            (0, marcoLog_js_1.marcoLog)("post_opening_reply", {
                requestId,
                correlationId,
                ms_pipeline_llm: Date.now() - tPipe,
                reply_source: !rawPipelineReply && !reply
                    ? "none"
                    : rawPipelineReply === reply
                        ? "model"
                        : "sanitized",
                raw_reply_preview: (0, marcoLog_js_1.previewText)(rawPipelineReply),
                final_reply_preview: (0, marcoLog_js_1.previewText)(reply),
            });
        }
        else {
            (0, marcoLog_js_1.marcoLog)("post_opening_skip_llm", {
                requestId,
                correlationId,
                funnel_state: lead.state,
                reason: "closed_without_phone_capture_or_list_promise",
            });
        }
    }
    else {
        (0, marcoLog_js_1.marcoLog)("pipeline_unhandled_funnel_stage", {
            requestId,
            correlationId,
            funnel_state: lead.state,
        });
    }
    if (reply) {
        await db.appendMessage(lead.id, "assistant", reply);
    }
    const hasNewPhone = !hadPhone && Boolean(lead.phone);
    const hasNewEmail = !hadEmail && Boolean(lead.email);
    if (hasNewPhone || hasNewEmail) {
        lead = (await (0, _08_brivity_auto_sync_1.process)(lead, conversation)).lead;
    }
    await db.updateLead(lead);
    (0, marcoLog_js_1.marcoLog)("pipeline_end", {
        requestId,
        correlationId,
        lead_id: lead.id,
        outcome: reply ? "replied" : "no_reply",
        reply_chars: reply?.length ?? 0,
        reply_preview: (0, marcoLog_js_1.previewText)(reply),
        funnel_state_final: lead.state,
        phone_captured_this_turn: hasNewPhone,
        email_captured_this_turn: hasNewEmail,
    });
    return { lead, reply };
}
