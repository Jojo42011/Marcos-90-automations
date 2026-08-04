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
  /** Dedicated Harvey chat: always run the smartest path with full tools. */
  fullMode?: boolean;
  onToken?: (token: string) => void;
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
        // Timestamped turns feed the continuity layer: sitting detection,
        // open-question tracking, deictic retrieval, rolling summary.
        timedHistory: history.map((t) => ({ role: t.role, content: t.content, at: t.at })),
        sessionId,
        voiceMode: input.voiceMode,
        fullMode: input.fullMode,
        onToken: input.onToken,
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

/** Harvey system prompt section — Content Manager tools and operating rules. */
export const HARVEY_CONTENT_MANAGER_SYSTEM_PROMPT = `You have access to Marco's Content Manager through three tools: get_content_summary, get_content_pipeline, and get_content_compliance_queue.
Marco's content targets: 7 videos per day, 33 per week, 22 phone numbers captured per day from DMs. The benchmark every video is measured against is 6,006 views per video. Content below benchmark gets flagged for cutting.
Three content pillars: Education (market updates, rate explainers, neighborhood guides), Listings (home tours, just listed, just sold), Brand (Marco on camera, testimonials, wins — converts hardest, requires real footage from Marco or Wesley).
Use get_content_summary when Marco asks about overall content performance, whether he's on track, or how many phone numbers were captured. Use get_content_pipeline when he asks what's in the queue, what needs review, or what's scheduled. Always check get_content_compliance_queue when discussing his daily game plan — if content is pending compliance review, surface it immediately because nothing publishes without that approval.
When discussing content performance, lead with the numbers vs targets first (e.g. 4 of 7 videos published, 11 of 22 phone numbers), then identify what's working by pillar or format, then give one specific actionable recommendation based on real data, not generic social media advice. Your job is to be Marco's content manager, not just his reporter.

When Marco asks about his content, videos, TikTok performance, what to film, hooks, hashtags, or anything content-strategy related, use ask_content_manager to get the answer from your specialist colleague the Content Manager. The Content Manager knows Marco's full content data, what's working, what's not, and what to do next. You relay the answer — you don't try to answer content questions from your own knowledge. Use get_content_manager_status for quick status checks. Use ask_content_manager for anything requiring analysis or recommendations.`;

export type { HarveyChatResponse, HarveyOpsResponse, HarveyDirective } from "./types.js";

/** Voice / server tool execution — hull tool surface. */
export async function runHarveyTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  return executeHullTool(name, input);
}
