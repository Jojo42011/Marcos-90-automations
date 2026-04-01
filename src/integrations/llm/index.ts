/**
 * Anthropic client — Claude Haiku (not Sonnet) for tone / light generation when wired in.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  getMarcoUnifiedPipelineSystem,
  getMarcoOpeningSystem,
  getMarcoTikTokOpeningSystem,
  getMarcoTikTokUnifiedPipelineSystem,
  prompts,
  GLOBAL_MARCO_DM_RULES,
} from "../../../config/prompts.js";
import type { Conversation, Lead, Message } from "../../core/types.js";
import { FunnelStage } from "../../core/state.js";
import type { FunnelDeterministicMeta } from "../../app/funnelDeterministic.js";
import {
  getLastAssistantMessageText,
  getRecentAssistantTexts,
  getLastUserMessageText,
  candidateMatchesRecentMarco,
  isDuplicateMarcoReply,
  isLastUserMessageRepeated,
  leadTextSignalsNoAgent,
  threadContainsAgentQuestion,
  messageAsksListingLocation,
  messageAsksBuilderIdentity,
  threadContainsFirstTimeBuyingQuestion,
  leadThreadSignalsExperiencedBuyer,
} from "../../app/conversationUtils.js";
import { marcoLog, marcoLogDebug, previewText, type MarcoLogContext } from "../../app/marcoLog.js";

/** Default: Claude 3.5 Haiku. Override with ANTHROPIC_MODEL in .env if needed. */
const DEFAULT_MODEL = "claude-3-5-haiku-latest";

const model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;

/** Single-word messages matching these (after normalize) → intent true, no Haiku. */
const SINGLE_WORD_BUY_INTENT_WHITELIST = new Set([
  "price",
  "info",
  "casita",
  "available",
  "tour",
  "showing",
  "interested",
  "details",
]);

function normalizeIntentToken(token: string): string {
  return token
    .trim()
    .toLowerCase()
    .replace(/^[@#]+/, "")
    .replace(/[.?!,;:…]+$/u, "");
}

/**
 * Single-token messages: whitelist → true, else false (no API).
 * Two tokens "how much" (normalized) → true (no API).
 * Instagram comments: short listing questions → true (no API) when pattern matches.
 * Everything else → null (run Haiku).
 */
function classifyObviousShortMessageWithoutLlm(
  text: string,
  opts?: { channel?: "comment" | "dm" },
): boolean | null {
  const channel = opts?.channel ?? "dm";
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return false;
  }

  if (tokens.length === 1) {
    const w = normalizeIntentToken(tokens[0]);
    if (!w) {
      return false;
    }
    if (SINGLE_WORD_BUY_INTENT_WHITELIST.has(w)) {
      return true;
    }
    if (channel === "comment") {
      const commentOne = new Set([
        "pricing",
        "cost",
        "pm",
        "dm",
        "location",
        "address",
        "interested",
        "available",
        "beds",
        "baths",
        "sqft",
      ]);
      if (commentOne.has(w)) return true;
    }
    return false;
  }

  if (tokens.length === 2) {
    const a = normalizeIntentToken(tokens[0]);
    const b = normalizeIntentToken(tokens[1]);
    if (a === "how" && b === "much") {
      return true;
    }
  }

  if (channel === "comment" && tokens.length <= 6) {
    const lower = text.toLowerCase();
    if (
      /\b(how much|how\s*much|what'?s the price|asking price|price check|still available|more info|any info|need info|send info|is it available|square feet|sq\.?\s*ft|bedrooms|bathrooms|can we see|schedule|book a tour|where is it|what area)\b/.test(
        lower,
      )
    ) {
      return true;
    }
  }

  return null;
}

function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

/**
 * Single user turn: system-style `prompt` + conversation/context `context`.
 */
export async function complete(prompt: string, context: string): Promise<string> {
  const client = getClient();
  if (!client) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const userContent =
    context.trim().length > 0
      ? `${prompt.trim()}\n\n---\n\n${context.trim()}`
      : prompt.trim();

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: userContent }],
  });

  const block = response.content[0];
  if (block.type !== "text") {
    throw new Error("Unexpected Anthropic response block type");
  }
  return block.text;
}

export function getAnthropicModel(): string {
  return model;
}

/**
 * Haiku intent gate: true only when the message clearly signals buyer / property interest.
 * On missing API key or parse/API errors, returns true (fail-open so real leads are not dropped).
 */
