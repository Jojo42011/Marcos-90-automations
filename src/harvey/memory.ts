/**
 * In-memory Harvey session memory (last N turns per sessionId).
 */

import type { HarveyMemoryTurn } from "./types.js";

const MAX_TURNS = 6;
const sessions = new Map<string, HarveyMemoryTurn[]>();

export function getOrCreateSessionId(sessionId?: string): string {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (id.length >= 8 && id.length <= 128) return id;
  return `hs-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getSessionHistory(sessionId: string): HarveyMemoryTurn[] {
  return [...(sessions.get(sessionId) ?? [])];
}

export function appendSessionTurn(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
): void {
  const text = content.trim();
  if (!text) return;
  const list = sessions.get(sessionId) ?? [];
  list.push({ role, content: text, at: new Date().toISOString() });
  while (list.length > MAX_TURNS * 2) {
    list.shift();
  }
  sessions.set(sessionId, list);
}

/** Anthropic messages shape for multi-turn (user/assistant only). */
export function historyToAnthropicMessages(
  history: HarveyMemoryTurn[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return history.map((t) => ({
    role: t.role,
    content: t.content,
  }));
}
