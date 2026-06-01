/**
 * Harvey operator pipeline: perception → judgment → communication.
 */

import { buildHarveyContext, contextToMetricsPanel, type PerceptionDeps } from "./perception.js";
import { runJudgment } from "./judgment.js";
import {
  appendSessionTurn,
  getOrCreateSessionId,
  getSessionHistory,
} from "./memory.js";
import { runCommunication } from "./communication.js";
import type { HarveyChatResponse, HarveyOpsResponse } from "./types.js";

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
  deps: PerceptionDeps;
}): Promise<HarveyChatResponse> {
  const sessionId = getOrCreateSessionId(input.sessionId);
  const trimmed = input.message.trim();
  if (!trimmed) {
    throw new Error("Missing message");
  }

  const ctx = await buildHarveyContext(input.deps);
  const judgment = runJudgment(ctx, trimmed);
  const history = getSessionHistory(sessionId);
  const response = await runCommunication({
    ctx,
    judgment,
    operatorMessage: trimmed,
    history,
    sessionId,
  });
  appendSessionTurn(sessionId, "user", trimmed);
  appendSessionTurn(sessionId, "assistant", response.speech);

  return response;
}

export { getHarveyModel } from "./communication.js";
export type { HarveyChatResponse, HarveyOpsResponse, HarveyDirective } from "./types.js";
