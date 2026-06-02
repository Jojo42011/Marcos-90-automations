/**
 * Harvey operator: chat (direct Claude + tools) and ops (perception → judgment).
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

import { buildHarveyContext, contextToMetricsPanel, type PerceptionDeps } from "./perception.js";
import { runJudgment } from "./judgment.js";
import {
  appendSessionTurn,
  getOrCreateSessionId,
  getSessionHistory,
  historyToAnthropicMessages,
} from "./memory.js";
import { executeHarveyTool, HARVEY_TOOL_DEFINITIONS } from "./tools.js";
import { isAnthropicApiKeyConfigured } from "../integrations/llm/index.js";
import type { HarveyChatResponse, HarveyOpsResponse } from "./types.js";

const HARVEY_MODEL = process.env.HARVEY_MODEL?.trim() || "claude-sonnet-4-20250514";
const MAX_TOOL_ROUNDS = 6;

const HARVEY_SYSTEM_PROMPT = `You are Harvey, an AI operations assistant built for Marco Puga, a real estate agent in San Antonio, Texas operating under Aethon Intelligence.

You have direct access to Marco's live business data through tools. Use them dynamically — if Marco asks about leads, pull the data. If he asks about a specific person, search for them. If he asks what needs attention, get hot leads and stalled leads. You decide which tool fits the question.

Marco's business context:
- Runs Instagram and TikTok DM automation — AI qualifies leads and captures phone numbers
- Two active ad campaigns: Canyon Lake (a $365k 3/2 listing) and Low Interest Rate creative
- Sendblue SMS line: +18184588632 — leads text here after phone is captured in DMs
- Brivity CRM for transaction management
- Funnel stages: new → opening_asked_first_time → opening_offered_details → phone_requested → phone_captured → property_sent → criteria_collected → email_sent
- Hot leads = phone captured but not yet texted on Sendblue

How to talk:
- Ops partner tone — direct, numeric, no filler
- Lead with the number or the answer, explain after if needed
- Short responses unless Marco needs a full breakdown
- Never say "I don't have access to that" — use your tools first
- If you don't know something after checking tools, say so plainly

Reply in plain text only (no JSON wrappers).`;

function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

function extractAssistantText(content: Anthropic.Messages.Message["content"]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts.join("\n\n").trim();
}

async function runHarveyToolRound(
  client: Anthropic,
  messages: MessageParam[],
): Promise<string> {
  let response = await client.messages.create({
    model: HARVEY_MODEL,
    max_tokens: 1024,
    system: HARVEY_SYSTEM_PROMPT,
    messages,
    tools: HARVEY_TOOL_DEFINITIONS,
  });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (response.stop_reason !== "tool_use") {
      const text = extractAssistantText(response.content);
      return text || "No response from Harvey.";
    }

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (tu) => {
        const input =
          tu.input && typeof tu.input === "object" && !Array.isArray(tu.input)
            ? (tu.input as Record<string, unknown>)
            : {};
        let result: unknown;
        try {
          result = await executeHarveyTool(tu.name, input);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = { error: msg };
        }
        return {
          type: "tool_result" as const,
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        };
      }),
    );

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    response = await client.messages.create({
      model: HARVEY_MODEL,
      max_tokens: 1024,
      system: HARVEY_SYSTEM_PROMPT,
      messages,
      tools: HARVEY_TOOL_DEFINITIONS,
    });
  }

  const text = extractAssistantText(response.content);
  return text || "Harvey hit the tool loop limit — try a narrower question.";
}

export async function runHarveyOps(deps: PerceptionDeps): Promise<HarveyOpsResponse> {
  const context = await buildHarveyContext(deps);
  const judgment = runJudgment(context, "");
  return {
    context,
    judgment,
    metrics: contextToMetricsPanel(context),
  };
}

export async function runHarveyChat(input: {
  message: string;
  sessionId?: string;
  deps?: PerceptionDeps;
}): Promise<HarveyChatResponse> {
  const sessionId = getOrCreateSessionId(input.sessionId);
  const trimmed = input.message.trim();
  if (!trimmed) {
    throw new Error("Missing message");
  }

  const history = getSessionHistory(sessionId);
  const sessionMemory = historyToAnthropicMessages(history);

  let speech: string;
  const client = getClient();

  if (!client || !isAnthropicApiKeyConfigured()) {
    speech =
      "Anthropic is offline — set ANTHROPIC_API_KEY in .env for full Harvey with live lead tools.";
  } else {
    const messages: MessageParam[] = [
      ...sessionMemory,
      { role: "user", content: trimmed },
    ];
    try {
      speech = await runHarveyToolRound(client, messages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[harvey/chat]", msg);
      speech = `Hit an API error: ${msg}. Check ANTHROPIC_API_KEY and billing, then try again.`;
    }
  }

  appendSessionTurn(sessionId, "user", trimmed);
  appendSessionTurn(sessionId, "assistant", speech);

  return {
    speech,
    sessionId,
    intent: "general",
    ui: { panel: "ops", action: "none", data: {} },
    directives: [],
    metrics: {
      totalLeads: 0,
      phonesCaptured: 0,
      emailsCaptured: 0,
      instagram: 0,
      tiktok: 0,
      canyonLakeAd: 0,
      lowInterestAd: 0,
      noInteraction: 0,
      hotNeedsSms: 0,
      phoneCaptureRatePct: 0,
      phonesLast24h: 0,
    },
    reply: speech,
  };
}

export function getHarveyModel(): string {
  return HARVEY_MODEL;
}

export type { HarveyChatResponse, HarveyOpsResponse, HarveyDirective } from "./types.js";
