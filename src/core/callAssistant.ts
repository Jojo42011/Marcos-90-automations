/**
 * Real-time call assistant — Claude Sonnet (HARVEY_MODEL) for live dialer support.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

import { getConversation, getLeadById } from "./db.js";
import type { Lead } from "./types.js";
import { getHarveyModel } from "../harvey/index.js";
import { isAnthropicApiKeyConfigured } from "../integrations/llm/index.js";

const CALL_ASSISTANT_SYSTEM = `You are a real-time AI assistant supporting a real estate agent during a live phone call.
The agent needs quick, accurate talking points and answers they can use immediately.
Keep responses SHORT — 2-4 bullet points maximum.
Focus on: market data talking points, objection handling, property details, next steps.
Never suggest anything that would mislead the lead.
Format: bullet points only, no preamble, no explanations.`;

const MARCO_REAL_ESTATE_CONTEXT = `Marco Puga — San Antonio, Texas real estate agent (Aethon Intelligence).
Instagram/TikTok DM automation qualifies leads and captures phones; Twilio SMS follow-up.
Active campaigns: Canyon Lake ($365k 3/2) and low-interest-rate creative.
Funnel: DM → phone capture → property breakdown → criteria → email listings → Brivity CRM.
Hot leads = phone captured, needs timely human follow-up.`;

function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

function extractText(content: Anthropic.Messages.Message["content"]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text.trim()) parts.push(block.text.trim());
  }
  return parts.join("\n").trim();
}

function leadDisplayName(lead: Lead): string {
  return lead.name || lead.username || lead.phone || "Lead";
}

function criteriaSummary(lead: Lead): string {
  const c = lead.criteria;
  if (!c) return "No criteria on file.";
  const bits: string[] = [];
  if (c.priceCap) bits.push(`budget up to $${c.priceCap.toLocaleString()}`);
  if (c.beds) bits.push(`${c.beds} bed`);
  if (c.baths) bits.push(`${c.baths} bath`);
  if (c.area) bits.push(`area: ${c.area}`);
  return bits.length ? bits.join(", ") : "No criteria on file.";
}

export async function buildCallAssistantUserPrompt(
  leadId: string,
  question: string,
  extraContext: string,
): Promise<{ prompt: string; lead: Lead | null }> {
  const lead = await getLeadById(leadId);
  if (!lead) return { prompt: "", lead: null };

  const conv = await getConversation(leadId);
  const recentMsgs = conv.messages.slice(-12).map((m) => `${m.role}: ${m.text}`).join("\n");

  const prompt = `${MARCO_REAL_ESTATE_CONTEXT}

Lead profile:
- Name: ${leadDisplayName(lead)}
- Phone: ${lead.phone || "—"}
- Intent: ${lead.crmIntent || "—"}
- CRM status: ${lead.crmStatus}
- Stage: ${lead.crmStage}
- Source: ${lead.source || "—"}
- Property inquired: ${lead.propertyInquired || "—"}
- Tags: ${(lead.tags || []).join(", ") || "—"}
- Funnel state: ${lead.state}
- Criteria: ${criteriaSummary(lead)}
- Notes: ${lead.crmNotes || "—"}
- Last activity: ${lead.lastActivity || "—"}

Recent conversation:
${recentMsgs || "(no messages yet)"}

Agent context (notes / what lead said):
${extraContext.trim() || "(none)"}

Agent question:
${question.trim()}`;

  return { prompt, lead };
}

export async function runCallAssistantSuggest(input: {
  leadId: string;
  question: string;
  context: string;
}): Promise<{ suggestions: string; leadId: string; timestamp: string }> {
  const { prompt, lead } = await buildCallAssistantUserPrompt(input.leadId, input.question, input.context);
  if (!lead) throw new Error("Lead not found");

  const timestamp = new Date().toISOString();
  if (!isAnthropicApiKeyConfigured()) {
    return {
      suggestions:
        "• Confirm their timeline and preferred areas\n• Reference Canyon Lake or similar inventory if relevant\n• Offer to email curated listings after the call",
      leadId: input.leadId,
      timestamp,
    };
  }

  const client = getClient();
  if (!client) {
    return {
      suggestions: "• API key not configured — use your standard opener and ask for timeline",
      leadId: input.leadId,
      timestamp,
    };
  }

  const response = await client.messages.create({
    model: getHarveyModel(),
    max_tokens: 400,
    system: CALL_ASSISTANT_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });

  const suggestions = extractText(response.content) || "• No suggestions generated.";
  return { suggestions, leadId: input.leadId, timestamp };
}

/** Yield words for SSE / WebSocket streaming. */
export async function* streamCallAssistantWords(input: {
  leadId: string;
  question: string;
  context: string;
}): AsyncGenerator<string> {
  const result = await runCallAssistantSuggest(input);
  const words = result.suggestions.split(/(\s+)/);
  for (const w of words) {
    if (w) yield w;
  }
}