export async function classifyNewLeadBuyingIntent(
  message: string,
  opts?: { channel?: "comment" | "dm" },
): Promise<boolean> {
  const text = message.trim();
  if (!text) {
    return false;
  }

  const shortResult = classifyObviousShortMessageWithoutLlm(text, opts);
  if (shortResult !== null) {
    return shortResult;
  }

  const client = getClient();
  if (!client) {
    console.warn("[llm] classifyNewLeadBuyingIntent: ANTHROPIC_API_KEY missing — treating as interested");
    return true;
  }

  const commentNote =
    opts?.channel === "comment"
      ? `\n\nCHANNEL: This text is an INSTAGRAM COMMENT on a listing-style post. Comments are usually very short. Phrases like "how much", "price", "info", "details", "still available", "interested", "where is it", "sqft", "beds" almost always mean intent=true unless clearly spam or off-topic (jobs, crypto, random jokes with no home hook). Prefer intent=true for brief listing questions.\n`
      : "";

  const system = `You gate a real-estate buyer funnel on Instagram/ManyChat. Be STRICT. When unsure, use intent=false.
${commentNote}
Return intent=true ONLY if the message clearly and specifically shows interest in buying a home, viewing a property, or asking about a concrete listing or residential real estate (price, address, showing, tour, beds/baths/sqft of a home, offer, mortgage on a purchase, this/that house, neighborhood for living in—not generic "how's the market?" with zero buy/view signal).

Return intent=false for:
- Greetings, acknowledgements, filler: "hey", "sup", "lol", "ok", "thanks", "yur", "yes", "no" (unless they clearly continue a property conversation in the same message)
- Vague short chit-chat with no property hook
- Spam, scams, unrelated topics (crypto, jobs, random DMs)
- Selling only / listing agent pitches with no buy side
- Emojis only or meaningless fragments

Ambiguous or borderline short phrases → intent=false.

### Examples intent=true (real buyer/property signal)
- "Is this place still available?"
- "Can we see 123 Oak this weekend?"
- "What's the asking price on the home you posted?"
- "I'm pre-approved and interested in the 4 bed in Frisco"
- "Schedule a showing for the listing on Main St"
- "Does this house have a garage? We're looking to buy in this area"

### Examples intent=false (no clear property/buy intent)
- "hey" / "yur" / "what's up" / "lol ok"
- "nice" / "cool video" / "love your content"
- "hi how are you"
- "thanks" / "ok thanks"
- "you're hot" / random flirtation with no house mention
- "can you help me grow my instagram"

Output ONLY valid JSON on one line, no markdown, no code fences:
{"intent":true}
or
{"intent":false}`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 64,
      messages: [{ role: "user", content: system + "\n\nMESSAGE:\n" + text }],
    });
    const block = response.content[0];
    if (block.type !== "text") {
      return true;
    }
    const parsed = JSON.parse(stripCodeFences(block.text)) as unknown;
    if (!parsed || typeof parsed !== "object") return true;
    const intent = (parsed as { intent?: unknown }).intent;
    if (intent === false) return false;
    if (intent === true) return true;
    return true;
  } catch (e) {
    console.warn("[llm] classifyNewLeadBuyingIntent failed — fail-open:", e);
    return true;
  }
}

export interface ConversationLike {
  messages: { role: "user" | "assistant"; text: string }[];
}

function formatConversationHistory(c: ConversationLike): string {
  if (!c.messages.length) return "(no prior messages)";
  return c.messages
    .map((m) => `${m.role === "user" ? "Lead" : "Marco"}: ${m.text}`)
    .join("\n");
}

/**
 * Strip optional ```json fences from model output.
 */
function stripCodeFences(raw: string): string {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(s);
  if (fence) s = fence[1].trim();
  return s;
}

export interface PreflightTurnResult {
  repeatedMessage: boolean;
  coachingNote: string;
}

function parsePreflightJson(raw: string): PreflightTurnResult | null {
  try {
    const s = stripCodeFences(raw);
    const parsed = JSON.parse(s) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as { repeated_message?: unknown; coaching_note?: unknown };
    const repeatedMessage = o.repeated_message === true;
    const coachingNote =
      typeof o.coaching_note === "string" ? o.coaching_note.trim() : "";
    return { repeatedMessage, coachingNote };
  } catch {
    return null;
  }
}

const DEFAULT_REPEAT_COACHING =
  "The lead may have repeated the same message; acknowledge briefly, stay on the current funnel step, do not restart from the beginning, and do not repeat or closely mirror Marco's prior outbound. Advance the thread in a new direction. If they are resisting giving a phone number, reply to their exact words in one or two short sentences, never reuse canned resistance lines, vary the ask each time. If the latest lead tone is resistant or negative, avoid upbeat affirmations and match their sentiment. Keep moving naturally through Marco's framework: value, then agent context, then number ask.";

/**
 * Before modules/reply: full thread → repeat signal + short coaching (2+ user messages only).
 * Combined with deterministic duplicate detection in the pipeline.
 */
export async function preflightLeadTurnReview(
  input: {
    conversation: Conversation;
    leadState: string;
  },
  log?: MarcoLogContext,
): Promise<PreflightTurnResult> {
  const transcript = input.conversation.messages
    .map((m: Message) => `${m.role === "user" ? "Lead" : "Marco"}: ${m.text}`)
    .join("\n");

  const client = getClient();
  if (!client) {
    const repeatedMessage = isLastUserMessageRepeated(input.conversation);
    const out = {
      repeatedMessage,
      coachingNote: repeatedMessage ? DEFAULT_REPEAT_COACHING : "",
    };
    marcoLog("preflight_skip", {
      requestId: log?.requestId,
      correlationId: log?.correlationId,
      reason: "no_anthropic_client",
      repeated_message: out.repeatedMessage,
    });
    return out;
  }

  const userBlock = `CURRENT_FUNNEL_STAGE: ${input.leadState}\n\nCONVERSATION (oldest first):\n${transcript}`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 256,
      system: prompts.preflightTurnReview.trim(),
      messages: [{ role: "user", content: userBlock }],
    });
    const block = response.content[0];
    if (block.type !== "text") {
      const repeatedMessage = isLastUserMessageRepeated(input.conversation);
      marcoLog("preflight_bad_block", {
        requestId: log?.requestId,
        correlationId: log?.correlationId,
        block_type: block.type,
      });
      return {
        repeatedMessage,
        coachingNote: repeatedMessage ? DEFAULT_REPEAT_COACHING : "",
      };
    }
    const parsed = parsePreflightJson(block.text);
    if (parsed) {
      marcoLog("preflight_haiku", {
        requestId: log?.requestId,
        correlationId: log?.correlationId,
        repeated_message: parsed.repeatedMessage,
        coaching_preview: previewText(parsed.coachingNote, 280),
      });
      marcoLogDebug("preflight_haiku_full_coaching", {
        requestId: log?.requestId,
        correlationId: log?.correlationId,
        coaching_note: parsed.coachingNote || "",
      });
      return parsed;
    }
    const repeatedMessage = isLastUserMessageRepeated(input.conversation);
    marcoLog("preflight_parse_fallback", {
      requestId: log?.requestId,
      correlationId: log?.correlationId,
      repeated_message: repeatedMessage,
    });
    return {
      repeatedMessage,
      coachingNote: repeatedMessage ? DEFAULT_REPEAT_COACHING : "",
    };
  } catch (e) {
    console.warn("[llm] preflightLeadTurnReview failed:", e);
    const repeatedMessage = isLastUserMessageRepeated(input.conversation);
    marcoLog("preflight_error_fallback", {
      requestId: log?.requestId,
      correlationId: log?.correlationId,
      repeated_message: repeatedMessage,
      error: e instanceof Error ? e.message : String(e),
    });
    return {
      repeatedMessage,
      coachingNote: repeatedMessage ? DEFAULT_REPEAT_COACHING : "",
    };
  }
}

