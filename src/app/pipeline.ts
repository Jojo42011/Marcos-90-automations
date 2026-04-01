/**
 * Run modules in order by lead state. Single entry for webhook-driven flow.
 */
import * as db from "../core/db.js";
import type { Conversation, IncomingWebhookPayload, Lead } from "../core/types.js";
import { FunnelStage } from "../core/state.js";
import { process as toneMatchedProcess } from "../modules/03-tone-matched-dm";
import { process as commentDmMonitorProcess } from "../modules/01-comment-dm-monitor";
import { process as brivitySyncProcess } from "../modules/08-brivity-auto-sync";
import {
  classifyNewLeadBuyingIntent,
  generateMarcoPipelineReply,
  preflightLeadTurnReview,
  sanitizeOpeningReplyAgainstRecentMarco,
  sanitizePipelineReplyAgainstRecentMarco,
  type PreflightTurnResult,
} from "../integrations/llm";
import { advanceFunnelDeterministic } from "./funnelDeterministic.js";
import {
  getLastUserMessageText,
  isLastUserMessageRepeated,
  isShortDuplicateUserPair,
  lastTwoAssistantMessagesAreDuplicate,
  latestAssistantEchoesEarlierInThread,
  leadThreadSignalsExperiencedBuyer,
  messageAsksBuilderIdentity,
  threadContainsFirstTimeBuyingQuestion,
} from "./conversationUtils.js";
import {
  marcoCorrelationId,
  marcoLog,
  marcoLogDebug,
  newMarcoRequestId,
  previewText,
  type MarcoLogContext,
} from "./marcoLog.js";

export interface PipelineResult {
  reply: string | null;
  /** Null when a brand-new contact failed the buyer-intent gate (no lead created). */
  lead: Lead | null;
}

/** First touch from Instagram comment automation: no comment text, no LLM — DM carries the real opener. */
const COMMENT_HANDSHAKE_REPLY =
  "Hey! Saw you commented on the home. What would you like to know?";

