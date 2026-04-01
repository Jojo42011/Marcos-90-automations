import { syncLead } from "../../integrations/brivity.js";
import type { Conversation, Lead } from "../../core/types.js";

export async function process(
  lead: Lead,
  _conversation: Conversation,
): Promise<{ lead: Lead; reply: string | null }> {
  try {
    await syncLead(lead);
  } catch (error) {
    // Never break DM pipeline on CRM sync failure.
    console.error("[Module08] Brivity sync failed:", error);
  }
  return { lead, reply: null };
}

