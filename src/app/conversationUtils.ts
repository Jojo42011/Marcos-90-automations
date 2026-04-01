import type { Conversation } from "../core/types.js";

/** Normalize for comparing lead messages (repeat taps, etc.). */
export function normalizeUserMessageText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Strip punctuation variance and unicode noise for Marco duplicate checks. */
export function normalizeForMarcoDuplicateCompare(text: string): string {
  let s = text
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/\s+/g, " ");
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " ");
  return s.replace(/\s+/g, " ").trim();
}

function diceBigramSimilarity(a: string, b: string): number {
  const t = (x: string) => normalizeForMarcoDuplicateCompare(x).replace(/\s/g, "");
  const A = t(a);
  const B = t(b);
  if (A.length < 2 || B.length < 2) return 0;
  const bigramCounts = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const mA = bigramCounts(A);
  const mB = bigramCounts(B);
  let inter = 0;
  for (const [g, c] of mA) inter += Math.min(c, mB.get(g) ?? 0);
  return (2 * inter) / (A.length - 1 + (B.length - 1));
}

function wordJaccard(a: string, b: string): number {
  const words = (s: string) => {
    const set = new Set<string>();
    for (const w of normalizeForMarcoDuplicateCompare(s).split(/\s+/)) {
      if (w.length > 2) set.add(w);
    }
    return set;
  };
  const A = words(a);
  const B = words(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * True if two Marco-sized replies are the same idea (fuzzy), not only exact match.
 */
export function messagesAreSubstantiallyDuplicate(a: string, b: string): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  const c = normalizeForMarcoDuplicateCompare(a);
  const l = normalizeForMarcoDuplicateCompare(b);
  if (!c || !l) return false;
  if (c === l) return true;
  const minLen = Math.min(c.length, l.length);
  const maxLen = Math.max(c.length, l.length);
  if (minLen >= 24) {
    const prefix = Math.min(72, minLen);
    if (c.slice(0, prefix) === l.slice(0, prefix)) return true;
  }
  if (minLen >= 30 && maxLen > 0 && minLen / maxLen >= 0.92) {
    if (c.includes(l.slice(0, Math.min(40, l.length))) || l.includes(c.slice(0, Math.min(40, c.length)))) {
      return true;
    }
  }
  const wcA = c.split(/\s+/).filter((w) => w.length > 2).length;
  const wcB = l.split(/\s+/).filter((w) => w.length > 2).length;
  if (wcA >= 6 && wcB >= 6) {
    const j = wordJaccard(a, b);
    if (j >= 0.68) return true;
  }
  if (minLen >= 40) {
    const d = diceBigramSimilarity(a, b);
    if (d >= 0.78) return true;
  }
  return false;
}

/** Last N assistant lines, newest first. */
export function getRecentAssistantTexts(conversation: Conversation, n: number): string[] {
  const out: string[] = [];
  for (let i = conversation.messages.length - 1; i >= 0 && out.length < n; i--) {
    const m = conversation.messages[i];
    if (m.role === "assistant" && m.text?.trim()) out.push(m.text.trim());
  }
  return out;
}

/** Last user line in the thread (most recent Lead message). */
export function getLastUserMessageText(conversation: Conversation): string {
  const reversed = [...conversation.messages].reverse();
  const m = reversed.find((x) => x.role === "user");
  return m?.text?.trim() ?? "";
}

/** Last Marco outbound before the reply we are about to generate (most recent assistant message). */
export function getLastAssistantMessageText(conversation: Conversation): string | null {
  const reversed = [...conversation.messages].reverse();
  const m = reversed.find((x) => x.role === "assistant");
  return m?.text?.trim() ? m.text.trim() : null;
}

/**
 * True if Marco's last two outbound messages are the same or nearly the same (stuck loop).
 */
export function lastTwoAssistantMessagesAreDuplicate(conversation: Conversation): boolean {
  const assistant: string[] = [];
  for (const m of conversation.messages) {
    if (m.role === "assistant" && m.text?.trim()) assistant.push(m.text.trim());
  }
  if (assistant.length < 2) return false;
  const last = assistant[assistant.length - 1];
  const prev = assistant[assistant.length - 2];
  return messagesAreSubstantiallyDuplicate(last, prev);
}

/**
 * True if the most recent Marco outbound substantially matches ANY earlier Marco line (catches A→B→A loops).
 */
export function latestAssistantEchoesEarlierInThread(conversation: Conversation): boolean {
  const assistant: string[] = [];
  for (const m of conversation.messages) {
    if (m.role === "assistant" && m.text?.trim()) assistant.push(m.text.trim());
  }
  if (assistant.length < 2) return false;
  const last = assistant[assistant.length - 1];
  for (let i = 0; i < assistant.length - 1; i++) {
    if (messagesAreSubstantiallyDuplicate(last, assistant[i])) return true;
  }
  return false;
}

/** Thread already contains Marco's agent question (used for deterministic funnel escape). */
export function threadContainsAgentQuestion(conversation: Conversation): boolean {
  return conversation.messages.some(
    (m) => m.role === "assistant" && /\bworking with an agent\b/i.test(m.text),
  );
}

/**
 * Any Marco line already asked the TikTok-style first-time-through-the-buying-process question
 * (manual DM or AI). Used to block repeating that opener in later turns.
 */
export function threadContainsFirstTimeBuyingQuestion(conversation: Conversation): boolean {
  return conversation.messages.some((m) => {
    if (m.role !== "assistant" || !m.text?.trim()) return false;
    const t = m.text;
    if (!/\bfirst\s*time\b/i.test(t) && !/\bfirst-time\b/i.test(t)) return false;
    if (!/\b(buying|buy)\b/i.test(t)) return false;
    return /\bprocess\b/i.test(t) || /\bgoing\s+through\b/i.test(t);
  });
}

/** Lead already indicated they are not a first-time buyer (thread-wide). */
export function leadThreadSignalsExperiencedBuyer(conversation: Conversation): boolean {
  for (const m of conversation.messages) {
    if (m.role !== "user" || !m.text?.trim()) continue;
    const t = m.text;
    if (/\bnot\s+my\s+first\b/i.test(t)) return true;
    if (/\b(we|i)('?ve?| have)\s+(both\s+)?(bought|owned|purchased)\b/i.test(t)) return true;
    if (/\bbought\s+(two|2|three|3|several|a few|multiple)\s+(homes?|houses?|properties)\b/i.test(t)) {
      return true;
    }
    if (/\bsecond\s+(home|house)\b/i.test(t)) return true;
    if (/^\s*no\b/i.test(t) && /\b(own|owned|bought|house|home|properties)\b/i.test(t)) return true;
    if (/\b(we|i)\s+also\s+own\b/i.test(t)) return true;
    if (/\bcurrently\s+own\b/i.test(t)) return true;
  }
  return false;
}

/** Lead is asking for builder / developer identity (never disclose). */
export function messageAsksBuilderIdentity(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (/\bwho\s+(built|builds)\b/.test(t)) return true;
  if (/\bwho\s+is\s+the\s+(builder|developer)\b/.test(t)) return true;
  if (/\bwhat('?s| is)\s+the\s+builder\b/.test(t)) return true;
  if (/\bwhich\s+builder\b/.test(t)) return true;
  if (/\b(builder|developer)\s+(name|is|for this|on this)\b/.test(t)) return true;
  if (/\bwho'?s\s+the\s+builder\b/.test(t)) return true;
  return false;
}

/** Lead text signals they are not represented / no agent (incl. "not working with anyone"). */
export function leadTextSignalsNoAgent(text: string): boolean {
  const t = text.toLowerCase();
  if (/\bno agent\b|\bnot an agent\b/.test(t)) return true;
  if (/\bon my own\b|\bby myself\b/.test(t)) return true;
  if (/\bnot\s+(currently\s+)?working\s+with\s+(anyone|anybody|an agent|a realtor|a broker)\b/.test(t)) {
    return true;
  }
  if (/\bdon'?t have an agent\b|\bwithout an agent\b/.test(t)) return true;
  if (/\bnobody yet\b|\bno one yet\b/.test(t)) return true;
  return false;
}

/**
 * True if candidate reply duplicates Marco's previous outbound (model stuck repeating).
 */
export function isDuplicateMarcoReply(candidate: string, lastAssistant: string | null): boolean {
  if (!lastAssistant?.trim() || !candidate.trim()) return false;
  return messagesAreSubstantiallyDuplicate(candidate, lastAssistant);
}

/** True if candidate is substantially the same as any recent Marco outbound (anti-loop). */
export function candidateMatchesRecentMarco(
  candidate: string,
  recentAssistantTexts: string[],
): boolean {
  if (!candidate.trim()) return false;
  for (const prev of recentAssistantTexts) {
    if (messagesAreSubstantiallyDuplicate(candidate, prev)) return true;
  }
  return false;
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
 * True if the lead is asking where *this* listing is (area, address, etc.).
 * Used so Marco only gives the approved hint (west of Stone Oak), not other regions.
 */
export function messageAsksListingLocation(text: string): boolean {
  const t = text.trim().toLowerCase();
  const pointsAtListing =
    /\b(it|this|that|the (house|home|place|property|listing))\b/.test(t) ||
    /\bwhere'?s it\b/.test(t) ||
    /\bwhere is it\b/.test(t);
  if (/\b(what'?s|what is) (the )?(address|location)\b/.test(t)) return true;
  if (/\b(the )?address (for|of) (this|it|the|that)\b/.test(t)) return true;
  if (/\bcross streets?\b/.test(t)) return true;
  if (/\bwhere\b/.test(t) && pointsAtListing) return true;
  if (/\bhow far\b/.test(t) && pointsAtListing) return true;
  if (/\b(what|which) area\b/.test(t) && pointsAtListing) return true;
  if (/\bwhat neighborhood\b/.test(t) && pointsAtListing) return true;
  if (/\bwhat part of town\b/.test(t) && pointsAtListing) return true;
  if (/\bdo you know where\b/.test(t) && pointsAtListing) return true;
  if (/\blocated\b/.test(t) && pointsAtListing) return true;
  return false;
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

