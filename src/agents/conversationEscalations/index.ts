import { sendMarcoAlertSms } from "../escalations/index.js";
import type { Lead } from "../../core/types.js";
import type { ConversationEscalationTrigger } from "../../core/types.js";

export type EscalationTrigger = ConversationEscalationTrigger;

export interface ConversationEscalationResult {
  triggered: boolean;
  type?: EscalationTrigger;
  holdMessage?: string;
  stopAutomation: boolean;
}

const OFFER_PATTERNS =
  /\b(i want to make an offer|let'?s make an offer|ready to (make an )?offer|want to put in an offer|i'?ll take it|let'?s do it|i want to buy this|put in an offer|submit an offer)\b/i;

const ANGRY_PATTERNS =
  /\b(this is ridiculous|i'?m (so |really )?(angry|upset|frustrated|pissed)|terrible service|waste of (my )?time|never responding|unacceptable|done with this|fed up|sick of|worst experience)\b/i;

const LEGAL_PATTERNS =
  /\b(is this legal|legal advice|lawsuit|sue|attorney|lawyer|contract dispute|breach of contract|earnest money dispute|title issue|liens?|disclosure (law|requirement)|fair housing|discriminat)\b/i;

const EMPATHY_HOLD_MESSAGE =
  "I completely understand your frustration, and I want to make sure this gets handled right — " +
  "I'm pulling Marco in personally to take a look and get back to you as soon as possible. Thanks for your patience.";

const ESCALATION_LABELS: Record<EscalationTrigger, string> = {
  ready_to_offer: "🔥 READY TO OFFER",
  angry_client: "⚠️ ANGRY CLIENT",
  legal_question: "⚖️ LEGAL QUESTION",
};

export function detectConversationEscalation(message: string): ConversationEscalationResult {
  if (OFFER_PATTERNS.test(message)) {
    return { triggered: true, type: "ready_to_offer", stopAutomation: true };
  }

  if (ANGRY_PATTERNS.test(message)) {
    return {
      triggered: true,
      type: "angry_client",
      holdMessage: EMPATHY_HOLD_MESSAGE,
      stopAutomation: true,
    };
  }

  if (LEGAL_PATTERNS.test(message)) {
    return { triggered: true, type: "legal_question", stopAutomation: true };
  }

  return { triggered: false, stopAutomation: false };
}

export async function notifyMarcoOfConversationEscalation(
  lead: Lead,
  type: EscalationTrigger,
  message: string,
): Promise<void> {
  const leadName = lead.name || lead.username || "Unknown lead";
  const alertMessage = `${ESCALATION_LABELS[type]}: ${leadName} (${lead.phone}) said: "${message.substring(0, 150)}". Automation paused — respond directly.`;

  const ok = await sendMarcoAlertSms(alertMessage);
  if (ok) {
    console.log("[ConvEscalation] Alerted Marco —", type, "for lead", lead.id);
  }
}
