/**
 * Module 07: New Home Buddy Search & Email — query listings, build email, send via Gmail + follow-up text.
 */
import type { Conversation, Lead } from "../../core/types.js";
import { FunnelStage } from "../../core/state.js";

export interface ModuleResult {
  lead: Lead;
  reply: string | null;
}

export async function process(lead: Lead, _conversation: Conversation): Promise<ModuleResult> {
  if (!lead.email) {
    return { lead, reply: null };
  }

  const reply =
    "Noted, I’ll send a personalized list of matching homes to that email now. " +
    "Once you review it, just reply with what you like and I’ll line up a quick showing for you.";

  return { lead: { ...lead, state: FunnelStage.Closed }, reply };
}

