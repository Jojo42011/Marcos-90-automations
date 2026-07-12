/**
 * Run modules in order by lead state. Single entry for webhook-driven flow.
 */
import * as db from "../core/db.js";
import type { Conversation, IncomingWebhookPayload, Lead } from "../core/types.js";
import { FunnelStage } from "../core/state.js";
import { process as toneMatchedProcess } from "../modules/03-tone-matched-dm/index.js";
import { process as commentDmMonitorProcess } from "../modules/01-comment-dm-monitor/index.js";
import { process as brivitySyncProcess } from "../modules/08-brivity-auto-sync/index.js";
import {
  classifyNewLeadBuyingIntent,
  generateMarcoPipelineReply,
  preflightLeadTurnReview,
  type PreflightTurnResult,
} from "../integrations/llm/index.js";
import { advanceFunnelDeterministic } from "./funnelDeterministic.js";
import {
  isAmbiguousPropertyReference,
  isLastUserMessageRepeated,
  isShortDuplicateUserPair,
} from "./conversationUtils.js";

export interface PipelineResult {
  reply: string | null;
  /** Null when a brand-new contact failed the buyer-intent gate (no lead created). */
  lead: Lead | null;
}

export async function run(payload: IncomingWebhookPayload): Promise<PipelineResult> {
  let lead = await db.getLead(payload.platform, payload.userId);
  if (!lead) {
    // Ambiguous listing fragments ("Stone") fail the strict intent gate but are real
    // inquiries in production — let them through so module 03 can ask for a screenshot.
    const interested =
      isAmbiguousPropertyReference(payload.message) ||
      (await classifyNewLeadBuyingIntent(payload.message));
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
      state: FunnelStage.New,
      source: payload.platform,
      propertyInquired: null,
      criteria: null,
      brivityId: null,
    });
  }

  await db.appendMessage(lead.id, "user", payload.message);
  const conversation: Conversation = await db.getConversation(lead.id);
  const hadPhone = Boolean(lead.phone);
  const hadEmail = Boolean(lead.email);

  const userTurnCount = conversation.messages.filter((m) => m.role === "user").length;
  const preflightRaw: PreflightTurnResult =
    userTurnCount >= 2
      ? await preflightLeadTurnReview({ conversation, leadState: lead.state })
      : { repeatedMessage: false, coachingNote: "" };

  const deterministicRepeat = isLastUserMessageRepeated(conversation);
  const shortDup = isShortDuplicateUserPair(conversation);
  const treatAsRepeat = deterministicRepeat || (preflightRaw.repeatedMessage && !shortDup);

  let coachingNote = preflightRaw.coachingNote;
  if (treatAsRepeat && !coachingNote.trim()) {
    coachingNote =
      "The lead may have repeated the same message; acknowledge briefly, stay on the current funnel step, and do not restart from the beginning. Do not repeat or closely mirror Marco's earlier outbound. Keep it casual like a real text, especially on phone resistance. If the latest lead tone is resistant or negative, avoid upbeat affirmations and match their sentiment. Keep moving naturally through Marco's flow: value first, then agent context, then number ask.";
  }

  const preflight: PreflightTurnResult = {
    repeatedMessage: treatAsRepeat,
    coachingNote: treatAsRepeat ? coachingNote : "",
  };

  let reply: string | null = null;

  if (
    lead.state === FunnelStage.New ||
    lead.state === FunnelStage.ListingClarificationRequested ||
    lead.state === FunnelStage.OpeningAskedFirstTime ||
    lead.state === FunnelStage.OpeningOfferedDetails
  ) {
    lead = (await commentDmMonitorProcess(lead, conversation)).lead;
    const result = await toneMatchedProcess(lead, conversation, {
      treatAsRepeat,
      coachingNote: preflight.coachingNote,
    });
    lead = result.lead;
    reply = result.reply;
  } else if (
    lead.state === FunnelStage.PhoneRequested ||
    lead.state === FunnelStage.PropertySent ||
    lead.state === FunnelStage.CriteriaCollected ||
    lead.state === FunnelStage.EmailSent
  ) {
    const { lead: advanced, meta } = advanceFunnelDeterministic(lead, conversation);
    lead = advanced;

    const skipLlm =
      lead.state === FunnelStage.Closed && !meta.phoneJustCaptured && !meta.listSendPromised;

    if (!skipLlm) {
      reply = await generateMarcoPipelineReply({ lead, conversation, meta, preflight });
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
  return { lead, reply };
}