function parsePipelineReplyJson(raw: string): string | null {
  try {
    const s = stripCodeFences(raw);
    const parsed = JSON.parse(s) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const r = (parsed as { reply?: unknown }).reply;
    if (typeof r !== "string" || !r.trim()) return null;
    return r.trim();
  } catch {
    return null;
  }
}

function greetingNameForOpening(lead: Lead): string {
  if (lead.name?.trim()) {
    return lead.name.trim();
  }
  const u = lead.username?.trim();
  if (!u) return "there";
  const first = u.split(/[._]/)[0] ?? u;
  if (!/^[a-zA-Z]+$/.test(first)) return "there";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/** Lead's message centers on seeing the home / scheduling, not generic interest. */
function signalsTourOrScheduleIntent(text: string): boolean {
  return /\b(schedule|set up|book|line up|tour|showing|walkthrough|see (the |this )?(home|house|place|property)|visit|when can we|can we see|come (by|see)|stop by)\b/i.test(
    text,
  );
}

/** Lead is deflecting price pressure or early capture. */
function signalsBrowsingOrPriceDeflection(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\bjust browsing\b/.test(t) ||
    /\bnot worried about (the )?price\b/.test(t) ||
    /\bprice (doesn|isn)'t matter\b/.test(t) ||
    /\bnot (really )?about (the )?price\b/.test(t) ||
    /\bjust looking\b/.test(t) ||
    /\bno rush\b/.test(t)
  );
}

function isTikTokPlatform(platform?: string): boolean {
  return (platform ?? "").toLowerCase().includes("tik");
}

function inboundChannelBlock(channel: "comment" | "dm"): string {
  if (channel === "comment") {
    return (
      "CHANNEL: instagram_comment — The lead's latest line came from a COMMENT on your post (ManyChat comment automation). " +
      "Treat it like a short public-adjacent question: answer what they asked first (price ballpark, info, location per your rules, tour, availability). " +
      "Do not ignore 'how much', 'price', 'info', or 'where' style asks. Stay concise.\n\n"
    );
  }
  return "";
}

function openingContextAppendix(
  lastUserText: string,
  conversation: Conversation,
  channel: "comment" | "dm",
  platform?: string,
): string {
  const lines: string[] = [];
  const assistantTurns = conversation.messages.filter((m) => m.role === "assistant").length;
  const tikTokOpenerAlreadyInThread =
    isTikTokPlatform(platform) &&
    (assistantTurns >= 1 || threadContainsFirstTimeBuyingQuestion(conversation));
  const tikTokChannelBlock = isTikTokPlatform(platform)
    ? tikTokOpenerAlreadyInThread
      ? "CHANNEL: tiktok_dm — Marco already has at least one outbound in this thread (often the manual first DM with the first-time buying question). Do NOT send another opener and do NOT ask about first-time vs experienced buyer or the buying process again. Answer LATEST_LEAD_MESSAGE only; move toward breakdown offer and/or phone number. Never recycle appreciation + first-time question.\n\n"
      : "CHANNEL: tiktok_dm — Use TikTok flow, not Instagram. If this is Marco's first line in the thread, first-time check then breakdown then number can apply; if any Marco line already exists above, skip opener scripts entirely.\n\n"
    : "";
  const prefix = tikTokChannelBlock + inboundChannelBlock(channel);
  if (assistantTurns === 0 && lastUserText.trim()) {
    lines.push(
      "FIRST_OUTBOUND_RULE: This is Marco's first reply in the thread. The lead's latest line is their opener. Answer its primary intent first (tour, showing, schedule, availability, a direct question). Do not ignore that to deliver a pricing script. Use thanks plus mid 500s plus alignment question only when their message is generic interest or price led, not when they already asked for something specific like a tour.",
    );
  }
  if (signalsTourOrScheduleIntent(lastUserText)) {
    lines.push(
      "TOUR_OR_SCHEDULE_SIGNAL: The lead is asking to tour, see the home, or schedule. Confirm you can help, ask timing or next step. Pricing is secondary in this turn.",
    );
  }
  if (signalsBrowsingOrPriceDeflection(lastUserText)) {
    lines.push(
      "BROWSING_OR_PRICE_DEFLECTION: The lead is browsing or said price is not their focus. Acknowledge that. Do not push budget or repeat the same price pitch. Stay helpful (areas, what they like, tour when ready) and avoid sounding scripted or pushy.",
    );
  }
  if (messageAsksListingLocation(lastUserText)) {
    lines.push(
      "LOCATION_ASK: The lead asked where this home is. Answer using only west of Stone Oak (natural phrasing). No other neighborhood, corridor, or street. Still no exact address or builder.",
    );
  }
  if (messageAsksBuilderIdentity(lastUserText)) {
    lines.push(
      "BUILDER_ASK: The lead asked who the builder or developer is. NEVER name the builder. Briefly deflect; steer to a good number for the breakdown or answer non-builder parts of their message.",
    );
  }
  if (threadContainsFirstTimeBuyingQuestion(conversation) || leadThreadSignalsExperiencedBuyer(conversation)) {
    lines.push(
      "FIRST_TIME_TOPIC_CLOSED: The first-time-through-the-buying-process question already appears in Marco's lines or the lead already said they are not a first-time buyer. Do NOT ask that again in any wording (including rephrases like first time through a process like this).",
    );
  }
  const body = lines.length ? `${lines.join("\n")}\n\n` : "";
  return prefix + body;
}

