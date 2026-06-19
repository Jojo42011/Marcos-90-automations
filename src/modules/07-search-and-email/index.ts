/**
 * Module 07: New Home Buddy Search & Email — query listings, build email, send via Gmail + follow-up text.
 */
import type { Conversation, Lead } from "../../core/types.js";
import { FunnelStage } from "../../core/state.js";
import { isGmailConfigured, sendPropertyEmail } from "../../integrations/gmail/index.js";

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

  if (isGmailConfigured()) {
    const name = lead.name || lead.username || "there";
    try {
      await sendPropertyEmail(
        lead.email,
        "Homes matching what you're looking for — Marco Puga",
        `<p>Hi ${name},</p><p>Thanks for reaching out. I'm putting together a personalized list of homes that match what you described and will follow up shortly with specific options.</p><p>Marco Puga<br>San Antonio Real Estate</p>`,
      );
    } catch (err) {
      console.error("[module07] Gmail send failed:", err instanceof Error ? err.message : err);
    }
  }

  return { lead: { ...lead, state: FunnelStage.Closed }, reply };
}

