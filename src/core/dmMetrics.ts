import type { Lead, Conversation } from "./types.js";

/** Same definition everywhere: a stored DM conversation with a captured phone. */
export function hasDmPhoneCapture(lead: Pick<Lead, "phone">, conversation: Conversation): boolean {
  return Boolean(lead.phone?.trim() && conversation.messages?.length);
}