function fallbackOpeningReply(
  lead: Lead,
  openingStage: FunnelStage,
  lastUserText: string,
  conversation: Conversation | undefined,
  inboundChannel: "comment" | "dm" = "dm",
  inboundPlatform = "instagram",
): string {
  const who = greetingNameForOpening(lead);
  const isTikTok = isTikTokPlatform(inboundPlatform);
  if (openingStage === FunnelStage.New) {
    if (isTikTok) {
      const hey = who !== "there" ? `Thanks for reaching out ${who}!` : "Thanks for reaching out!";
      if (signalsTourOrScheduleIntent(lastUserText)) {
        return `${hey} I'd love to help, would it help if I sent over the full breakdown first? Is there a good number I could send it over too?`;
      }
      if (messageAsksListingLocation(lastUserText)) {
        return `${hey} It's west of Stone Oak. Would it help if I sent the full breakdown over, what's a good number I could send it over too?`;
      }
      return `${hey} I'd love to help. Is this going to be your first time going through the buying process?!`;
    }
    if (messageAsksListingLocation(lastUserText)) {
      const hey = who !== "there" ? `Hey ${who}` : "Hey";
      return `${hey}, it's west of Stone Oak. This one's typically mid 500s depending on finishes — does that line up with what you're looking for or a different price point?`;
    }
    if (signalsTourOrScheduleIntent(lastUserText)) {
      const hey = who !== "there" ? `Hey ${who}` : "Hey";
      return `${hey}, for sure we can line up a tour. What days or times usually work best for you? This one is typically mid 500s depending on finishes if that helps you ballpark it.`;
    }
    const thanks =
      inboundChannel === "comment"
        ? who !== "there"
          ? `Hey ${who}, thanks for commenting`
          : "Hey, thanks for commenting"
        : who !== "there"
          ? `Hey ${who}, I appreciate you reaching out`
          : "Hey, I appreciate you reaching out";
    return `${thanks}. The pricing on this one typically runs in the mid 500s depending on finishes and add-ons. Did this home somewhat align with what you're looking for or something in a different price point?`;
  }
  if (openingStage === FunnelStage.OpeningAskedFirstTime) {
    if (isTikTok) {
      if (/^no\b|not my first|isn't|isnt/.test(lastUserText.trim().toLowerCase())) {
        return "Ahh gotcha of course, would it help if I sent over the entire breakdown of the property you inquired about?";
      }
      return "Sounds good, is there a good number I could send it over too?";
    }
    if (signalsBrowsingOrPriceDeflection(lastUserText)) {
      return "Got it, no pressure at all. What part of town or style of home are you drawn to most right now?";
    }
    return "For sure, that helps. Are you currently working with an agent?";
  }
  if (
    conversation &&
    threadContainsAgentQuestion(conversation) &&
    leadTextSignalsNoAgent(lastUserText)
  ) {
    return "Got you. What's a good number I can text you the full breakdown on this place and a couple similar options?";
  }
  if (signalsBrowsingOrPriceDeflection(lastUserText)) {
    return "Totally hear you. Want me to text a few options when you are ready, or keep it in here for now and you tell me what you want to see first?";
  }
  return "Makes sense. Would there be a good number I could send all this info over to?";
}

function alternateOpeningFallback(
  lead: Lead,
  openingStage: FunnelStage,
  lastUserText: string,
  conversation: Conversation,
  inboundChannel: "comment" | "dm" = "dm",
  inboundPlatform = "instagram",
): string {
  const recent = getRecentAssistantTexts(conversation, 5);
  const isTikTok = isTikTokPlatform(inboundPlatform);
  const pool: string[] = [];
  if (isTikTok) {
    pool.push(
      "Would it help if I sent over the entire breakdown for that home, and if so what's a good number I could send it over too?",
      "Ahh gotcha. I can send all the details over cleanly, what's a good number?",
    );
  }
  if (/\bva\b|veteran|military|gi\b/i.test(lastUserText)) {
    pool.push(
      "VA helps a ton on the payment side, we can walk real numbers when you want. What's the best number to text you the spec sheet and a few similar homes?",
    );
  }
  if (leadTextSignalsNoAgent(lastUserText)) {
    pool.push(
      "Got you. What's a good number I can send the full breakdown and a couple backup listings to?",
      "Cool, since you're rolling solo on this, what number works best for me to text you the packet?",
    );
  }
  if (
    openingStage === FunnelStage.OpeningOfferedDetails ||
    openingStage === FunnelStage.OpeningAskedFirstTime
  ) {
    pool.push(
      "Fair enough. Want me to text you the breakdown on this one? What's the best number?",
      "I can line up a tour once I know your schedule, what days are easiest? If you want the spec sheet first, drop a number and I'll send it.",
    );
  }
  pool.push(
    fallbackOpeningReply(
      lead,
      openingStage,
      lastUserText,
      conversation,
      inboundChannel,
      inboundPlatform,
    ),
  );
  for (const c of pool) {
    if (!candidateMatchesRecentMarco(c, recent)) return c;
  }
  return "What's the best number to text you details on this home?";
}

