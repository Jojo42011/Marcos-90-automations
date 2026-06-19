/**
 * Harvey operator — powered by Aethon Intelligence hull.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { buildHarveyContext, contextToMetricsPanel, type PerceptionDeps } from "./perception.js";
import { runJudgment } from "./judgment.js";
import {
  appendSessionTurn,
  getOrCreateSessionId,
  getSessionHistory,
  historyToAnthropicMessages,
} from "./memory.js";
import { isAnthropicApiKeyConfigured } from "../integrations/llm/index.js";
import { tryCaptureNote } from "./noteCapture.js";
import {
  inferPanelFromMessage,
  panelResultToUi,
} from "./panelNormalizer.js";
import type { HarveyChatResponse, HarveyOpsResponse, HarveyUiPayload } from "./types.js";
import { runAgentLoop } from "../hull/agentLoop.js";
import { runPostConversationExtraction } from "../hull/memory/extraction.js";
import { getAethonModel } from "../hull/modelRouting.js";
import { executeHullTool } from "../hull/tools.js";

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
  voiceMode?: boolean;
}): Promise<HarveyChatResponse> {
  const sessionId = getOrCreateSessionId(input.sessionId);
  const trimmed = input.message.trim();
  if (!trimmed) throw new Error("Missing message");

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
      metrics: emptyMetrics(),
      reply: speech,
    };
  }

  const history = getSessionHistory(sessionId);
  const sessionMemory: MessageParam[] = historyToAnthropicMessages(history);
  const inferredPanel = inferPanelFromMessage(trimmed);
  let ui: HarveyUiPayload = { panel: "ops", action: "none", data: {} };

  let speech: string;
  if (!isAnthropicApiKeyConfigured()) {
    speech =
      "Anthropic is offline — set ANTHROPIC_API_KEY in .env for full Harvey with live lead tools.";
    const inferredUi = panelResultToUi(inferredPanel);
    if (inferredUi) ui = inferredUi;
  } else {
    try {
      const result = await runAgentLoop({
        message: trimmed,
        history: sessionMemory,
        voiceMode: input.voiceMode,
      });
      speech = result.speech;
      const inferredUi = panelResultToUi(inferredPanel);
      if (inferredUi) ui = inferredUi;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[harvey/chat]", msg);
      speech = `Hit an API error: ${msg}`;
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
  void runPostConversationExtraction(sessionId, episodeTurns);

  return {
    speech,
    sessionId,
    intent: "general",
    ui,
    directives: [],
    metrics: emptyMetrics(),
    reply: speech,
  };
}

function emptyMetrics() {
  return {
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
  };
}

export function getHarveyModel(): string {
  return getAethonModel();
}

export type { HarveyChatResponse, HarveyOpsResponse, HarveyDirective } from "./types.js";

/** Voice / server tool execution — hull tool surface. */
export async function runHarveyTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  return executeHullTool(name, input);
}
