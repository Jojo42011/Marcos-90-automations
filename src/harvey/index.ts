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
import { createEpisode } from "./memory/episodes.js";
import { formatMemoriesForPrompt, retrieveMemories } from "./memory/retrieval.js";
import {
  inferPanelFromMessage,
  normalizeToolResult,
  panelResultToUi,
  type PanelResult,
} from "./panelNormalizer.js";
import { tryCaptureNote } from "./noteCapture.js";
import { getLatestContentDigest } from "../agents/harveyContentDigest/index.js";
import type { HarveyChatResponse, HarveyOpsResponse, HarveyUiPayload } from "./types.js";

const HARVEY_MODEL = process.env.HARVEY_MODEL?.trim() || "claude-sonnet-4-20250514";
const MAX_TOOL_ROUNDS = 6;

const HARVEY_SYSTEM_PROMPT = `You are Harvey, an AI operations assistant built for Marco Puga, a real estate agent in San Antonio, Texas operating under Aethon Intelligence.

You have direct access to Marco's live business data through tools. Use them dynamically — if Marco asks about leads, pull the data. If he asks about a specific person, search for them. If he asks what needs attention, get hot leads and stalled leads. You decide which tool fits the question.

Marco's business context:
- Runs Instagram and TikTok DM automation — AI qualifies leads and captures phone numbers
- Two active ad campaigns: Canyon Lake (a $365k 3/2 listing) and Low Interest Rate creative
- Twilio SMS line — leads text Marco's Twilio number after phone is captured in DMs
- Brivity CRM for transaction management
- Funnel stages: new → opening_asked_first_time → opening_offered_details → phone_requested → phone_captured → property_sent → criteria_collected → email_sent
- Hot leads = phone captured but not yet texted via SMS

How to talk:
- Ops partner tone — direct, numeric, no filler
- Lead with the number or the answer, explain after if needed
- Short responses unless Marco needs a full breakdown
- Never say "I don't have access to that" — use your tools first
- If you don't know something after checking tools, say so plainly

Reply in plain text only (no JSON wrappers).

MARCO'S NUMBERS (answer from these when asked):
$20M Goal by Nov 30 2026: $5.96M banked (29.8%), $14.04M gap, 14 deals, avg $425K/deal
Daily targets: 7 videos + 725 calls
TikTok funnel (strategic context — historical conversion math, NOT current live views): 246K views → 1,359 comments → 272 DMs → 136 phones → 7 consults → 1 closing
At 5 vids/week = 1 closing/8wks. Need 10.3 vids/week for monthly closing.
Mojo (Jan-May 2026): 26,938 calls → 846 contacts → 4 closings, 1 contact per 32 calls
Mojo funnel: 6,734 calls → 212 contacts → 9 consults → 1 closing
Cold calling is 36x more efficient per touch than TikTok

TIKTOK LIVE PERFORMANCE (always use get_social_summary — never hardcoded numbers):
When Marco asks about TikTok performance, views, followers, content, videos, or social media stats — ALWAYS call get_social_summary first.
If he asks about specific videos or wants a list — call get_social_videos.
Do NOT use any hardcoded historical performance numbers (e.g. 5,957 avg views, 738K total views) — those are stale. Live data from Apify is always more accurate.
When get_social_summary returns data, cite the exact numbers from the tool result: stats.avgViewsPerVideo, profile.followers, stats.videosTracked, stats.totalViews. Never round or estimate — report them exactly as returned.
When discussing content performance, lead with tool numbers first, then pattern insight from contentPatterns, then a specific actionable recommendation.`;

function buildContentDigestContext(): string {
  const digest = getLatestContentDigest();
  if (!digest) return "";

  const digestAge = Date.now() - new Date(digest.generatedAt).getTime();
  const isRecent = digestAge < 6 * 60 * 60 * 1000;

  if (!isRecent) {
    return `[CONTENT DIGEST — use get_content_digest if Marco asks about overall content performance]\n${digest.summary}`;
  }

  return `[NEW CONTENT DIGEST — generated in the last 6 hours. If Marco asks how things are going or starts a casual conversation, you may briefly mention this update when relevant — do not force it every time]\n${digest.summary}`;
}