/**
 * Final guard before DB append: never persist an opening reply that matches recent Marco lines.
 */
export function sanitizeOpeningReplyAgainstRecentMarco(
  reply: string | null,
  lead: Lead,
  conversation: Conversation,
  openingStage: FunnelStage.New | FunnelStage.OpeningAskedFirstTime | FunnelStage.OpeningOfferedDetails,
  log?: MarcoLogContext,
  inboundChannel: "comment" | "dm" = "dm",
  inboundPlatform = "instagram",
): string | null {
  if (!reply?.trim()) return reply;
  const recent = getRecentAssistantTexts(conversation, 5);
  if (!candidateMatchesRecentMarco(reply, recent)) return reply;
  marcoLog("sanitize_opening", {
    requestId: log?.requestId,
    correlationId: log?.correlationId,
    reason: "draft_matched_recent_marco",
    draft_preview: previewText(reply),
    opening_stage: openingStage,
  });
  const lastUser = getLastUserMessageText(conversation);
  let out = alternateOpeningFallback(
    lead,
    openingStage,
    lastUser,
    conversation,
    inboundChannel,
    inboundPlatform,
  );
  if (candidateMatchesRecentMarco(out, recent)) {
    out = fallbackOpeningReply(
      lead,
      openingStage,
      lastUser,
      conversation,
      inboundChannel,
      inboundPlatform,
    );
  }
  if (candidateMatchesRecentMarco(out, recent)) {
    out = "What's the best number to text you the spec sheet on this house?";
  }
  marcoLog("sanitize_opening_result", {
    requestId: log?.requestId,
    correlationId: log?.correlationId,
    out_preview: previewText(out),
  });
  return out;
}

/**
 * Final guard before DB append for post-opening funnel replies.
 */
export function sanitizePipelineReplyAgainstRecentMarco(
  reply: string | null,
  lead: Lead,
  conversation: Conversation,
  meta: FunnelDeterministicMeta,
  log?: MarcoLogContext,
): string | null {
  if (!reply?.trim()) return reply;
  const recent = getRecentAssistantTexts(conversation, 5);
  if (!candidateMatchesRecentMarco(reply, recent)) return reply;
  marcoLog("sanitize_pipeline", {
    requestId: log?.requestId,
    correlationId: log?.correlationId,
    reason: "draft_matched_recent_marco",
    draft_preview: previewText(reply),
    funnel_stage: lead.state,
  });
  const lastA = getLastAssistantMessageText(conversation) ?? "";
  const lastU = getLastUserMessageText(conversation);
  const out = alternatePipelineReplyFallback(lead, meta, lastA, lastU, recent);
  marcoLog("sanitize_pipeline_result", {
    requestId: log?.requestId,
    correlationId: log?.correlationId,
    out_preview: previewText(out),
  });
  return out;
}

function fallbackMarcoReply(lead: Lead, meta: FunnelDeterministicMeta): string {
  if (meta.phoneJustCaptured) {
    return (
      "For sure. I'll send you the full breakdown on that home with specs, pricing, and a couple similar options. " +
      "Was this what you had in mind, or are you leaning toward a different area or price range?"
    );
  }
  if (meta.listSendPromised) {
    return (
      "Of course. I'll email a personalized list of matching homes. " +
      "Skim it when you can and tell me what catches your eye so we can line up showings."
    );
  }
  if (!lead.phone) {
    return "Of course. Is there a good number I can reach you at to send you more info?";
  }
  if (!lead.email) {
    return "Appreciate it. What email works best for options that match what you want?";
  }
  return "Thanks, I'm on it and will keep this moving.";
}

/**
 * One Haiku call: full thread + opening stage + preflight → next Marco DM (opening funnel only).
 * Replaces rigid per-branch deterministic scripts; stage advancement stays in the module.
 */
