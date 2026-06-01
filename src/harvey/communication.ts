/**
 * Harvey communication — Sonnet operator voice + structured response.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type { HarveyContext, HarveyChatResponse, JudgmentResult } from "./types.js";
import { contextToMetricsPanel } from "./perception.js";
import type { HarveyMemoryTurn } from "./types.js";
import { historyToAnthropicMessages } from "./memory.js";

const HARVEY_MODEL =
  process.env.HARVEY_MODEL?.trim() || "claude-sonnet-4-20250514";

const REAL_ESTATE_KB = `
MARCO OPERATIONS KNOWLEDGE (static):
- Market: San Antonio TX. New construction buyers often 600k+; Marco's own listings (e.g. Canyon Lake) can be lower.
- DM funnel: comment → DM → qualify → first-time buyer (FTB) question → breakdown offer → phone capture → SMS breakdown end of day (not instant).
- Sendblue SMS is inbound-first: lead should text Marco's Sendblue line before outbound works reliably.
- Canyon Lake listing: Marco's listing ~$365k, 3/2, goal is showing or call close. adCampaign tag: canyon_lake_ad.
- Low interest rate ad: financing-focused creative. adCampaign tag: low_interest_ad.
- West of Stone Oak = new construction reference area in DM (do not over-disclose builder in DM).
- VA loans, FTB buyers, casita questions are common lead types.
- TikTok historically converts faster than Instagram in this stack.
- Primary metric: phone capture rate. Phone on file = hot; no phone = cold.
- Brivity = external CRM; sync can error. Aethon Intelligence (Jahan) runs the automation for Marco.
- Marco phone: 210-801-2380.
`.trim();

const IDENTITY_RULES = `
You are Harvey — the AI operator for Marco Puga's real estate business (Aethon Intelligence).
You are NOT a chatbot or assistant. You are a sharp, concise business partner who knows this operation deeply.

VOICE (strict):
- 2-3 sentences max unless Marco asks for a full briefing.
- No "I'd be happy to", "certainly", "as an AI", or corporate filler.
- Use exact numbers from HARVEY_CONTEXT and JUDGMENT — never vague "your leads".
- Phone captured = hot. No phone = cold.
- Distinguish Instagram vs TikTok behavior when relevant.
- Know Canyon Lake ad vs low interest ad attribution.
- Know Sendblue inbound-first constraint.
- Know funnel stage names (opening_asked_first_time, phone_requested, phone_captured, etc.).
- Lead with the most actionable insight first when asked about performance.
- Do not repeat the same briefing you already gave this session (see SESSION_HISTORY).
- If nothing material changed, say so in one line.

OUTPUT: Reply with ONLY valid JSON (no markdown fences):
{
  "speech": "string — what Harvey says to Marco",
  "intent": "briefing|hot_leads|ads|funnel|calls|general",
  "ui": { "panel": "ops|leads|ads|calls", "action": "none|review_queue", "data": {} }
}
`.trim();

function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

function fallbackResponse(
  ctx: HarveyContext,
  judgment: JudgmentResult,
  sessionId: string,
): HarveyChatResponse {
  const speech = `${judgment.briefingSeed} Anthropic is offline — set ANTHROPIC_API_KEY for full Harvey.`;
  return {
    speech,
    intent: "briefing",
    ui: { panel: "ops", action: "none", data: {} },
    directives: judgment.directives,
    sessionId,
    metrics: contextToMetricsPanel(ctx),
    reply: speech,
  };
}

function parseHarveyJson(raw: string): Partial<HarveyChatResponse> | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Partial<HarveyChatResponse>;
  } catch {
    return null;
  }
}

export async function runCommunication(input: {
  ctx: HarveyContext;
  judgment: JudgmentResult;
  operatorMessage: string;
  history: HarveyMemoryTurn[];
  sessionId: string;
}): Promise<HarveyChatResponse> {
  const client = getClient();
  if (!client) {
    return fallbackResponse(input.ctx, input.judgment, input.sessionId);
  }

  const system = [
    IDENTITY_RULES,
    REAL_ESTATE_KB,
    `HARVEY_CONTEXT:\n${JSON.stringify(input.ctx, null, 2)}`,
    `JUDGMENT:\n${JSON.stringify(
      {
        focus: input.judgment.focus,
        directives: input.judgment.directives,
        briefingSeed: input.judgment.briefingSeed,
      },
      null,
      2,
    )}`,
  ].join("\n\n");

  const historyMsgs = historyToAnthropicMessages(input.history);
  const messages: Anthropic.MessageParam[] = [
    ...historyMsgs,
    {
      role: "user",
      content: `Marco says: ${input.operatorMessage}\n\nRespond in JSON only.`,
    },
  ];

  try {
    const response = await client.messages.create({
      model: HARVEY_MODEL,
      max_tokens: 1024,
      system,
      messages,
    });
    const block = response.content[0];
    const text = block.type === "text" ? block.text : "";
    const parsed = parseHarveyJson(text);
    const speech =
      typeof parsed?.speech === "string" && parsed.speech.trim()
        ? parsed.speech.trim()
        : text.trim() || input.judgment.briefingSeed;
    const intent =
      typeof parsed?.intent === "string" && parsed.intent.trim()
        ? parsed.intent.trim()
        : "general";
    const ui = parsed?.ui &&
      typeof parsed.ui === "object" &&
      parsed.ui !== null &&
      !Array.isArray(parsed.ui)
      ? {
          panel: String((parsed.ui as { panel?: string }).panel || "ops"),
          action: String((parsed.ui as { action?: string }).action || "none"),
          data:
            (parsed.ui as { data?: Record<string, unknown> }).data &&
            typeof (parsed.ui as { data?: Record<string, unknown> }).data === "object"
              ? ((parsed.ui as { data?: Record<string, unknown> }).data as Record<string, unknown>)
              : {},
        }
      : { panel: "ops", action: "none", data: {} };

    return {
      speech,
      intent,
      ui,
      directives: input.judgment.directives,
      sessionId: input.sessionId,
      metrics: contextToMetricsPanel(input.ctx),
      reply: speech,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[harvey/communication]", msg);
    const speech = `Hit an API error: ${msg}. ${input.judgment.briefingSeed}`;
    return {
      speech,
      intent: "error",
      ui: { panel: "ops", action: "none", data: { error: msg } },
      directives: input.judgment.directives,
      sessionId: input.sessionId,
      metrics: contextToMetricsPanel(input.ctx),
      reply: speech,
    };
  }
}

export function getHarveyModel(): string {
  return HARVEY_MODEL;
}
