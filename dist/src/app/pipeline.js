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
const prompts_js_1 = require("../../config/prompts.js");
const conversationUtils_js_1 = require("./conversationUtils.js");
const marcoLog_js_1 = require("./marcoLog.js");
/**
 * Out-of-state referral handling. `handled: false` continues the normal funnel.
 */
function resolveReferralFlow(lead, conversation, latestText, ctx) {
    const offeredInThread = (0, conversationUtils_js_1.threadContainsReferralOffer)(conversation);
    const status = lead.referralStatus ?? null;
    if (status === "referral_needed") {
        const areaNote = latestText.trim();
        const notes = lead.crmNotes?.trim()
            ? `${lead.crmNotes.trim()}\nReferral area: ${areaNote}`
            : `Referral area: ${areaNote}`;
        (0, marcoLog_js_1.marcoLog)("referral_area_captured", {
            requestId: ctx.requestId,
            correlationId: ctx.correlationId,
            lead_id: lead.id,
            area_preview: (0, marcoLog_js_1.previewText)(areaNote, 120),
        });
        return {
            handled: true,
            lead: { ...lead, crmNotes: notes },
            reply: "Got it, I'll get you connected with the right person out there.",
        };
    }
    if (status === "offered" || offeredInThread) {
        if ((0, conversationUtils_js_1.signalsReferralAcceptance)(latestText)) {
            (0, marcoLog_js_1.marcoLog)("referral_accepted", {
                requestId: ctx.requestId,
                correlationId: ctx.correlationId,
                lead_id: lead.id,
            });
            const tags = lead.tags?.includes("referral_needed")
                ? lead.tags
                : [...(lead.tags ?? []), "referral_needed"];
            return {
                handled: true,
                lead: {
                    ...lead,
                    referralStatus: "referral_needed",
                    tags,
                    crmPriority: "high",
                },
                reply: conversationUtils_js_1.REFERRAL_AREA_FOLLOW_UP,
            };
        }
        if ((0, conversationUtils_js_1.signalsReferralDeclineOrWantsSanAntonio)(latestText)) {
            (0, marcoLog_js_1.marcoLog)("referral_declined_resume_funnel", {
                requestId: ctx.requestId,
                correlationId: ctx.correlationId,
                lead_id: lead.id,
            });
            return {
                handled: false,
                lead: {
                    ...lead,
                    referralStatus: null,
                    state: state_js_1.FunnelStage.New,
                },
            };
        }
        return { handled: false, lead };
    }
    const oos = (0, conversationUtils_js_1.detectOutOfStateLead)(latestText);
    if (!oos.detected) {
        return { handled: false, lead };
    }
    (0, marcoLog_js_1.marcoLog)("out_of_state_detected", {
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        lead_id: lead.id,
        region_label: oos.regionLabel,
        message_preview: (0, marcoLog_js_1.previewText)(latestText),
    });
    return {
        handled: true,
        lead: { ...lead, referralStatus: "offered" },
        reply: (0, conversationUtils_js_1.buildOutOfStateReferralOffer)(oos.regionLabel),
    };
}
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
    const platformLower = payload.platform.toLowerCase();
    const allowManualOpenerSeed = platformLower.includes("tik") ||
        (platformLower.includes("insta") && payload.commentOrDm === "dm");
    if (!allowManualOpenerSeed)
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
                crmStatus: "not_contacted",
                crmStage: "new",
                crmPriority: "normal",
                crmIntent: "buyer",
                crmCallQueue: "none",
                crmNotes: null,
                adCampaign: null,
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
        const skipIntentGateTiktokManualOpener = Boolean(payload.marcoPreviousOutbound?.trim()) &&
            (payload.platform.toLowerCase().includes("tik") ||
                (payload.platform.toLowerCase().includes("insta") && payload.commentOrDm === "dm"));
        let interested;
        if (skipIntentGateTiktokManualOpener) {
            interested = true;
            (0, marcoLog_js_1.marcoLog)("intent_gate_skipped", {
                requestId,
                correlationId,
                reason: "tiktok_marco_previous_outbound",
                message_preview: (0, marcoLog_js_1.previewText)(payload.message),
            });
        }
        else if ((0, conversationUtils_js_1.isWaveOnlyMessage)(payload.message.trim())) {
            interested = true;
            (0, marcoLog_js_1.marcoLog)("intent_gate", {
                requestId,
                correlationId,
                interested: true,
                reason: "wave_only",
                message_preview: (0, marcoLog_js_1.previewText)(payload.message),
            });
        }
        else {
            interested = await (0, llm_1.classifyNewLeadBuyingIntent)(payload.message, {
                channel: payload.commentOrDm,
                platform: payload.platform,
            });
            (0, marcoLog_js_1.marcoLog)("intent_gate", {
                requestId,
                correlationId,
                interested,
                message_preview: (0, marcoLog_js_1.previewText)(payload.message),
            });
        }
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
            adCampaign: (0, conversationUtils_js_1.detectAdCampaign)(payload.message),
            propertyInquired: null,
            criteria: null,
            brivityId: null,
            crmStatus: "not_contacted",
            crmStage: "new",
            crmPriority: "normal",
            crmIntent: "buyer",
            crmCallQueue: "none",
            crmNotes: null,
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
    const latestLeadText = (0, conversationUtils_js_1.getLastUserMessageText)(conversation);
    /** Out-of-state referral branch (non-Texas only; Texas metros keep the normal funnel). */
    const referralResult = resolveReferralFlow(lead, conversation, latestLeadText, ctx);
    lead = referralResult.lead;
    if (referralResult.handled) {
        if (referralResult.reply) {
            await db.appendMessage(lead.id, "assistant", referralResult.reply);
        }
        await db.updateLead(lead);
        (0, marcoLog_js_1.marcoLog)("pipeline_end", {
            requestId,
            correlationId,
            lead_id: lead.id,
            outcome: referralResult.reply ? "referral_flow" : "referral_flow_no_reply",
            reply_chars: referralResult.reply?.length ?? 0,
            reply_preview: (0, marcoLog_js_1.previewText)(referralResult.reply),
            funnel_state_final: lead.state,
            referral_status: lead.referralStatus ?? null,
            phone_captured_this_turn: false,
            email_captured_this_turn: false,
        });
        return { lead, reply: referralResult.reply };
    }
    const assistantTurnCountInThread = conversation.messages.filter((m) => m.role === "assistant").length;
    if (!hadPhone &&
        assistantTurnCountInThread === 0 &&
        (0, conversationUtils_js_1.isWaveOnlyMessage)(latestLeadText)) {
        if (lead.state === state_js_1.FunnelStage.New) {
            lead = { ...lead, state: state_js_1.FunnelStage.OpeningAskedFirstTime };
        }
        await db.appendMessage(lead.id, "assistant", prompts_js_1.MARCO_WAVE_REPLY);
        await db.updateLead(lead);
        (0, marcoLog_js_1.marcoLog)("wave_reply_pinned", {
            requestId,
            correlationId,
            lead_id: lead.id,
            message_preview: (0, marcoLog_js_1.previewText)(latestLeadText),
            funnel_state_final: lead.state,
        });
        (0, marcoLog_js_1.marcoLog)("pipeline_end", {
            requestId,
            correlationId,
            lead_id: lead.id,
            outcome: "wave_pinned",
            reply_chars: prompts_js_1.MARCO_WAVE_REPLY.length,
            reply_preview: (0, marcoLog_js_1.previewText)(prompts_js_1.MARCO_WAVE_REPLY),
            funnel_state_final: lead.state,
            phone_captured_this_turn: false,
            email_captured_this_turn: false,
        });
        return { lead, reply: prompts_js_1.MARCO_WAVE_REPLY };
    }
    const phoneInThreadEarly = lead.phone ?? (0, funnelDeterministic_js_1.extractPhoneFromConversation)(conversation);
    const phoneCapturedThisTurn = !hadPhone && Boolean(phoneInThreadEarly);
    if (!hadPhone &&
        !phoneCapturedThisTurn &&
        (0, conversationUtils_js_1.messageAsksPropertyPriceOrCost)(latestLeadText)) {
        if (lead.state === state_js_1.FunnelStage.New) {
            lead = { ...lead, state: state_js_1.FunnelStage.OpeningAskedFirstTime };
        }
        await db.appendMessage(lead.id, "assistant", prompts_js_1.MARCO_PRICE_REPLY);
        await db.updateLead(lead);
        (0, marcoLog_js_1.marcoLog)("price_reply_pinned", {
            requestId,
            correlationId,
            lead_id: lead.id,
            message_preview: (0, marcoLog_js_1.previewText)(latestLeadText),
            funnel_state_final: lead.state,
        });
        (0, marcoLog_js_1.marcoLog)("pipeline_end", {
            requestId,
            correlationId,
            lead_id: lead.id,
            outcome: "price_pinned",
            reply_chars: prompts_js_1.MARCO_PRICE_REPLY.length,
            reply_preview: (0, marcoLog_js_1.previewText)(prompts_js_1.MARCO_PRICE_REPLY),
            funnel_state_final: lead.state,
            phone_captured_this_turn: false,
            email_captured_this_turn: false,
        });
        return { lead, reply: prompts_js_1.MARCO_PRICE_REPLY };
    }
    /** Bucket F: call-ask escalation (pre-phone only; suppressed after graceful exit). */
    if (!hadPhone && !phoneCapturedThisTurn) {
        const bucketF = (0, conversationUtils_js_1.resolveCallAskBucketF)(conversation, latestLeadText);
        if (bucketF) {
            if (bucketF.kind === "number_ask") {
                lead = { ...lead, state: state_js_1.FunnelStage.PhoneRequested };
            }
            await db.appendMessage(lead.id, "assistant", bucketF.reply);
            await db.updateLead(lead);
            (0, marcoLog_js_1.marcoLog)("call_ask_bucket_f", {
                requestId,
                correlationId,
                lead_id: lead.id,
                bucket_f_kind: bucketF.kind,
                message_preview: (0, marcoLog_js_1.previewText)(latestLeadText),
                funnel_state_final: lead.state,
            });
            (0, marcoLog_js_1.marcoLog)("pipeline_end", {
                requestId,
                correlationId,
                lead_id: lead.id,
                outcome: `call_ask_${bucketF.kind}`,
                reply_chars: bucketF.reply.length,
                reply_preview: (0, marcoLog_js_1.previewText)(bucketF.reply),
                funnel_state_final: lead.state,
                phone_captured_this_turn: false,
                email_captured_this_turn: false,
            });
            return { lead, reply: bucketF.reply };
        }
    }
    /** Pre-phone: lead agreed to breakdown offer — pinned phone ask (replaces LLM "perfect"). */
    if (!hadPhone &&
        !phoneCapturedThisTurn &&
        (0, conversationUtils_js_1.threadContainsBreakdownOffer)(conversation) &&
        (0, conversationUtils_js_1.signalsAffirmativeBreakdownAgreement)(latestLeadText)) {
        lead = { ...lead, state: state_js_1.FunnelStage.PhoneRequested };
        await db.appendMessage(lead.id, "assistant", prompts_js_1.MARCO_PHONE_ASK_REPLY);
        await db.updateLead(lead);
        (0, marcoLog_js_1.marcoLog)("phone_ask_reply_pinned", {
            requestId,
            correlationId,
            lead_id: lead.id,
            message_preview: (0, marcoLog_js_1.previewText)(latestLeadText),
            funnel_state_final: lead.state,
        });
        (0, marcoLog_js_1.marcoLog)("pipeline_end", {
            requestId,
            correlationId,
            lead_id: lead.id,
            outcome: "phone_ask_pinned",
            reply_chars: prompts_js_1.MARCO_PHONE_ASK_REPLY.length,
            reply_preview: (0, marcoLog_js_1.previewText)(prompts_js_1.MARCO_PHONE_ASK_REPLY),
            funnel_state_final: lead.state,
            phone_captured_this_turn: false,
            email_captured_this_turn: false,
        });
        return { lead, reply: prompts_js_1.MARCO_PHONE_ASK_REPLY };
    }
    const ackCloseout = (0, conversationUtils_js_1.resolveAcknowledgmentCloseoutTurn)(conversation, latestLeadText, prompts_js_1.MARCO_CLOSEOUT_REPLY, { skipIfPhoneCapturedThisTurn: phoneCapturedThisTurn });
    if (ackCloseout === "silence") {
        (0, marcoLog_js_1.marcoLog)("ack_closeout_silence", {
            requestId,
            correlationId,
            lead_id: lead.id,
            had_phone: hadPhone,
            message_preview: (0, marcoLog_js_1.previewText)(latestLeadText),
        });
        await db.updateLead(lead);
        (0, marcoLog_js_1.marcoLog)("pipeline_end", {
            requestId,
            correlationId,
            lead_id: lead.id,
            outcome: "no_reply_ack_after_closeout",
            reply_chars: 0,
            funnel_state_final: lead.state,
            phone_captured_this_turn: false,
            email_captured_this_turn: false,
        });
        return { lead, reply: null };
    }
    if (ackCloseout === "closeout") {
        await db.appendMessage(lead.id, "assistant", prompts_js_1.MARCO_CLOSEOUT_REPLY);
        await db.updateLead(lead);
        (0, marcoLog_js_1.marcoLog)("ack_closeout_sent", {
            requestId,
            correlationId,
            lead_id: lead.id,
            had_phone: hadPhone,
            message_preview: (0, marcoLog_js_1.previewText)(latestLeadText),
        });
        (0, marcoLog_js_1.marcoLog)("pipeline_end", {
            requestId,
            correlationId,
            lead_id: lead.id,
            outcome: "ack_closeout",
            reply_chars: prompts_js_1.MARCO_CLOSEOUT_REPLY.length,
            reply_preview: (0, marcoLog_js_1.previewText)(prompts_js_1.MARCO_CLOSEOUT_REPLY),
            funnel_state_final: lead.state,
            phone_captured_this_turn: false,
            email_captured_this_turn: false,
        });
        return { lead, reply: prompts_js_1.MARCO_CLOSEOUT_REPLY };
    }
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
    const igDmTurn = payload.platform.toLowerCase().includes("insta") && payload.commentOrDm === "dm";
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
    if ((0, conversationUtils_js_1.messageAsksBuilderIdentity)(latestLeadText)) {
        coachingNote = [
            coachingNote,
            "BUILDER_GUARD: Lead asked who the builder is. NEVER name or hint the builder or developer. Deflect briefly; steer to a good number for the full breakdown (or west of Stone Oak only if they asked location).",
        ]
            .filter(Boolean)
            .join(" ");
    }
    if ((0, conversationUtils_js_1.signalsLookingOutsideSanAntonio)(latestLeadText)) {
        coachingNote = [
            coachingNote,
            "TEXAS_SERVICE_AREA: The lead is looking outside San Antonio or named another Texas area. In Marco's first-person voice: say you help buyers all across Texas for homes above $600k, one short sentence, then continue helping with their question or the listing thread. Do not imply you only serve greater San Antonio for that buyer.",
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
    if (hadPhone) {
        coachingNote = [
            coachingNote,
            "POST_PHONE_CAPTURE: Mobile number is already on file. Never ask price range, budget, suitability, preferences, timeline, or bedrooms. Answer specific property questions only; do not run needs analysis or re-offer the full breakdown unless they explicitly ask for it again.",
        ]
            .filter(Boolean)
            .join(" ");
    }
    coachingNote = [
        coachingNote,
        "NO_NEEDS_ANALYSIS: Never ask about preferences, what is important in a home, timeline, bedrooms, bathrooms, or home features. Acknowledge, brief answer if they asked something specific, then steer to a mobile number only.",
        "PHONE_ONLY_DELIVERY: Never ask phone or email, never offer email for breakdowns or listings. Text/SMS to mobile only. If they gave an email, thank briefly and still ask for number to text the packet. No hyphen or dash pauses between phrases in the reply.",
        ...(payload.platform.toLowerCase().includes("tik") || igDmTurn
            ? [
                "NEUTRAL_DM_NO_LIST_PRICE: Never quote listing price, ballpark, or dollar amounts for the property in DM. If they ask how much, offer to text full breakdown with pricing after they share a mobile number. First-time buyer question drives engagement when not already in the thread.",
            ]
            : []),
    ]
        .filter(Boolean)
        .join(" ");
    const preflight = {
        repeatedMessage: leadLineRepeatForModel,
        coachingNote: coachingNote.trim(),
    };
    /** IG/ManyChat often fires twice for one phone (text + contact card). Second hit: no LLM, no duplicate ask. */
    if (leadRepeatedForAdvancement) {
        const phoneInThread = lead.phone ?? (0, funnelDeterministic_js_1.extractPhoneFromConversation)(conversation);
        if (phoneInThread) {
            if (!lead.phone) {
                lead = { ...lead, phone: phoneInThread, state: state_js_1.FunnelStage.PropertySent };
                const capturedReply = (0, conversationUtils_js_1.resolvePhoneCapturedReply)(conversation);
                await db.appendMessage(lead.id, "assistant", capturedReply);
                await db.updateLead(lead);
                (0, marcoLog_js_1.marcoLog)("duplicate_user_phone_captured", {
                    requestId,
                    correlationId,
                    lead_id: lead.id,
                });
                (0, marcoLog_js_1.marcoLog)("pipeline_end", {
                    requestId,
                    correlationId,
                    lead_id: lead.id,
                    outcome: "duplicate_user_phone_first_capture",
                    reply_chars: capturedReply.length,
                    reply_preview: (0, marcoLog_js_1.previewText)(capturedReply),
                    funnel_state_final: lead.state,
                    phone_captured_this_turn: true,
                    email_captured_this_turn: false,
                });
                return { lead, reply: capturedReply };
            }
            (0, marcoLog_js_1.marcoLog)("pipeline_end", {
                requestId,
                correlationId,
                lead_id: lead.id,
                outcome: "duplicate_user_phone_skipped",
                reply_chars: 0,
                funnel_state_final: lead.state,
                phone_captured_this_turn: false,
                email_captured_this_turn: false,
            });
            return { lead, reply: null };
        }
    }
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
        let rawOpeningReply = result.reply;
        if (!lead.phone) {
            const p = (0, funnelDeterministic_js_1.extractPhoneFromConversation)(conversation);
            if (p) {
                lead = { ...lead, phone: p, state: state_js_1.FunnelStage.PropertySent };
                rawOpeningReply = (0, conversationUtils_js_1.resolvePhoneCapturedReply)(conversation);
                (0, marcoLog_js_1.marcoLog)("opening_same_turn_phone_capture", {
                    requestId,
                    correlationId,
                    lead_id: lead.id,
                });
            }
        }
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
        if (meta.phoneJustCaptured) {
            reply = (0, conversationUtils_js_1.resolvePhoneCapturedReply)(conversation);
            (0, marcoLog_js_1.marcoLog)("phone_captured_reply_pinned", {
                requestId,
                correlationId,
                lead_id: lead.id,
                call_ask_path: (0, conversationUtils_js_1.threadHadCallAskPath)(conversation),
                reply_preview: (0, marcoLog_js_1.previewText)(reply),
            });
        }
        else if (!skipLlm) {
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
        const freshConv = await db.getConversation(lead.id);
        const trailingAssistants = (0, conversationUtils_js_1.countTrailingAssistantsAtEnd)(freshConv);
        const alreadyReplied = (0, conversationUtils_js_1.countAssistantsSinceLastUser)(freshConv) >= 1;
        const lastRole = freshConv.messages[freshConv.messages.length - 1]?.role;
        if (lastRole !== "user" || alreadyReplied || trailingAssistants >= 2) {
            (0, marcoLog_js_1.marcoLog)("consecutive_assistant_guard", {
                requestId,
                correlationId,
                lead_id: lead.id,
                trailing_assistant_count: trailingAssistants,
                already_replied_to_last_user: alreadyReplied,
                last_message_role: lastRole ?? null,
                action: "suppress_reply",
            });
            reply = null;
        }
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
