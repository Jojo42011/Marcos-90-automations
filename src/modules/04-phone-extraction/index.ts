/**
 * Module 04: Phone number — Marco’s second-line ask + short deflection if they push price/address first.
 */
import { prompts } from "../../../config/prompts.js";
import type { Conversation, Lead, Message } from "../../core/types.js";
import { FunnelStage } from "../../core/state.js";
import { messageAsksListingLocation } from "../../app/conversationUtils.js";
import { rewriteReplyWithTone } from "../../integrations/llm/index.js";
import { extractPhone as extractPhoneDeterministic } from "../../app/funnelDeterministic.js";

export interface ModuleResult {
  lead: Lead;
  reply: string | null;
}

function getLastUserMessage(conversation: Conversation): Message | null {
  const reversed = [...conversation.messages].reverse();
  return reversed.find((m) => m.role === "user") ?? null;
}

const extractPhone = extractPhoneDeterministic;

const PHONE_ASK = "Would there be a good number I could send all this info over to?";

/** Lead is pushing back on sharing a phone number (stay in PhoneRequested). */
function isPhoneResistance(text: string): boolean {
  const t = text.toLowerCase();
  if (/don't want to|dont want to|do not want to/.test(t)) return true;
  if ((/won't give|wont give|not giving/.test(t)) && /(number|phone)/.test(t)) {
    return true;
  }
  if (/can you send (it )?(here|in (the )?dm|in chat)/.test(t)) return true;
  if (/\bjust send (it|them|the info|everything)\b/.test(t)) return true;
  if (/why do you need (my |a )?(phone|number)/.test(t)) return true;
  if (/can't you just|cant you just/.test(t)) return true;
  if (/\b(send (it )?here|in (the )?dm only|keep it (in )?dm)\b/.test(t)) return true;
  if (/\b(no number|not comfortable (with )?(sharing|giving))/.test(t)) return true;
  return false;
}

/** Lead agreed to breakdown / next step without giving a number yet. */
function isAffirmativeOnly(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (extractPhone(text)) return false;
  return (
    /^(yes|yeah|yep|yup|sure|ok|okay|please|that would be (great|awesome|helpful)|sounds good|absolutely|definitely)\b/.test(
      t,
    ) || /^(yes|yeah|sure)[!.]*$/.test(t)
  );
}

export async function process(lead: Lead, conversation: Conversation): Promise<ModuleResult> {
  const last = getLastUserMessage(conversation);
  if (!last) {
    return { lead, reply: null };
  }

  if (lead.phone) {
    return { lead, reply: null };
  }

  const maybePhone = extractPhone(last.text);
  if (maybePhone) {
    const updatedLead: Lead = {
      ...lead,
      phone: maybePhone,
      state: FunnelStage.PhoneCaptured,
    };
    const reply = "Noted, I'll send everything over to that number.";
    return { lead: updatedLead, reply };
  }

  const lower = last.text.toLowerCase();

  // Location ask: only approved area hint, then pivot to number for full details.
  if (messageAsksListingLocation(last.text)) {
    const reply =
      "It's west of Stone Oak. If you want the full breakdown with specs and pricing, what's a good number I can text it to?";
    return {
      lead: { ...lead, state: FunnelStage.PhoneRequested },
      reply,
    };
  }

  // Still pushing price here — short deflection only (no "prioritize my time" lecture).
  if (/\b(price|how much|what.?s the (price|cost))\b/.test(lower)) {
    const reply =
      "For this property, a number works best so I can send the full breakdown with pricing.";
    return {
      lead: { ...lead, state: FunnelStage.PhoneRequested },
      reply,
    };
  }

  if (isPhoneResistance(last.text)) {
    const deterministicResistance =
      "I totally get being cautious. For this property, the easiest way is if I text the full breakdown with pricing to you. What number should I text it to?";
    const rewritten = await rewriteReplyWithTone(
      prompts.phoneResistance,
      deterministicResistance,
      conversation,
    );
    const reply = rewritten ?? PHONE_ASK;
    return {
      lead: { ...lead, state: FunnelStage.PhoneRequested },
      reply,
    };
  }

  if (isAffirmativeOnly(last.text)) {
    return {
      lead: { ...lead, state: FunnelStage.PhoneRequested },
      reply: PHONE_ASK,
    };
  }

  return {
    lead: { ...lead, state: FunnelStage.PhoneRequested },
    reply: PHONE_ASK,
  };
}

