/**
 * Harvey operator — powered by Aethon Intelligence hull.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import {
  appendSessionTurn,
  getOrCreateSessionId,
  getSessionHistory,
  historyToAnthropicMessages,
} from "./memory.js";
import { providerStatus } from "../hull/providers/index.js";
import { tryCaptureNote } from "./noteCapture.js";
import type { HarveyChatResponse } from "./types.js";
import { runAgentLoop } from "../hull/agentLoop.js";
import { runPostConversationExtraction } from "../hull/memory/extraction.js";
import { getAethonModel } from "../hull/modelRouting.js";

export async function runHarveyChat(input: {
  message: string;
  sessionId?: string;
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
    };
  }

  const history = getSessionHistory(sessionId);
  const sessionMemory: MessageParam[] = historyToAnthropicMessages(history);

  let speech: string;
  if (!providerStatus().primary) {
    speech =
      "No model provider is configured. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY on the server.";
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[harvey/chat]", msg);
      speech = `Hit an API error: ${msg}`;
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
  };
}

export function getHarveyModel(): string {
  return getAethonModel();
}

export type { HarveyChatResponse } from "./types.js";