function buildHarveySystemPrompt(): string {
  const digestContext = buildContentDigestContext();
  if (!digestContext) return HARVEY_SYSTEM_PROMPT;
  return `${HARVEY_SYSTEM_PROMPT}\n\n${digestContext}`;
}

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
  systemPrompt: string,
): Promise<{ speech: string; panel: PanelResult }> {
  let lastPanel: PanelResult = null;
  let response = await client.messages.create({
    model: HARVEY_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
    tools: HARVEY_TOOL_DEFINITIONS,
  });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (response.stop_reason !== "tool_use") {
      const text = extractAssistantText(response.content);
      return { speech: text || "No response from Harvey.", panel: lastPanel };
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
        const normalized = normalizeToolResult(tu.name, result);
        if (normalized) lastPanel = normalized;
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
      system: systemPrompt,
      messages,
      tools: HARVEY_TOOL_DEFINITIONS,
    });
  }

  const text = extractAssistantText(response.content);
  return {
    speech: text || "Harvey hit the tool loop limit — try a narrower question.",
    panel: lastPanel,
  };
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

  const capturedNote = tryCaptureNote(trimmed, "text");
  if (capturedNote) {
    const speech = "Got it — I've saved that note.";
    appendSessionTurn(sessionId, "user", trimmed);
    appendSessionTurn(sessionId, "assistant", speech);
    return {
      speech,
      sessionId,
      intent: "general",
      ui: { panel: "note_saved", action: "open", data: { note: capturedNote } },
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

  const history = getSessionHistory(sessionId);
  const sessionMemory = historyToAnthropicMessages(history);

  const memories = retrieveMemories(trimmed);
  const memoryContext = formatMemoriesForPrompt(memories);
  const baseSystem = buildHarveySystemPrompt();
  const systemWithMemory = memoryContext
    ? `${baseSystem}\n\n[RECALLED MEMORY]\n${memoryContext}`
    : baseSystem;

  let speech: string;
  let ui: HarveyUiPayload = { panel: "ops", action: "none", data: {} };
  const client = getClient();
  const inferredPanel = inferPanelFromMessage(trimmed);

  if (!client || !isAnthropicApiKeyConfigured()) {
    speech =
      "Anthropic is offline — set ANTHROPIC_API_KEY in .env for full Harvey with live lead tools.";
    const inferredUi = panelResultToUi(inferredPanel);
    if (inferredUi) ui = inferredUi;
  } else {
    const userContent = memoryContext
      ? `[HARVEY MEMORY]\n${memoryContext}\n\n[USER MESSAGE]\n${trimmed}`
      : trimmed;
    const messages: MessageParam[] = [
      ...sessionMemory,
      { role: "user", content: userContent },
    ];
    try {
      const round = await runHarveyToolRound(client, messages, systemWithMemory);
      speech = round.speech;
      const toolUi = panelResultToUi(round.panel);
      const messageUi = panelResultToUi(inferredPanel);
      if (toolUi) ui = toolUi;
      else if (messageUi) ui = messageUi;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[harvey/chat]", msg);
      speech = `Hit an API error: ${msg}. Check ANTHROPIC_API_KEY and billing, then try again.`;
      const inferredUi = panelResultToUi(inferredPanel);
      if (inferredUi) ui = inferredUi;
    }
  }

  appendSessionTurn(sessionId, "user", trimmed);
  appendSessionTurn(sessionId, "assistant", speech);

  const episodeTurns = [
    ...history.map((t) => ({ role: t.role, text: t.content })),
    { role: "user", text: trimmed },
    { role: "assistant", text: speech },
  ];
  void createEpisode(sessionId, episodeTurns);

  return {
    speech,
    sessionId,
    intent: "general",
    ui,
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