export async function generateMarcoOpeningReply(input: {
  lead: Lead;
  conversation: Conversation;
  openingStage: FunnelStage.New | FunnelStage.OpeningAskedFirstTime | FunnelStage.OpeningOfferedDetails;
  preflight: PreflightTurnResult;
  inboundChannel?: "comment" | "dm";
  inboundPlatform?: string;
  log?: MarcoLogContext;
}): Promise<string> {
  const { lead, conversation, openingStage, preflight, log } = input;
  const inboundChannel = input.inboundChannel ?? "dm";
  const inboundPlatform = input.inboundPlatform ?? "instagram";
  const client = getClient();
  marcoLog("llm_opening_start", {
    requestId: log?.requestId,
    correlationId: log?.correlationId,
    lead_id: lead.id,
    opening_stage: openingStage,
    model,
    preflight_repeated_flag: preflight.repeatedMessage,
  });
  const transcript = conversation.messages
    .map((m: Message) => `${m.role === "user" ? "Lead" : "Marco"}: ${m.text}`)
    .join("\n");

  const preflightPayload = {
    repeated_message: preflight.repeatedMessage,
    coaching_note: preflight.coachingNote,
  };

  const lastUserText = getLastUserMessageText(conversation);
  const lastAssistantText = getLastAssistantMessageText(conversation);
  const recentMarcoOutbounds = getRecentAssistantTexts(conversation, 5);
  const contextPrefix = openingContextAppendix(
    lastUserText,
    conversation,
    inboundChannel,
    inboundPlatform,
  );

  const userBlock =
    contextPrefix +
    `OPENING_STAGE: ${openingStage}\n\n` +
    `PREFLIGHT:\n${JSON.stringify(preflightPayload, null, 2)}\n\n` +
    `LATEST_LEAD_MESSAGE (address this directly; if it bundles several topics, handle them naturally in one reply):\n${lastUserText || "(empty)"}\n\n` +
    `MARCO_PREVIOUS_OUTBOUND (your new reply must NOT repeat the same wording or the same idea as this; use a different angle):\n${lastAssistantText ?? "(none)"}\n\n` +
    `CONVERSATION (oldest first):\n${transcript}`;

  if (!client) {
    marcoLog("llm_opening_fallback", {
      requestId: log?.requestId,
      correlationId: log?.correlationId,
      reason: "no_anthropic_client",
    });
    return fallbackOpeningReply(
      lead,
      openingStage,
      lastUserText,
      conversation,
      inboundChannel,
      inboundPlatform,
    );
  }

  const runOnce = async (blockContent: string) => {
    const t0 = Date.now();
    const response = await client.messages.create({
      model,
      max_tokens: 900,
      system: isTikTokPlatform(inboundPlatform)
        ? getMarcoTikTokOpeningSystem()
        : getMarcoOpeningSystem(),
      messages: [{ role: "user", content: blockContent }],
    });
    const block = response.content[0];
    if (block.type !== "text") {
      return null;
    }
    marcoLogDebug("llm_opening_api_ms", {
      requestId: log?.requestId,
      correlationId: log?.correlationId,
      ms: Date.now() - t0,
      stop_reason: (response as { stop_reason?: string }).stop_reason,
    });
    return parsePipelineReplyJson(block.text);
  };

  try {
    let reply = await runOnce(userBlock);
    if (reply && candidateMatchesRecentMarco(reply, recentMarcoOutbounds)) {
      marcoLog("llm_opening_duplicate_draft", {
        requestId: log?.requestId,
        correlationId: log?.correlationId,
        draft_preview: previewText(reply),
        action: "retroactive_fix_retry",
      });
      const fixBlock =
        userBlock +
        `\n\nRETROACTIVE_FIX: Your draft matches or nearly matches a prior Marco line in this thread (including casita, furnished, or agent questions). Output ONLY valid JSON with a new "reply" that (1) answers LATEST_LEAD_MESSAGE directly, (2) never repeats or paraphrases any prior Marco message, (3) if the agent question was already asked above and the lead answered, move to the next step (usually phone number to send details), (4) one or two short sentences.`;
      reply = (await runOnce(fixBlock)) ?? reply;
    }
    if (reply && candidateMatchesRecentMarco(reply, recentMarcoOutbounds)) {
      marcoLog("llm_opening_duplicate_draft", {
        requestId: log?.requestId,
        correlationId: log?.correlationId,
        draft_preview: previewText(reply),
        action: "alternate_opening_fallback",
      });
      reply = alternateOpeningFallback(
        lead,
        openingStage,
        lastUserText,
        conversation,
        inboundChannel,
        inboundPlatform,
      );
    }
    if (reply && candidateMatchesRecentMarco(reply, recentMarcoOutbounds)) {
      marcoLog("llm_opening_duplicate_draft", {
        requestId: log?.requestId,
        correlationId: log?.correlationId,
        action: "template_opening_fallback",
      });
      reply = fallbackOpeningReply(
        lead,
        openingStage,
        lastUserText,
        conversation,
        inboundChannel,
        inboundPlatform,
      );
    }
    const finalReply =
      reply ??
      fallbackOpeningReply(
        lead,
        openingStage,
        lastUserText,
        conversation,
        inboundChannel,
        inboundPlatform,
      );
    marcoLog("llm_opening_done", {
      requestId: log?.requestId,
      correlationId: log?.correlationId,
      reply_preview: previewText(finalReply),
      used_hardcoded_fallback: !reply,
    });
    return finalReply;
  } catch (e) {
    console.warn("[llm] generateMarcoOpeningReply failed:", e);
    marcoLog("llm_opening_error", {
      requestId: log?.requestId,
      correlationId: log?.correlationId,
      error: e instanceof Error ? e.message : String(e),
    });
    return fallbackOpeningReply(
      lead,
      openingStage,
      lastUserText,
      conversation,
      inboundChannel,
      inboundPlatform,
    );
  }
}

/**
 * One Haiku call: full thread + funnel JSON → next Marco DM (post–opening funnel only).
 */
