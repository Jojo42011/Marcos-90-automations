import type { Conversation } from "../core/types.js";

/** Normalize for comparing lead messages (repeat taps, etc.). */
export function normalizeUserMessageText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * True if the latest user message matches the immediately previous user message (normalized).
 */
export function isLastUserMessageRepeated(conversation: Conversation): boolean {
  const userTexts: string[] = [];
  for (const m of conversation.messages) {
    if (m.role === "user") {
      userTexts.push(normalizeUserMessageText(m.text));
    }
  }
  if (userTexts.length < 2) return false;
  const last = userTexts[userTexts.length - 1];
  const prev = userTexts[userTexts.length - 2];
  if (!last || !prev) return false;
  if (last !== prev) return false;
  // Short duplicates like "yes"/"ok" twice — still let the funnel advance normally.
  if (last.length < 12) return false;
  return true;
}

/** Same short line twice (e.g. double-tap "yes") — do not treat as stuck/repeat for funnel logic. */
export function isShortDuplicateUserPair(conversation: Conversation): boolean {
  const userTexts: string[] = [];
  for (const m of conversation.messages) {
    if (m.role === "user") {
      userTexts.push(normalizeUserMessageText(m.text));
    }
  }
  if (userTexts.length < 2) return false;
  const last = userTexts[userTexts.length - 1];
  const prev = userTexts[userTexts.length - 2];
  return last === prev && last.length < 12;
}

