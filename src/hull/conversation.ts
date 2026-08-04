/**
 * The conversation layer — what makes Harvey hold a thread instead of
 * answering each message like a search box.
 *
 * Ported from the conversational-agent playbook (§4): a chat feels
 * conversational because of architecture, not personality prose. Four parts:
 *
 *   1. Timed history — every turn carries a timestamp (harvey/memory.ts).
 *   2. CONVERSATION STATE — rebuilt every turn: is this the same sitting or a
 *      new one, and did Harvey's last turn end in a question (in which case
 *      the incoming message is almost certainly the ANSWER to it — the classic
 *      bot failure is asking, getting the answer, and replying off-topic).
 *   3. Rolling summary — turns that scroll out of the verbatim window fold
 *      into a living "conversation so far" note via Haiku, fire-and-forget,
 *      OFF the latency path.
 *   4. Follow-up-aware retrieval — "what about him?" carries zero retrievable
 *      keywords, so short/deictic messages blend the prior user turns into the
 *      memory query so retrieval can see the referent.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getHaikuModel } from "./modelRouting.js";

export interface TimedTurn {
  role: "user" | "assistant";
  content: string;
  /** ISO timestamp of when the turn was spoken/typed. */
  at?: string;
}

/** A gap longer than this starts a NEW sitting; shorter is the same live thread. */
export const SESSION_GAP_MS = 45 * 60 * 1000;

/** Rolling-summary cap — long enough to hold a thread, short enough to be cheap. */
const SUMMARY_MAX_CHARS = 1400;

/**
 * Build the CONVERSATION STATE block injected into the system prompt each turn.
 * Empty string when there is no history (nothing to hold a thread about).
 */
export function buildConversationState(turns: TimedTurn[], now: Date = new Date()): string {
  if (!turns.length) return "";

  const lines: string[] = ["CONVERSATION STATE (rebuilt this turn)"];

  const last = turns[turns.length - 1];
  const lastAt = last.at ? new Date(last.at).getTime() : NaN;
  const gapMs = Number.isFinite(lastAt) ? now.getTime() - lastAt : 0;

  if (gapMs > SESSION_GAP_MS) {
    const hours = gapMs / (60 * 60 * 1000);
    const ago = hours >= 1.5 ? `about ${Math.round(hours)} hours ago` : `${Math.round(gapMs / 60000)} minutes ago`;
    lines.push(
      `- NEW sitting: the last exchange was ${ago}. A brief two-word re-greeting is fine HERE ONLY, then substance. Do not pretend no time passed.`,
    );
  } else {
    lines.push(
      "- Same sitting, live thread: pick it up mid-flow. His short reply (\"yeah do it\", \"what about him?\") points at what YOU just said, so resolve it from the thread. No greeting.",
    );
  }

  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
  if (lastAssistant && /\?\s*$/.test(lastAssistant.content.trim())) {
    lines.push(
      "- Your last turn ended in a QUESTION. His message is most likely the ANSWER to it: respond to it as the answer, react to what he chose, then move forward.",
    );
  }

  lines.push(
    "- NEVER re-ask what the thread already answers. Asking twice tells him you weren't listening.",
  );

  return lines.join("\n");
}

/**
 * Follow-up-aware retrieval: a short or deictic message ("what about him?",
 * "do it", "the second one") is blended with the last two user turns so the
 * memory search sees the referent instead of a pronoun.
 */
const DEICTIC =
  /\b(it|that|this|him|her|them|those|the (first|second|last) one|again|instead|what about|do it|send it|same)\b/i;

export function buildRetrievalQuery(message: string, turns: TimedTurn[]): string {
  const m = message.trim();
  if (m.length >= 48 && !DEICTIC.test(m)) return m; // specific enough alone
  const prior = turns
    .filter((t) => t.role === "user")
    .slice(-2)
    .map((t) => t.content.slice(0, 160));
  return `${prior.join(" ")} ${m}`.trim().slice(0, 480);
}

/* ── Rolling summary ─────────────────────────────────────────────────────────
 * Turns evicted from the verbatim window fold into a living note per session.
 * Kept in memory (sessions themselves are in-memory in harvey/memory.ts, so a
 * restart clears both together — the summary never outlives its session).
 * Summarization runs fire-and-forget on Haiku, never on the reply's latency
 * path; until it completes, the previous summary keeps serving.
 */
const summaries = new Map<string, string>();
const pendingEvictions = new Map<string, TimedTurn[]>();
const summarizing = new Set<string>();

export function getConversationSummary(sessionId: string): string {
  return summaries.get(sessionId) ?? "";
}

/** Test hook / session reset. */
export function clearConversationSummary(sessionId: string): void {
  summaries.delete(sessionId);
  pendingEvictions.delete(sessionId);
}

/**
 * Called when turns scroll out of the verbatim window. Queues them and kicks
 * off a background fold; safe to call again while a fold is running (the new
 * turns wait for the next pass).
 */
export function noteEvictedTurns(sessionId: string, turns: TimedTurn[]): void {
  if (!turns.length) return;
  const queue = pendingEvictions.get(sessionId) ?? [];
  queue.push(...turns);
  pendingEvictions.set(sessionId, queue);
  void foldSummary(sessionId);
}

async function foldSummary(sessionId: string): Promise<void> {
  if (summarizing.has(sessionId)) return;
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return;
  const queue = pendingEvictions.get(sessionId);
  if (!queue || !queue.length) return;

  summarizing.add(sessionId);
  pendingEvictions.set(sessionId, []);
  try {
    const prior = summaries.get(sessionId) ?? "";
    const transcript = queue
      .map((t) => `${t.role === "user" ? "Marco" : "Harvey"}: ${t.content.slice(0, 400)}`)
      .join("\n");
    const client = new Anthropic({ apiKey: key });
    const res = await client.messages.create({
      model: getHaikuModel(),
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content:
            `Fold these older conversation turns into the running summary. Keep decisions, names, numbers, and anything either party committed to. Plain prose, under ${SUMMARY_MAX_CHARS} characters, no preamble.\n\n` +
            (prior ? `RUNNING SUMMARY SO FAR:\n${prior}\n\n` : "") +
            `TURNS TO FOLD IN:\n${transcript}`,
        },
      ],
    });
    const text = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (text) summaries.set(sessionId, text.slice(0, SUMMARY_MAX_CHARS));
  } catch (err) {
    // Off the latency path and best-effort: a failed fold keeps the old
    // summary, and the evicted turns are simply lost to it. Log and move on.
    console.error("[conversation] summary fold failed:", err instanceof Error ? err.message : err);
  } finally {
    summarizing.delete(sessionId);
    // Another eviction may have queued while we were folding.
    if ((pendingEvictions.get(sessionId) ?? []).length) void foldSummary(sessionId);
  }
}
