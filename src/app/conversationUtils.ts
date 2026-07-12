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

/**
 * Ambiguous listing fragments ("Stone", "the corner one") — short, no clear intent keyword,
 * no digits, not a plain conversational token. Route these to the screenshot-request pattern.
 */
export function isAmbiguousPropertyReference(text: string): boolean {
  const t = normalizeUserMessageText(text);
  if (!t) return false;
  const tokens = t.split(" ");
  if (tokens.length > 3) return false;
  if (/[\d@?]/.test(t)) return false;
  // Clear standalone intent words are handled by the normal opening flow.
  if (
    /\b(price|pricing|cost|much|info|details|available|availability|tour|showing|interested|address|location|where|casita)\b/.test(
      t,
    )
  ) {
    return false;
  }
  // Plain conversational fragments are not listing references.
  if (
    /^(yes|yeah|yep|yup|no|nope|nah|ok|okay|k|thanks|thank you|ty|hi|hey|hello|sup|sure|cool|nice|wow|lol|haha)$/.test(
      t,
    )
  ) {
    return false;
  }
  return true;
}

/** True if Marco already sent this exact line (normalized) earlier in the thread. */
export function assistantAlreadySaid(conversation: Conversation, text: string): boolean {
  const norm = normalizeUserMessageText(text);
  if (!norm) return false;
  return conversation.messages.some(
    (m) => m.role === "assistant" && normalizeUserMessageText(m.text) === norm,
  );
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

