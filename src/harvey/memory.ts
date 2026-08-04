/**
 * In-memory Harvey session memory (last N turns per sessionId).
 *
 * The window is deliberately wide (24 turns, per the conversational playbook —
 * ChatGPT-style continuity needs recent turns verbatim) but each stored turn
 * is capped at 700 chars so a pasted wall of text can't blow up every later
 * call. The CURRENT message is never trimmed — trimming applies to history
 * only, on the way in. Turns that scroll out of the window are folded into a
 * rolling per-session summary (hull/conversation.ts) off the latency path.
 */

import type { HarveyMemoryTurn } from "./types.js";
import { noteEvictedTurns } from "../hull/conversation.js";

const MAX_TURNS = 24;
const MAX_TURN_CHARS = 700;
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
  list.push({
    role,
    content: text.length > MAX_TURN_CHARS ? text.slice(0, MAX_TURN_CHARS) + " […]" : text,
    at: new Date().toISOString(),
  });
  const evicted: HarveyMemoryTurn[] = [];
  while (list.length > MAX_TURNS * 2) {
    const turn = list.shift();
    if (turn) evicted.push(turn);
  }
  if (evicted.length) noteEvictedTurns(sessionId, evicted);
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
