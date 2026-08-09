/**
 * Run modules in order by lead state. Single entry for webhook-driven flow.
 */
import * as db from "../core/db.js";
import type { Conversation, IncomingWebhookPayload, Lead } from "../core/types.js";
import { FunnelStage } from "../core/state.js";
import { resolveInboundListingRef } from "./inboundListing.js";
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
import {
  advanceFunnelDeterministic,
  extractPhoneFromConversation,
} from "./funnelDeterministic.js";
import {
  MARCO_BUSINESS_COLLAB_REPLY,
  MARCO_CITY_REPLY,
  MARCO_CLOSEOUT_REPLY,
  MARCO_PHONE_ASK_REPLY,
  MARCO_PHONE_REFUSAL_APOLOGY,
  MARCO_PRICE_REPLY,
  MARCO_WAVE_REPLY,
} from "../../config/prompts.js";
import {
  buildOutOfStateReferralOffer,
  countAssistantsSinceLastUser,
  countTrailingAssistantsAtEnd,
  detectOutOfStateLead,
  detectAdCampaign,
  agentMessageCommittedToSend,
  detectCommunicationStyle,
  DENIAL_OF_INQUIRY_REPLY,
  getCommunicationStyleInstructions,
  getDuplicateMessageResponse,
  getLastAssistantMessageText,
  getLastUserMessageText,
  getPhoneRequestCount,
  getPhoneRequestVariation,
  claimsAlreadySentNumber,
  isBusinessPitchInquiry,
  isDenialOfInquiry,
  isExactDuplicateMessage,
  isLastUserMessageRepeated,
  isRealtorAndRelocating,
  isRealtorMessage,
  isSimpleAcknowledgment,
  REALTOR_REDIRECT_REPLY,
  REALTOR_RELOCATION_REPLY,
  isShortDuplicateUserPair,
  isWaveOnlyMessage,
  lastTwoAssistantMessagesAreDuplicate,
  latestAssistantEchoesEarlierInThread,
  leadThreadSignalsExperiencedBuyer,
  messageAsksBuilderIdentity,
  messageAsksPropertyPriceOrCost,
  messageAsksWhatCity,
  REFERRAL_AREA_FOLLOW_UP,
  resolveAcknowledgmentCloseoutTurn,
  resolveBuyingConfusionReply,
  resolveCallAskBucketF,
  resolveNumberNotReceivedReply,
  resolvePhoneCapturedReply,
  signalsAffirmativeBreakdownAgreement,
  signalsExplicitPhoneRefusal,
  signalsLookingOutsideSanAntonio,
  signalsReferralAcceptance,
  signalsReferralDeclineOrWantsSanAntonio,
  threadContainsBreakdownOffer,
  threadContainsFirstTimeBuyingQuestion,
  threadContainsPhoneRefusalApology,
  threadContainsReferralOffer,
  threadHadCallAskPath,
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

type ReferralFlowResult =
  | { handled: true; lead: Lead; reply: string | null }
  | { handled: false; lead: Lead };

/**
 * Out-of-state referral handling. `handled: false` continues the normal funnel.
 */
function resolveReferralFlow(
  lead: Lead,
  conversation: Conversation,
  latestText: string,
  ctx: MarcoLogContext,
): ReferralFlowResult {
  const offeredInThread = threadContainsReferralOffer(conversation);
  const status = lead.referralStatus ?? null;

  if (status === "referral_needed") {
    const areaNote = latestText.trim();
    const notes = lead.crmNotes?.trim()
      ? `${lead.crmNotes.trim()}\nReferral area: ${areaNote}`
      : `Referral area: ${areaNote}`;
    marcoLog("referral_area_captured", {
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      lead_id: lead.id,
      area_preview: previewText(areaNote, 120),
    });
    return {
      handled: true,
      lead: { ...lead, crmNotes: notes },
      reply: "Got it, I'll get you connected with the right person out there.",
    };
  }

  if (status === "offered" || offeredInThread) {
    if (signalsReferralAcceptance(latestText)) {
      marcoLog("referral_accepted", {
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
        reply: REFERRAL_AREA_FOLLOW_UP,
      };
    }
    if (signalsReferralDeclineOrWantsSanAntonio(latestText)) {
      marcoLog("referral_declined_resume_funnel", {
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        lead_id: lead.id,
      });
      return {
        handled: false,
        lead: {
          ...lead,
          referralStatus: null,
          state: FunnelStage.New,
        },
      };
    }
    return { handled: false, lead };
  }

  const oos = detectOutOfStateLead(latestText);
  if (!oos.detected) {
    return { handled: false, lead };
  }

  // A lead already engaged with a specific listing (agreed to the breakdown)
  // is mentioning their OWN current city, not asking to buy there — referring
  // them to another agent here would derail someone already close to closing.
  // Reassure the home's Texas/San Antonio location instead and let the normal
  // funnel continue (coaching note added in the caller via
  // signalsLookingOutsideSanAntonio-style handling is not needed here since
  // this path returns handled:false and falls through to the pipeline, which
  // applies OUT_OF_STATE_MID_THREAD below).
  if (threadContainsBreakdownOffer(conversation)) {
    marcoLog("out_of_state_mid_thread_no_referral", {
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      lead_id: lead.id,
      region_label: oos.regionLabel,
      message_preview: previewText(latestText),
    });
    return { handled: false, lead };
  }

  marcoLog("out_of_state_detected", {
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
    lead_id: lead.id,
    region_label: oos.regionLabel,
    message_preview: previewText(latestText),
  });

  return {
    handled: true,
    lead: { ...lead, referralStatus: "offered" },
    reply: buildOutOfStateReferralOffer(oos.regionLabel),
  };
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
  const platformLower = payload.platform.toLowerCase();
  const allowManualOpenerSeed =
    platformLower.includes("tik") ||
    (platformLower.includes("insta") && payload.commentOrDm === "dm");
  if (!allowManualOpenerSeed) return lead;

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
    const inboundText = payload.message.trim();

    if (inboundText && isDenialOfInquiry(inboundText)) {
      console.error(
        `[pipeline] FALSE TRIGGER detected (new contact). Message: "${inboundText}". Investigate webhook trigger source.`,
      );
      marcoLog("pipeline_end", {
        requestId,
        correlationId,
        outcome: "denial_of_inquiry_new_contact",
        reply_chars: DENIAL_OF_INQUIRY_REPLY.length,
        reply_preview: previewText(DENIAL_OF_INQUIRY_REPLY),
        phone_captured_this_turn: false,
        email_captured_this_turn: false,
      });
      return { lead: null, reply: DENIAL_OF_INQUIRY_REPLY };
    }

    if (inboundText && isRealtorAndRelocating(inboundText)) {
      marcoLog("pipeline_end", {
        requestId,
        correlationId,
        outcome: "realtor_relocation_ask_new_contact",
        reply_chars: REALTOR_RELOCATION_REPLY.length,
        reply_preview: previewText(REALTOR_RELOCATION_REPLY),
        phone_captured_this_turn: false,
        email_captured_this_turn: false,
      });
      return { lead: null, reply: REALTOR_RELOCATION_REPLY };
    }

    if (inboundText && isRealtorMessage(inboundText)) {
      marcoLog("pipeline_end", {
        requestId,
        correlationId,
        outcome: "realtor_redirect_new_contact",
        reply_chars: REALTOR_REDIRECT_REPLY.length,
        reply_preview: previewText(REALTOR_REDIRECT_REPLY),
        phone_captured_this_turn: false,
        email_captured_this_turn: false,
      });
      return { lead: null, reply: REALTOR_REDIRECT_REPLY };
    }

    if (inboundText && isBusinessPitchInquiry(inboundText)) {
      marcoLog("pipeline_end", {
        requestId,
        correlationId,
        outcome: "business_pitch_redirect_new_contact",
        reply_chars: MARCO_BUSINESS_COLLAB_REPLY.length,
        reply_preview: previewText(MARCO_BUSINESS_COLLAB_REPLY),
        phone_captured_this_turn: false,
        email_captured_this_turn: false,
      });
      return { lead: null, reply: MARCO_BUSINESS_COLLAB_REPLY };
    }

    const skipIntentGateTiktokManualOpener =
      Boolean(payload.marcoPreviousOutbound?.trim()) &&
      (payload.platform.toLowerCase().includes("tik") ||
        (payload.platform.toLowerCase().includes("insta") && payload.commentOrDm === "dm"));

    let interested: boolean;
    if (skipIntentGateTiktokManualOpener) {
      interested = true;
      marcoLog("intent_gate_skipped", {
        requestId,
        correlationId,
        reason: "tiktok_marco_previous_outbound",
        message_preview: previewText(payload.message),
      });
    } else if (isWaveOnlyMessage(payload.message.trim())) {
      interested = true;
      marcoLog("intent_gate", {
        requestId,
        correlationId,
        interested: true,
        reason: "wave_only",
        message_preview: previewText(payload.message),
      });
    } else {
      interested = await classifyNewLeadBuyingIntent(payload.message, {
        channel: payload.commentOrDm,
        platform: payload.platform,
      });
      marcoLog("intent_gate", {
        requestId,
        correlationId,
        interested,
        message_preview: previewText(payload.message),
      });
    }
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
      adCampaign: detectAdCampaign(payload.message),
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

  /* ManyChat can tell us WHICH listing the automation fired from. Resolving it
     here, before the reply is generated, is what lets the opener name the home
     instead of asking which one. See inboundListing.ts for why we only trust a
     confirmed match and never overwrite an existing link. */
  const listingRef = resolveInboundListingRef(payload.listingRef, lead.mlsListingKey);
  if (listingRef.outcome !== "none") {
    marcoLog("inbound_listing_ref", {
      requestId,
      correlationId,
      lead_id: lead.id,
      outcome: listingRef.outcome,
      ref: listingRef.ref,
      resolved_key: listingRef.listingKey,
      resolved_address: listingRef.address,
    });
    if (listingRef.outcome === "resolved" && listingRef.listingKey) {
      lead = { ...lead, mlsListingKey: listingRef.listingKey };
      await db.updateLead(lead);
    }
  }

  await db.appendMessage(lead.id, "user", payload.message);

  /* Brivity's Auto Plan safety valve: the moment the lead actually replies,
     stop any plan configured to auto-pause on reply — a scripted drip must not
     keep firing at someone who is now in a live conversation. Covers SMS and
     DMs alike, since both land here. */
  const pausedForReply = db.pauseAutoPlansOnInboundText(lead);
  if (pausedForReply) {
    lead = pausedForReply;
    await db.updateLead(lead);
    marcoLog("auto_plan_paused_on_reply", { requestId, correlationId, lead_id: lead.id });
  }

  const conversation: Conversation = await db.getConversation(lead.id);
  const hadPhone = Boolean(lead.phone);
  const hadEmail = Boolean(lead.email);

  const latestLeadText = getLastUserMessageText(conversation);

  const conversationHistoryForDup = conversation.messages.map((m) => ({
    role: m.role,
    content: m.text,
  }));

  if (isDenialOfInquiry(latestLeadText)) {
    console.error(
      `[pipeline] FALSE TRIGGER detected for lead ${lead.id}. Message: "${latestLeadText}". Investigate webhook trigger source.`,
    );
    await db.appendMessage(lead.id, "assistant", DENIAL_OF_INQUIRY_REPLY);
    await db.updateLead(lead);
    marcoLog("pipeline_end", {
      requestId,
      correlationId,
      lead_id: lead.id,
      outcome: "denial_of_inquiry",
      reply_chars: DENIAL_OF_INQUIRY_REPLY.length,
      reply_preview: previewText(DENIAL_OF_INQUIRY_REPLY),
      funnel_state_final: lead.state,
      phone_captured_this_turn: false,
      email_captured_this_turn: false,
    });
    return { lead, reply: DENIAL_OF_INQUIRY_REPLY };
  }

  if (isRealtorAndRelocating(latestLeadText)) {
    await db.appendMessage(lead.id, "assistant", REALTOR_RELOCATION_REPLY);
    await db.updateLead(lead);
    marcoLog("pipeline_end", {
      requestId,
      correlationId,
      lead_id: lead.id,
      outcome: "realtor_relocation_ask",
      reply_chars: REALTOR_RELOCATION_REPLY.length,
      reply_preview: previewText(REALTOR_RELOCATION_REPLY),
      funnel_state_final: lead.state,
      phone_captured_this_turn: false,
      email_captured_this_turn: false,
    });
    return { lead, reply: REALTOR_RELOCATION_REPLY };
  }

  if (isRealtorMessage(latestLeadText)) {
    console.log(`[pipeline] Realtor detected for lead ${lead.id} — redirecting to Marco's number`);
    await db.appendMessage(lead.id, "assistant", REALTOR_REDIRECT_REPLY);
    await db.updateLead(lead);
    marcoLog("pipeline_end", {
      requestId,
      correlationId,
      lead_id: lead.id,
      outcome: "realtor_redirect",
      reply_chars: REALTOR_REDIRECT_REPLY.length,
      reply_preview: previewText(REALTOR_REDIRECT_REPLY),
      funnel_state_final: lead.state,
      phone_captured_this_turn: false,
      email_captured_this_turn: false,
    });
    return { lead, reply: REALTOR_REDIRECT_REPLY };
  }

  if (isBusinessPitchInquiry(latestLeadText)) {
    console.log(`[pipeline] Business pitch detected for lead ${lead.id} — redirecting to assistant email`);
    await db.appendMessage(lead.id, "assistant", MARCO_BUSINESS_COLLAB_REPLY);
    await db.updateLead(lead);
    marcoLog("pipeline_end", {
      requestId,
      correlationId,
      lead_id: lead.id,
      outcome: "business_pitch_redirect",
      reply_chars: MARCO_BUSINESS_COLLAB_REPLY.length,
      reply_preview: previewText(MARCO_BUSINESS_COLLAB_REPLY),
      funnel_state_final: lead.state,
      phone_captured_this_turn: false,
      email_captured_this_turn: false,
    });
    return { lead, reply: MARCO_BUSINESS_COLLAB_REPLY };
  }

  if (isSimpleAcknowledgment(latestLeadText)) {
    const lastAgent = getLastAssistantMessageText(conversation);
    if (agentMessageCommittedToSend(lastAgent)) {
      console.log(
        `[pipeline] Simple acknowledgment after commitment — no response needed for lead ${lead.id}`,
      );
      await db.updateLead(lead);
      marcoLog("pipeline_end", {
        requestId,
        correlationId,
        lead_id: lead.id,
        outcome: "simple_ack_after_commitment_silence",
        reply_chars: 0,
        funnel_state_final: lead.state,
        phone_captured_this_turn: false,
        email_captured_this_turn: false,
      });
      return { lead, reply: null };
    }
  }

  if (isExactDuplicateMessage(latestLeadText, conversationHistoryForDup)) {
    const duplicateResponse = getDuplicateMessageResponse();
    console.log(`[pipeline] Duplicate message detected for lead ${lead.id} — returning curious response`);
    await db.appendMessage(lead.id, "assistant", duplicateResponse);
    await db.updateLead(lead);
    marcoLog("pipeline_end", {
      requestId,
      correlationId,
      lead_id: lead.id,
      outcome: "duplicate_user_message_curious_reply",
      reply_chars: duplicateResponse.length,
      reply_preview: previewText(duplicateResponse),
      funnel_state_final: lead.state,
      phone_captured_this_turn: false,
      email_captured_this_turn: false,
    });
    return { lead, reply: duplicateResponse };
  }

  /** Out-of-state referral branch (non-Texas only; Texas metros keep the normal funnel). */
  const referralResult = resolveReferralFlow(lead, conversation, latestLeadText, ctx);
  lead = referralResult.lead;
  if (referralResult.handled) {
    if (referralResult.reply) {
      await db.appendMessage(lead.id, "assistant", referralResult.reply);
    }
    await db.updateLead(lead);
    marcoLog("pipeline_end", {
      requestId,
      correlationId,
      lead_id: lead.id,
      outcome: referralResult.reply ? "referral_flow" : "referral_flow_no_reply",
      reply_chars: referralResult.reply?.length ?? 0,
      reply_preview: previewText(referralResult.reply),
      funnel_state_final: lead.state,
      referral_status: lead.referralStatus ?? null,
      phone_captured_this_turn: false,
      email_captured_this_turn: false,
    });
    return { lead, reply: referralResult.reply };
  }

  const assistantTurnCountInThread = conversation.messages.filter((m) => m.role === "assistant").length;

  if (
    !hadPhone &&
    assistantTurnCountInThread === 0 &&
    isWaveOnlyMessage(latestLeadText)
  ) {
    if (lead.state === FunnelStage.New) {
      lead = { ...lead, state: FunnelStage.OpeningAskedFirstTime };
    }
    await db.appendMessage(lead.id, "assistant", MARCO_WAVE_REPLY);
    await db.updateLead(lead);
    marcoLog("wave_reply_pinned", {
      requestId,
      correlationId,
      lead_id: lead.id,
      message_preview: previewText(latestLeadText),
      funnel_state_final: lead.state,
    });
    marcoLog("pipeline_end", {
      requestId,
      correlationId,
      lead_id: lead.id,
      outcome: "wave_pinned",
      reply_chars: MARCO_WAVE_REPLY.length,
      reply_preview: previewText(MARCO_WAVE_REPLY),
      funnel_state_final: lead.state,
      phone_captured_this_turn: false,
      email_captured_this_turn: false,
    });
    return { lead, reply: MARCO_WAVE_REPLY };
  }

  /**
   * Lead came back confused at the first-time-buying opener ("Buying of what?").
   * Marco sends that opener manually with no property context, so apologize and re-anchor
   * to the listing instead of asking them to dig up a screenshot.
   */
  if (!hadPhone) {
    const confusionReply = resolveBuyingConfusionReply(conversation, latestLeadText);
    if (confusionReply) {
      if (lead.state === FunnelStage.New) {
        lead = { ...lead, state: FunnelStage.OpeningAskedFirstTime };
      }
      await db.appendMessage(lead.id, "assistant", confusionReply);
      await db.updateLead(lead);
      marcoLog("buying_confusion_pinned", {
        requestId,
        correlationId,
        lead_id: lead.id,
        message_preview: previewText(latestLeadText),
        funnel_state_final: lead.state,
      });
      marcoLog("pipeline_end", {
        requestId,
        correlationId,
        lead_id: lead.id,
        outcome: "buying_confusion_pinned",
        reply_chars: confusionReply.length,
        reply_preview: previewText(confusionReply),
        funnel_state_final: lead.state,
        phone_captured_this_turn: false,
        email_captured_this_turn: false,
      });
      return { lead, reply: confusionReply };
    }
  }

  const phoneInThreadEarly = lead.phone ?? extractPhoneFromConversation(conversation);
  const phoneCapturedThisTurn = !hadPhone && Boolean(phoneInThreadEarly);

  /**
   * Lead insists they already sent their number but nothing was captured (e.g. it came in
   * as a quoted/reply bubble we never received as message text). Never re-ask cold or
   * open with "Got it" here, that reads as not listening. Acknowledge the miss, ask again.
   */
  if (!hadPhone && !phoneCapturedThisTurn && claimsAlreadySentNumber(latestLeadText)) {
    const notReceivedReply = resolveNumberNotReceivedReply(conversation);
    if (notReceivedReply) {
      lead = { ...lead, state: FunnelStage.PhoneRequested };
      await db.appendMessage(lead.id, "assistant", notReceivedReply);
      await db.updateLead(lead);
      marcoLog("number_not_received_pinned", {
        requestId,
        correlationId,
        lead_id: lead.id,
        message_preview: previewText(latestLeadText),
        funnel_state_final: lead.state,
      });
      marcoLog("pipeline_end", {
        requestId,
        correlationId,
        lead_id: lead.id,
        outcome: "number_not_received_pinned",
        reply_chars: notReceivedReply.length,
        reply_preview: previewText(notReceivedReply),
        funnel_state_final: lead.state,
        phone_captured_this_turn: false,
        email_captured_this_turn: false,
      });
      return { lead, reply: notReceivedReply };
    }
  }

  if (
    !hadPhone &&
    !phoneCapturedThisTurn &&
    messageAsksWhatCity(latestLeadText)
  ) {
    /* Collapsed opener: MARCO_CITY_REPLY carries the number ask, so the funnel
       goes where the ask actually points instead of parking in a legacy stage. */
    lead = { ...lead, state: FunnelStage.PhoneRequested };
    await db.appendMessage(lead.id, "assistant", MARCO_CITY_REPLY);
    await db.updateLead(lead);
    marcoLog("pipeline_end", {
      requestId,
      correlationId,
      lead_id: lead.id,
      outcome: "city_pinned",
      reply_chars: MARCO_CITY_REPLY.length,
      reply_preview: previewText(MARCO_CITY_REPLY),
      funnel_state_final: lead.state,
      phone_captured_this_turn: false,
      email_captured_this_turn: false,
    });
    return { lead, reply: MARCO_CITY_REPLY };
  }

  if (
    !hadPhone &&
    !phoneCapturedThisTurn &&
    messageAsksPropertyPriceOrCost(latestLeadText)
  ) {
    /* Collapsed opener: this pinned reply fires before the model on the single most
       common opening question, and it now asks for the number, so advance to match. */
    lead = { ...lead, state: FunnelStage.PhoneRequested };
    await db.appendMessage(lead.id, "assistant", MARCO_PRICE_REPLY);
    await db.updateLead(lead);
    marcoLog("price_reply_pinned", {
      requestId,
      correlationId,
      lead_id: lead.id,
      message_preview: previewText(latestLeadText),
      funnel_state_final: lead.state,
    });
    marcoLog("pipeline_end", {
      requestId,
      correlationId,
      lead_id: lead.id,
      outcome: "price_pinned",
      reply_chars: MARCO_PRICE_REPLY.length,
      reply_preview: previewText(MARCO_PRICE_REPLY),
      funnel_state_final: lead.state,
      phone_captured_this_turn: false,
      email_captured_this_turn: false,
    });
    return { lead, reply: MARCO_PRICE_REPLY };
  }

  /** Bucket F: call-ask escalation (pre-phone only; suppressed after graceful exit). */
  if (!hadPhone && !phoneCapturedThisTurn) {
    const bucketF = resolveCallAskBucketF(conversation, latestLeadText);
    if (bucketF) {
      if (bucketF.kind === "number_ask") {
        lead = { ...lead, state: FunnelStage.PhoneRequested };
      }
      await db.appendMessage(lead.id, "assistant", bucketF.reply);
      await db.updateLead(lead);
      marcoLog("call_ask_bucket_f", {
        requestId,
        correlationId,
        lead_id: lead.id,
        bucket_f_kind: bucketF.kind,
        message_preview: previewText(latestLeadText),
        funnel_state_final: lead.state,
      });
      marcoLog("pipeline_end", {
        requestId,
        correlationId,
        lead_id: lead.id,
        outcome: `call_ask_${bucketF.kind}`,
        reply_chars: bucketF.reply.length,
        reply_preview: previewText(bucketF.reply),
        funnel_state_final: lead.state,
        phone_captured_this_turn: false,
        email_captured_this_turn: false,
      });
      return { lead, reply: bucketF.reply };
    }
  }

  /** Explicit phone refusal (first turn only) — soft apology before LLM escalates. */
  if (
    !hadPhone &&
    !phoneCapturedThisTurn &&
    signalsExplicitPhoneRefusal(latestLeadText) &&
    !threadContainsPhoneRefusalApology(conversation)
  ) {
    lead = { ...lead, state: FunnelStage.PhoneRequested };
    await db.appendMessage(lead.id, "assistant", MARCO_PHONE_REFUSAL_APOLOGY);
    await db.updateLead(lead);
    marcoLog("phone_refusal_apology_pinned", {
      requestId,
      correlationId,
      lead_id: lead.id,
      message_preview: previewText(latestLeadText),
      funnel_state_final: lead.state,
    });
    marcoLog("pipeline_end", {
      requestId,
      correlationId,
      lead_id: lead.id,
      outcome: "phone_refusal_apology",
      reply_chars: MARCO_PHONE_REFUSAL_APOLOGY.length,
      reply_preview: previewText(MARCO_PHONE_REFUSAL_APOLOGY),
      funnel_state_final: lead.state,
      phone_captured_this_turn: false,
      email_captured_this_turn: false,
    });
    return { lead, reply: MARCO_PHONE_REFUSAL_APOLOGY };
  }

  /** Pre-phone: lead agreed to breakdown offer — pinned phone ask (replaces LLM "perfect"). */
  if (
    !hadPhone &&
    !phoneCapturedThisTurn &&
    threadContainsBreakdownOffer(conversation) &&
    signalsAffirmativeBreakdownAgreement(latestLeadText)
  ) {
    lead = { ...lead, state: FunnelStage.PhoneRequested };
    await db.appendMessage(lead.id, "assistant", MARCO_PHONE_ASK_REPLY);
    await db.updateLead(lead);
    marcoLog("phone_ask_reply_pinned", {
      requestId,
      correlationId,
      lead_id: lead.id,
      message_preview: previewText(latestLeadText),
      funnel_state_final: lead.state,
    });
    marcoLog("pipeline_end", {
      requestId,
      correlationId,
      lead_id: lead.id,
      outcome: "phone_ask_pinned",
      reply_chars: MARCO_PHONE_ASK_REPLY.length,
      reply_preview: previewText(MARCO_PHONE_ASK_REPLY),
      funnel_state_final: lead.state,
      phone_captured_this_turn: false,
      email_captured_this_turn: false,
    });
    return { lead, reply: MARCO_PHONE_ASK_REPLY };
  }

  const ackCloseout = resolveAcknowledgmentCloseoutTurn(
    conversation,
    latestLeadText,
    MARCO_CLOSEOUT_REPLY,
    { skipIfPhoneCapturedThisTurn: phoneCapturedThisTurn },
  );
  if (ackCloseout === "silence") {
    marcoLog("ack_closeout_silence", {
      requestId,
      correlationId,
      lead_id: lead.id,
      had_phone: hadPhone,
      message_preview: previewText(latestLeadText),
    });
    await db.updateLead(lead);
    marcoLog("pipeline_end", {
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
    await db.appendMessage(lead.id, "assistant", MARCO_CLOSEOUT_REPLY);
    await db.updateLead(lead);
    marcoLog("ack_closeout_sent", {
      requestId,
      correlationId,
      lead_id: lead.id,
      had_phone: hadPhone,
      message_preview: previewText(latestLeadText),
    });
    marcoLog("pipeline_end", {
      requestId,
      correlationId,
      lead_id: lead.id,
      outcome: "ack_closeout",
      reply_chars: MARCO_CLOSEOUT_REPLY.length,
      reply_preview: previewText(MARCO_CLOSEOUT_REPLY),
      funnel_state_final: lead.state,
      phone_captured_this_turn: false,
      email_captured_this_turn: false,
    });
    return { lead, reply: MARCO_CLOSEOUT_REPLY };
  }

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

  const phoneAskCount = getPhoneRequestCount(conversationHistoryForDup);
  const phoneVariationHint = getPhoneRequestVariation(phoneAskCount);
  const commStyle = detectCommunicationStyle(conversationHistoryForDup);
  const styleInstructions = getCommunicationStyleInstructions(commStyle);

  let coachingNote = preflightRaw.coachingNote.trim();
  const igDmTurn =
    payload.platform.toLowerCase().includes("insta") && payload.commentOrDm === "dm";
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

  if (messageAsksBuilderIdentity(latestLeadText)) {
    coachingNote = [
      coachingNote,
      "BUILDER_GUARD: Lead asked who the builder is. NEVER name or hint the builder or developer. Deflect briefly; steer to a good number for the full breakdown (or west of Stone Oak only if they asked location).",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (signalsLookingOutsideSanAntonio(latestLeadText)) {
    coachingNote = [
      coachingNote,
      "TEXAS_SERVICE_AREA: The lead is looking outside San Antonio or named another Texas area. In Marco's first-person voice: say you help buyers all across Texas, one short sentence, then continue helping with their question or the listing thread. Do not imply you only serve greater San Antonio for that buyer. Never mention a dollar amount or price threshold in this line.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  // Lead mentions their OWN non-Texas city mid-thread on a specific listing
  // they already agreed to receive the breakdown for. This is not a request
  // to buy where they live — never offer the referral-to-another-agent flow
  // here (that derails someone already close to the phone ask). Reassure the
  // HOME's location and keep moving toward the number.
  if (detectOutOfStateLead(latestLeadText).detected && threadContainsBreakdownOffer(conversation)) {
    coachingNote = [
      coachingNote,
      "OUT_OF_STATE_MID_THREAD: The lead just mentioned a non-Texas city or state, but they are already engaged with a specific listing in this thread (breakdown already offered/agreed to). They are NOT asking Marco to find them a home where they live. Do NOT offer to refer them to another agent. In one short sentence, reassure that this home is in Texas, near San Antonio, then continue toward the mobile number ask or answer their actual question.",
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
  if (hadPhone) {
    coachingNote = [
      coachingNote,
      "POST_PHONE_CAPTURE: Mobile number is already on file. Never ask price range, budget, suitability, preferences, timeline, or bedrooms. Answer specific property questions only; do not run needs analysis or re-offer the full breakdown unless they explicitly ask for it again.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (!hadPhone) {
    coachingNote = [
      coachingNote,
      "EMAIL_DELIVERY_FORBIDDEN: A mobile number is the ONLY way to send the breakdown. NEVER promise to send anything by email, NEVER offer email as an alternative, and NEVER agree when the lead asks you to just email it. If the lead insists on email, the ONLY acceptable response is a polite variation of 'My apologies, for this specific property a good number would be best.' Do not say you will email them anything.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  coachingNote = [
    coachingNote,
    styleInstructions,
    `PHONE REQUEST CONTEXT: ${phoneVariationHint}`,
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

  const preflight: PreflightTurnResult = {
    repeatedMessage: leadLineRepeatForModel,
    coachingNote: coachingNote.trim(),
  };

  /** IG/ManyChat often fires twice for one phone (text + contact card). Second hit: no LLM, no duplicate ask. */
  if (leadRepeatedForAdvancement) {
    const phoneInThread = lead.phone ?? extractPhoneFromConversation(conversation);
    if (phoneInThread) {
      if (!lead.phone) {
        lead = { ...lead, phone: phoneInThread, state: FunnelStage.PropertySent };
        const capturedReply = resolvePhoneCapturedReply(conversation);
        await db.appendMessage(lead.id, "assistant", capturedReply);
        await db.updateLead(lead);
        marcoLog("duplicate_user_phone_captured", {
          requestId,
          correlationId,
          lead_id: lead.id,
        });
        marcoLog("pipeline_end", {
          requestId,
          correlationId,
          lead_id: lead.id,
          outcome: "duplicate_user_phone_first_capture",
          reply_chars: capturedReply.length,
          reply_preview: previewText(capturedReply),
          funnel_state_final: lead.state,
          phone_captured_this_turn: true,
          email_captured_this_turn: false,
        });
        return { lead, reply: capturedReply };
      }
      marcoLog("pipeline_end", {
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
    let rawOpeningReply = result.reply;
    if (!lead.phone) {
      const p = extractPhoneFromConversation(conversation);
      if (p) {
        lead = { ...lead, phone: p, state: FunnelStage.PropertySent };
        rawOpeningReply = resolvePhoneCapturedReply(conversation);
        marcoLog("opening_same_turn_phone_capture", {
          requestId,
          correlationId,
          lead_id: lead.id,
        });
      }
    }
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

    if (meta.phoneJustCaptured) {
      reply = resolvePhoneCapturedReply(conversation);
      marcoLog("phone_captured_reply_pinned", {
        requestId,
        correlationId,
        lead_id: lead.id,
        call_ask_path: threadHadCallAskPath(conversation),
        reply_preview: previewText(reply),
      });
    } else if (!skipLlm) {
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
    const freshConv = await db.getConversation(lead.id);
    const trailingAssistants = countTrailingAssistantsAtEnd(freshConv);
    const alreadyReplied = countAssistantsSinceLastUser(freshConv) >= 1;
    const lastRole = freshConv.messages[freshConv.messages.length - 1]?.role;
    if (lastRole !== "user" || alreadyReplied || trailingAssistants >= 2) {
      marcoLog("consecutive_assistant_guard", {
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