function normalizeThreadSnippet(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * TikTok: Marco sends the first DM manually in-app. ManyChat passes that text as `marco_previous_outbound`
 * on the lead’s first webhook so the DB thread matches reality and the model does not repeat the opener.
 */
async function maybeSeedTiktokManualOpener(
  lead: Lead,
  payload: IncomingWebhookPayload,
  ctx: MarcoLogContext,
): Promise<Lead> {
  const raw = payload.marcoPreviousOutbound?.trim() ?? "";
  if (!raw) return lead;
  if (!payload.platform.toLowerCase().includes("tik")) return lead;

  const conv = await db.getConversation(lead.id);
  if (conv.messages.some((m) => m.role === "assistant")) {
    return lead;
  }

  await db.appendMessage(lead.id, "assistant", raw);
  marcoLog("tiktok_manual_opener_seeded", {
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
    lead_id: lead.id,
    opener_preview: previewText(raw, 200),
    opener_norm_match: normalizeThreadSnippet(raw).slice(0, 80),
  });

  if (lead.state === FunnelStage.New) {
    const advanced: Lead = { ...lead, state: FunnelStage.OpeningAskedFirstTime };
    await db.updateLead(advanced);
    return advanced;
  }
  return lead;
}

export async function run(
  payload: IncomingWebhookPayload,
  log?: MarcoLogContext,
): Promise<PipelineResult> {
  const requestId = log?.requestId ?? newMarcoRequestId();
  const correlationId = log?.correlationId ?? marcoCorrelationId(payload.platform, payload.userId);
  const ctx: MarcoLogContext = { requestId, correlationId };

  let lead = await db.getLead(payload.platform, payload.userId);
  const conversationBefore = lead ? await db.getConversation(lead.id) : { messages: [] };

  const isCommentHandshake =
    payload.commentOrDm === "comment" &&
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
        state: FunnelStage.New,
        source: payload.platform,
        propertyInquired: null,
        criteria: null,
        brivityId: null,
      });
      createdLeadThisRequest = true;
    }
    marcoLog("comment_handshake", {
      requestId,
      correlationId,
      lead_id: lead.id,
      created_lead_this_request: createdLeadThisRequest,
    });
    marcoLog("pipeline_end", {
      requestId,
      correlationId,
      lead_id: lead.id,
      outcome: "comment_handshake",
      reply_chars: COMMENT_HANDSHAKE_REPLY.length,
      reply_preview: previewText(COMMENT_HANDSHAKE_REPLY),
      funnel_state_final: lead.state,
      phone_captured_this_turn: false,
      email_captured_this_turn: false,
    });
    return { lead, reply: COMMENT_HANDSHAKE_REPLY };
  }

  if (!lead) {
    const interested = await classifyNewLeadBuyingIntent(payload.message, {
      channel: payload.commentOrDm,
    });
    marcoLog("intent_gate", {
      requestId,
      correlationId,
      interested,
      message_preview: previewText(payload.message),
    });
    if (!interested) {
      marcoLog("pipeline_end", {
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
      state: FunnelStage.New,
      source: payload.platform,
      propertyInquired: null,
      criteria: null,
      brivityId: null,
    });
  }

  if (!payload.message.trim()) {
    marcoLog("pipeline_end", {
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
  const conversation: Conversation = await db.getConversation(lead.id);
  const hadPhone = Boolean(lead.phone);
  const hadEmail = Boolean(lead.email);

  const userTurnCount = conversation.messages.filter((m) => m.role === "user").length;
  const assistantTurnCount = conversation.messages.filter((m) => m.role === "assistant").length;

  const preflightRaw: PreflightTurnResult =
    userTurnCount >= 2
      ? await preflightLeadTurnReview({ conversation, leadState: lead.state }, ctx)
      : { repeatedMessage: false, coachingNote: "" };

  const shortDup = isShortDuplicateUserPair(conversation);
  /** Only deterministic lead dup — freezes opening advance (never use Marco self-duplicate for this). */
  const leadRepeatedForAdvancement = isLastUserMessageRepeated(conversation) && !shortDup;
  /** Haiku near-duplicate lead lines → coaching + model flag; does not freeze funnel by itself. */
  const leadLineRepeatForModel = leadRepeatedForAdvancement || (preflightRaw.repeatedMessage && !shortDup);

  const lastTwoAssistantDup = lastTwoAssistantMessagesAreDuplicate(conversation);
  const assistantEchoesEarlier = latestAssistantEchoesEarlierInThread(conversation);
  const marcoAssistantDup = lastTwoAssistantDup || assistantEchoesEarlier;

  marcoLog("pipeline_turn", {
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

  marcoLogDebug("preflight_coaching", {
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

  const latestLeadText = getLastUserMessageText(conversation);
  if (messageAsksBuilderIdentity(latestLeadText)) {
    coachingNote = [
      coachingNote,
      "BUILDER_GUARD: Lead asked who the builder is. NEVER name or hint the builder or developer. Deflect briefly; steer to a good number for the full breakdown (or west of Stone Oak only if they asked location).",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (threadContainsFirstTimeBuyingQuestion(conversation) || leadThreadSignalsExperiencedBuyer(conversation)) {
    coachingNote = [
      coachingNote,
      "FIRST_TIME_TOPIC_CLOSED: Do NOT ask again about first time going through the buying process or any paraphrase. Marco or the lead already covered it. Reply only to what they said last and move forward.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  const preflight: PreflightTurnResult = {
    repeatedMessage: leadLineRepeatForModel,
    coachingNote: coachingNote.trim(),
  };

  marcoLogDebug("merged_coaching_for_model", {
    requestId,
    correlationId,
    coaching_chars: preflight.coachingNote.length,
    coaching_full: preflight.coachingNote || "(empty)",
  });

  let reply: string | null = null;

  if (
    lead.state === FunnelStage.New ||
    lead.state === FunnelStage.OpeningAskedFirstTime ||
    lead.state === FunnelStage.OpeningOfferedDetails
  ) {
    const openingStageBefore = lead.state;
    lead = (await commentDmMonitorProcess(lead, conversation)).lead;
    const tOpen = Date.now();
    const result = await toneMatchedProcess(lead, conversation, {
      leadRepeatedForAdvancement,
      leadLineRepeatForModel,
      coachingNote: preflight.coachingNote,
      inboundChannel: payload.commentOrDm,
      inboundPlatform: payload.platform,
      log: ctx,
    });
    lead = result.lead;
    const rawOpeningReply = result.reply;
    reply = sanitizeOpeningReplyAgainstRecentMarco(
      rawOpeningReply,
      lead,
      conversation,
      openingStageBefore,
      ctx,
      payload.commentOrDm,
      payload.platform,
    );
    marcoLog("opening_branch", {
      requestId,
      correlationId,
      opening_stage_before: openingStageBefore,
      funnel_state_out: lead.state,
      ms_opening_llm: Date.now() - tOpen,
      reply_source:
        !rawOpeningReply && !reply
          ? "none"
          : rawOpeningReply === reply
            ? "model"
            : "sanitized",
      raw_reply_preview: previewText(rawOpeningReply),
      final_reply_preview: previewText(reply),
    });
  } else if (
    lead.state === FunnelStage.PhoneRequested ||
    lead.state === FunnelStage.PropertySent ||
    lead.state === FunnelStage.CriteriaCollected ||
    lead.state === FunnelStage.EmailSent
  ) {
    const stateBeforeDeterministic = lead.state;
    const { lead: advanced, meta } = advanceFunnelDeterministic(lead, conversation);
    lead = advanced;

    const skipLlm =
      lead.state === FunnelStage.Closed && !meta.phoneJustCaptured && !meta.listSendPromised;

    marcoLog("post_opening_branch", {
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
      const rawPipelineReply = await generateMarcoPipelineReply({
        lead,
        conversation,
        meta,
        preflight,
        inboundChannel: payload.commentOrDm,
        inboundPlatform: payload.platform,
        log: ctx,
      });
      reply = sanitizePipelineReplyAgainstRecentMarco(
        rawPipelineReply,
        lead,
        conversation,
        meta,
        ctx,
      );
      marcoLog("post_opening_reply", {
        requestId,
        correlationId,
        ms_pipeline_llm: Date.now() - tPipe,
        reply_source:
          !rawPipelineReply && !reply
            ? "none"
            : rawPipelineReply === reply
              ? "model"
              : "sanitized",
        raw_reply_preview: previewText(rawPipelineReply),
        final_reply_preview: previewText(reply),
      });
    } else {
      marcoLog("post_opening_skip_llm", {
        requestId,
        correlationId,
        funnel_state: lead.state,
        reason: "closed_without_phone_capture_or_list_promise",
      });
    }
  } else {
    marcoLog("pipeline_unhandled_funnel_stage", {
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
    lead = (await brivitySyncProcess(lead, conversation)).lead;
  }

  await db.updateLead(lead);

  marcoLog("pipeline_end", {
    requestId,
    correlationId,
    lead_id: lead.id,
    outcome: reply ? "replied" : "no_reply",
    reply_chars: reply?.length ?? 0,
    reply_preview: previewText(reply),
    funnel_state_final: lead.state,
    phone_captured_this_turn: hasNewPhone,
    email_captured_this_turn: hasNewEmail,
  });

  return { lead, reply };
}