export async function generateMarcoPipelineReply(input: {
  lead: Lead;
  conversation: Conversation;
  meta: FunnelDeterministicMeta;
  preflight: PreflightTurnResult;
  inboundChannel?: "comment" | "dm";
  inboundPlatform?: string;
  log?: MarcoLogContext;
}): Promise<string | null> {
  const { lead, conversation, meta, preflight, log } = input;
  const inboundChannel = input.inboundChannel ?? "dm";
  const inboundPlatform = input.inboundPlatform ?? "instagram";
  const client = getClient();
  marcoLog("llm_pipeline_start", {
    requestId: log?.requestId,
    correlationId: log?.correlationId,
    lead_id: lead.id,
    funnel_stage: lead.state,
    model,
    preflight_repeated_flag: preflight.repeatedMessage,
    phone_just_captured: Boolean(meta.phoneJustCaptured),
    list_send_promised: Boolean(meta.listSendPromised),
  });
  const transcript = conversation.messages
    .map((m: Message) => `${m.role === "user" ? "Lead" : "Marco"}: ${m.text}`)
    .join("\n");

  const preflightPayload = {
    repeated_message: preflight.repeatedMessage,
    coaching_note: preflight.coachingNote,
  };

  const funnelContext = {
    stage: lead.state,
    phone_on_file: Boolean(lead.phone),
    email_on_file: Boolean(lead.email),
    criteria: lead.criteria,
    phone_just_captured: Boolean(meta.phoneJustCaptured),
    list_send_promised: Boolean(meta.listSendPromised),
  };

  const lastUserText = getLastUserMessageText(conversation);
  const lastAssistantText = getLastAssistantMessageText(conversation);
  const recentMarcoOutbounds = getRecentAssistantTexts(conversation, 5);
  const postOpeningHints: string[] = [];
  if (signalsBrowsingOrPriceDeflection(lastUserText)) {
    postOpeningHints.push(
      "BROWSING_OR_PRICE_DEFLECTION: Lead is browsing or de emphasized price. Do not loop back into budget or the same price script. Acknowledge and stay helpful without pushing the same asks.",
    );
  }
  if (signalsTourOrScheduleIntent(lastUserText)) {
    postOpeningHints.push(
      "TOUR_OR_SCHEDULE_SIGNAL: Lead is focused on seeing the home or scheduling. Address that before generic capture scripts.",
    );
  }
  if (messageAsksListingLocation(lastUserText)) {
    postOpeningHints.push(
      "LOCATION_ASK: Lead asked where this listing is. Reply using only west of Stone Oak (natural wording). No other area labels or streets. No exact address or builder.",
    );
  }
  if (messageAsksBuilderIdentity(lastUserText)) {
    postOpeningHints.push(
      "BUILDER_ASK: Lead asked builder or developer identity. NEVER name the builder. Deflect in one short line; steer to phone number or address only the non-builder parts of their message.",
    );
  }
  if (threadContainsFirstTimeBuyingQuestion(conversation) || leadThreadSignalsExperiencedBuyer(conversation)) {
    postOpeningHints.push(
      "FIRST_TIME_TOPIC_CLOSED: Do not ask again about first time buying, first time through the process, or similar — already covered in the thread. Answer their latest message and advance.",
    );
  }
  const postOpeningPrefix =
    inboundChannelBlock(inboundChannel) +
    (postOpeningHints.length ? `${postOpeningHints.join("\n")}\n\n` : "");

  const userBlock =
    postOpeningPrefix +
    `PREFLIGHT:\n${JSON.stringify(preflightPayload, null, 2)}\n\n` +
    `FUNNEL_CONTEXT:\n${JSON.stringify(funnelContext, null, 2)}\n\n` +
    `LATEST_LEAD_MESSAGE (answer this message directly in your reply; do not ignore their question or objection):\n${lastUserText || "(empty)"}\n\n` +
    `MARCO_PREVIOUS_OUTBOUND (your new reply must NOT repeat the same wording or the same idea as this; use a different angle):\n${lastAssistantText ?? "(none)"}\n\n` +
    `CONVERSATION (oldest first):\n${transcript}`;

  if (!client) {
    marcoLog("llm_pipeline_fallback", {
      requestId: log?.requestId,
      correlationId: log?.correlationId,
      reason: "no_anthropic_client",
    });
    return fallbackMarcoReply(lead, meta);
  }

  const runOnce = async (blockContent: string) => {
    const t0 = Date.now();
    const response = await client.messages.create({
      model,
      max_tokens: 900,
      system: isTikTokPlatform(inboundPlatform)
        ? getMarcoTikTokUnifiedPipelineSystem()
        : getMarcoUnifiedPipelineSystem(),
      messages: [{ role: "user", content: blockContent }],
    });
    const block = response.content[0];
    if (block.type !== "text") {
      return null;
    }
    marcoLogDebug("llm_pipeline_api_ms", {
      requestId: log?.requestId,
      correlationId: log?.correlationId,
      ms: Date.now() - t0,
      stop_reason: (response as { stop_reason?: string }).stop_reason,
    });
    return parsePipelineReplyJson(block.text);
  };

  try {
    let reply = await runOnce(userBlock);
    if (reply && candidateMatchesRecentMarco(reply, recentMarcoOutbounds)) {
      marcoLog("llm_pipeline_duplicate_draft", {
        requestId: log?.requestId,
        correlationId: log?.correlationId,
        draft_preview: previewText(reply),
        action: "retroactive_fix_retry",
      });
      const fixBlock =
        userBlock +
        `\n\nRETROACTIVE_FIX: Your draft matches or nearly matches a prior Marco line in CONVERSATION. Output ONLY valid JSON with a new "reply" that (1) answers LATEST_LEAD_MESSAGE, (2) does not reuse prior Marco wording or structure, (3) if a question was already asked and answered in the thread, advance instead of re-asking, (4) one or two short sentences.`;
      reply = (await runOnce(fixBlock)) ?? reply;
    }
    if (reply && candidateMatchesRecentMarco(reply, recentMarcoOutbounds)) {
      marcoLog("llm_pipeline_duplicate_draft", {
        requestId: log?.requestId,
        correlationId: log?.correlationId,
        draft_preview: previewText(reply),
        action: "alternate_pipeline_fallback",
      });
      reply = alternatePipelineReplyFallback(
        lead,
        meta,
        lastAssistantText,
        lastUserText,
        recentMarcoOutbounds,
      );
    }
    const finalReply = reply ?? fallbackMarcoReply(lead, meta);
    marcoLog("llm_pipeline_done", {
      requestId: log?.requestId,
      correlationId: log?.correlationId,
      reply_preview: previewText(finalReply),
      used_hardcoded_fallback: !reply,
    });
    return finalReply;
  } catch (e) {
    console.warn("[llm] generateMarcoPipelineReply failed:", e);
    marcoLog("llm_pipeline_error", {
      requestId: log?.requestId,
      correlationId: log?.correlationId,
      error: e instanceof Error ? e.message : String(e),
    });
    return fallbackMarcoReply(lead, meta);
  }
}

