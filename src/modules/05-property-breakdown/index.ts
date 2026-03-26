/**
 * Module 05: Property Breakdown Generator — specs, features, no address/builder/neighborhood.
 */
import { prompts } from "../../../config/prompts.js";
import type { Conversation, Lead } from "../../core/types.js";
import { FunnelStage } from "../../core/state.js";
import { rewriteReplyWithTone } from "../../integrations/llm/index.js";

export interface ModuleResult {
  lead: Lead;
  reply: string | null;
}

export async function process(lead: Lead, conversation: Conversation): Promise<ModuleResult> {
  // v0: no MLS/MLS integrations yet. We still replicate Marco's next-step script
  // so the DM flow continues immediately after phone capture.
  if (!lead.phone) {
    return { lead, reply: null };
  }

  const prefix = "For sure,";
  const deterministic =
    `${prefix} for that home you inquired about, here’s the breakdown on location, specs, ` +
    `pricing, and a couple of other options in case it’s not the right fit. ` +
    `Was this what you were looking for, or something in a different price range or location?`;

  const rewritten = await rewriteReplyWithTone(
    prompts.propertyBreakdown,
    deterministic,
    conversation,
  );
  const reply = rewritten ?? deterministic;

  return {
    lead: { ...lead, state: FunnelStage.PropertySent },
    reply,
  };
}