/**
 * Last-resort when the model still duplicates after RETROACTIVE_FIX. Phone-resistance lines only
 * make sense before capture; after number/email stages use varied non-duplicate templates.
 */
function alternatePipelineReplyFallback(
  lead: Lead,
  meta: FunnelDeterministicMeta,
  lastAssistant: string,
  lastUser: string,
  recentMarco: string[],
): string {
  if (!lead.phone) {
    const ph = alternatePhoneResistanceFallback(lastAssistant, lastUser);
    if (!candidateMatchesRecentMarco(ph, recentMarco)) return ph;
  }

  const pool: string[] = [];

  if (meta.phoneJustCaptured) {
    pool.push(
      "For sure. I'll send the full breakdown on that home with specs, pricing, and a couple similar options. Was this what you had in mind, or are you leaning toward a different area or price range?",
      "Cool. I'll text you the packet on that one plus a few backups. Does that house feel close or should we skew cheaper or a different part of town?",
    );
  }

  if (meta.listSendPromised) {
    pool.push(
      "Of course. I'll email a personalized list of matching homes. Skim it when you can and tell me what catches your eye so we can line up showings.",
      "I'll fire over a curated list to your email. When you've had a skim, text back what you want to tour first.",
    );
  }

  if (lead.phone && !lead.email) {
    pool.push(
      "Appreciate it. What email works best for options that match what you want?",
      "Got it. Best email to send listings that fit what you described?",
    );
  }

  pool.push(
    "Thanks for the detail. Want to lock in one thing first, area or budget, and I'll narrow from there?",
    "Got you. I'll keep it moving on my end, text me if anything shifts on your side.",
  );

  for (const c of pool) {
    if (!candidateMatchesRecentMarco(c, recentMarco)) {
      return c;
    }
  }

  return fallbackMarcoReply(lead, meta);
}

/** When the model still duplicates Marco's last line after retry, force a different angle. */
function alternatePhoneResistanceFallback(
  lastAssistant: string,
  lastUser: string,
): string {
  const options = [
    "Yeah fair. Best way for the full breakdown, links, and details is text so it all lands clean in one place. Whats a good number to send it over to?",
    "Totally hear you. I keep full packets on text so nothing gets missed. Whats the best number and Ill send it over right away?",
    "Got you. Quick answer, number is the best way for full details and options without losing pieces in chat. What number should I send it to?",
  ];
  const lower = lastUser.toLowerCase();
  if (/\bwhy\b.*\bnumber\b|\bnumber\b.*\?/.test(lower)) {
    return "Honestly its so I can send you links and the full listing sheets cleanly in one shot. Whats a good number and Ill send it right over.";
  }
  if (/\bsame thing\b|\bnot the same\b/.test(lower)) {
    return "Fair point. Difference is full packets and links land cleaner over text so you get everything at once. Whats a good number to send it over to?";
  }
  for (const opt of options) {
    if (!isDuplicateMarcoReply(opt, lastAssistant)) {
      return opt;
    }
  }
  return options[0];
}

function parseReplyTextJson(raw: string): string | null {
  try {
    const s = stripCodeFences(raw);
    const parsed = JSON.parse(s) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const rt = (parsed as { reply_text?: unknown }).reply_text;
    if (typeof rt !== "string" || !rt.trim()) return null;
    return rt.trim();
  } catch {
    return null;
  }
}

/**
 * Rewrites a deterministic DM in Marco's tone. Model must return ONLY JSON: {"reply_text":"..."}.
 * On any failure, returns null (caller keeps deterministic reply silently).
 */
export async function rewriteReplyWithTone(
  systemPrompt: string,
  deterministicReply: string,
  conversation: ConversationLike,
  preflightAppendix?: string,
): Promise<string | null> {
  const client = getClient();
  if (!client) {
    return null;
  }

  const instruction = `You will receive:
1) MARCO_VOICE_RULES (system prompt text)
2) CONVERSATION_HISTORY (Lead / Marco turns)
3) DETERMINISTIC_DRAFT (exact message to rewrite in Marco's voice)

Rewrite ONLY the draft. Do not add new facts, addresses, prices, listing details, or promises not already implied. Keep the same intent and CTA.
If a PREFLIGHT_NOTE is present, follow it: acknowledge repeats or stuck threads naturally; stay on the same funnel step (do not restart the intro).
Your reply_text must use only periods, commas, question marks, exclamation marks, and apostrophes. No em dashes or hyphen punctuation between clauses.

${GLOBAL_MARCO_DM_RULES}

Output ONLY valid JSON with this exact shape (no markdown, no explanation, no code fences):
{"reply_text":"your single DM message here, properly escaped for JSON"}

MARCO_VOICE_RULES:
${systemPrompt.trim()}

DETERMINISTIC_DRAFT:
${deterministicReply.trim()}`;

  const preflightBlock =
    preflightAppendix && preflightAppendix.trim().length > 0
      ? `PREFLIGHT_NOTE:\n${preflightAppendix.trim()}\n\n`
      : "";

  const context = `${preflightBlock}CONVERSATION_HISTORY:\n${formatConversationHistory(conversation)}`;

  try {
    const raw = await complete(instruction, context);
    return parseReplyTextJson(raw);
  } catch {
    return null;
  }
}

