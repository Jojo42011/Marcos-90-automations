/**
 * Anthropic client — Claude Haiku (not Sonnet) for tone / light generation when wired in.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type { Message as AnthropicMessage } from "@anthropic-ai/sdk/resources/messages";
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
import {
  type FunnelDeterministicMeta,
  extractPhoneFromConversation,
  PHONE_JUST_CAPTURED_REPLY,
} from "../../app/funnelDeterministic.js";
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
  messageAsksPropertyPriceOrCost,
  threadContainsFirstTimeBuyingQuestion,
  leadThreadSignalsExperiencedBuyer,
  signalsWantsInfoInDmOnly,
  signalsEmailDeliveryRequest,
  signalsLookingOutsideSanAntonio,
  signalsWantsBreakdownImmediately,
} from "../../app/conversationUtils.js";
import { marcoLog, marcoLogDebug, previewText, type MarcoLogContext } from "../../app/marcoLog.js";

/** Default: Claude 3.5 Haiku. Override with ANTHROPIC_MODEL in .env if needed. */
const DEFAULT_MODEL = "claude-3-5-haiku-latest";

const model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;

/** Post-opening pipeline: tight token cap so replies stay SMS-sized, not essay-length. */
const PIPELINE_REPLY_MAX_TOKENS = 200;
/** If model still returns a wall of text, one shrink retry; else alternate / fallback. */
const PIPELINE_REPLY_MAX_CHARS = 400;

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

function isInstagramPlatform(platform?: string): boolean {
  return (platform ?? "").toLowerCase().includes("insta");
}

/** Short listing-style questions: comments always; Instagram DMs use same patterns (many leads DM price/location). */
function matchesListingQuestionShortPhrase(lower: string): boolean {
  return (
    /\b(how much|how\s*much)\b/.test(lower) ||
    /\bwhat'?s the price(\s+range)?\b/.test(lower) ||
    /\bwhat is the price(\s+range)?\b/.test(lower) ||
    /\b(the )?price range\b/.test(lower) ||
    /\basking price|price check|cost(\s+of)?\b/.test(lower) ||
    /\blocation (and|&) price|price (and|&) location\b/.test(lower) ||
    /\bstill available|more info|any info|need info|send info|any details\b/.test(lower) ||
    /\bis it available\b/.test(lower) ||
    /\bsquare feet|sq\.?\s*ft|bedrooms?|bathrooms?\b/.test(lower) ||
    /\bcan we see|schedule|book a tour\b/.test(lower) ||
    /\bwhere is it|what area|where'?s it\b/.test(lower) ||
    /\bwhere (is|are) (it|this|that|the (house|home|place|listing))\b/.test(lower) ||
    /\bhow much is (it|this|that)\b/.test(lower)
  );
}

/**
 * Single-token messages: whitelist → true, else false (no API).
 * Two tokens "how much" / "price range" (normalized) → true (no API).
 * Instagram comments + Instagram DMs: short listing questions → true (no API) when pattern matches.
 * Everything else → null (run Haiku).
 */
function classifyObviousShortMessageWithoutLlm(
  text: string,
  opts?: { channel?: "comment" | "dm"; platform?: string },
): boolean | null {
  const channel = opts?.channel ?? "dm";
  const insta = isInstagramPlatform(opts?.platform);
  const listingChannel = channel === "comment" || (channel === "dm" && insta);
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
    if (listingChannel) {
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
    if ((a === "price" && b === "range") || (a === "what" && b === "price")) {
      return true;
    }
  }

  if (listingChannel && tokens.length <= 10) {
    const lower = text.toLowerCase();
    if (matchesListingQuestionShortPhrase(lower)) {
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

/** True when Fly/local env has a non-empty API key (billing may still fail at request time). */
export function isAnthropicApiKeyConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function anthropicHttpStatus(e: unknown): number | undefined {
  if (e && typeof e === "object" && "status" in e) {
    const s = (e as { status?: unknown }).status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

function isRetriableAnthropicHttpStatus(status: number | undefined): boolean {
  return status === 429 || status === 503 || status === 529;
}

type MessagesCreateParams = Parameters<Anthropic["messages"]["create"]>[0];

/**
 * One automatic retry on overload / rate limit so a funded key recovers without a silent template-only turn.
 */
async function messagesCreateWithRetry(
  client: Anthropic,
  params: MessagesCreateParams,
): Promise<AnthropicMessage> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return (await client.messages.create(params)) as AnthropicMessage;
    } catch (e) {
      lastErr = e;
      const st = anthropicHttpStatus(e);
      if (attempt < 2 && isRetriableAnthropicHttpStatus(st)) {
        await sleep(600);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
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

  const response = await messagesCreateWithRetry(client, {
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
  opts?: { channel?: "comment" | "dm"; platform?: string },
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

  const insta = isInstagramPlatform(opts?.platform);
  const igDm = insta && opts?.channel === "dm";
  const igComment = insta && opts?.channel === "comment";

  const commentNote =
    opts?.channel === "comment" && !insta
      ? `\n\nCHANNEL: This text is a COMMENT on a listing-style post. Short listing questions → prefer intent=true unless clearly spam.\n`
      : "";

  const instagramListingNote =
    igComment || igDm
      ? `\n\nINSTAGRAM_LISTING_CONTEXT: This is Instagram (${igComment ? "comment on a listing-style post" : "DM to a listing/realtor account"}). Be LENIENT: questions about price, price range, cost, location, area, address, availability, beds/baths, sqft, tours, showings, "info", or "details" on a home or the post—even very short—are intent=true. Friends/social-only messages with zero property signal (e.g. pure "hey" plans to hang out, compliments on unrelated content, inside jokes) → intent=false. Spam, crypto, unrelated jobs → intent=false. When the message could be either a lead or small talk but mentions price/location/listing/house/home/property → intent=true.\n`
      : "";

  const strictnessNote = insta
    ? "Default: if they are asking anything about a property, listing, price, or location of a home, use intent=true. When unsure between lead vs friend but there is any housing/listing signal, prefer intent=true."
    : "Be STRICT for non-Instagram channels. When unsure, use intent=false.";

  const ambiguousNote = insta
    ? "Short ambiguous phrases: if they touch price, location, or listing details → intent=true. Pure filler with no property words → intent=false."
    : "Ambiguous or borderline short phrases → intent=false.";

  const system = `You gate a real-estate buyer funnel (Instagram, TikTok, ManyChat). ${strictnessNote}
${commentNote}${instagramListingNote}
Return intent=true if the message shows interest in buying, viewing, or learning about a home or listing (including price, location, availability, specs, tours, mortgage on a purchase, neighborhood for living).

Return intent=false for:
- Greetings, acknowledgements, filler: "hey", "sup", "lol", "ok", "thanks", "yur", "yes", "no" (unless they clearly continue a property conversation in the same message)
- Pure social chat with no property, price, location, or listing hook (close friends catching up with zero house mention)
- Spam, scams, unrelated topics (crypto, jobs, random DMs)
- Selling only / listing agent pitches with no buy side
- Emojis only or meaningless fragments

${ambiguousNote}

### Examples intent=true (real buyer/property signal)
- "Is this place still available?"
- "What's the price range?" / "Location and price" / "How much?"
- "Can we see 123 Oak this weekend?"
- "What's the asking price on the home you posted?"
- "I'm pre-approved and interested in the 4 bed in Frisco"
- "Schedule a showing for the listing on Main St"
- "Does this house have a garage? We're looking to buy in this area"

### Examples intent=false (no clear property/buy intent)
- "hey" / "yur" / "what's up" / "lol ok" (alone, no house/price/location)
- "nice" / "cool video" / "love your content" (no property ask)
- "hi how are you"
- "thanks" / "ok thanks"
- "you're hot" / random flirtation with no house mention
- "can you help me grow my instagram"

Output ONLY valid JSON on one line, no markdown, no code fences:
{"intent":true}
or
{"intent":false}`;

  try {
    const response = await messagesCreateWithRetry(client, {
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
    const response = await messagesCreateWithRetry(client, {
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
      anthropic_http_status: anthropicHttpStatus(e),
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

/** Instagram DM only (comments use the legacy Instagram opening path). */
function isInstagramDm(platform?: string, channel?: "comment" | "dm"): boolean {
  return (platform ?? "").toLowerCase().includes("insta") && channel === "dm";
}

/** TikTok DM and Instagram DM share the same neutral funnel (no listing-specific close in DM). */
function isNeutralDmFlow(platform?: string, channel?: "comment" | "dm"): boolean {
  return isTikTokPlatform(platform) || isInstagramDm(platform, channel);
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
  platform: string | undefined,
  phoneOnFile: boolean,
): string {
  const lines: string[] = [];
  const assistantTurns = conversation.messages.filter((m) => m.role === "assistant").length;
  const tikTokOpenerAlreadyInThread =
    isTikTokPlatform(platform) &&
    (assistantTurns >= 1 || threadContainsFirstTimeBuyingQuestion(conversation));
  const tikTokNoPrice =
    "TIKTOK_NO_LIST_PRICE_IN_DM: TikTok DMs can be about many different homes/videos. Never state or hint list price, asking price, dollar amounts, ballpark, mid 500s, or payment estimates for the property they asked about. If they ask how much or price, do not give a number in chat. Offer the full breakdown by text first in Marco's real voice (same family as the training screenshots: yeah of course, would it help if I sent the entire breakdown of the home you inquired about, location and pricing included, that kind of beat). Do not use platform meta or AI-ish lines about TikTok being a rough place for sheets or similar. Ask for a mobile number only after they agree they want it sent. Discussing the buyer's own budget range is fine; do not quote this listing's price in DM.\n\n";
  const tikTokChannelBlock = isTikTokPlatform(platform)
    ? tikTokNoPrice +
      (tikTokOpenerAlreadyInThread
        ? "CHANNEL: tiktok_dm — Marco already has at least one outbound in this thread (often the manual first DM with the first-time buying question). Do NOT send another opener and do NOT ask about first-time vs experienced buyer or the buying process again. Answer LATEST_LEAD_MESSAGE in Marco's voice. Order: offer to text the full breakdown first when they have not agreed yet; ask for a mobile number only after they clearly want the packet sent, or on the next turn after they agree. Never recycle appreciation + first-time question.\n\n"
        : "CHANNEL: tiktok_dm — Use TikTok flow, not Instagram. If this is Marco's first line in the thread, first-time check then breakdown offer then number (after they agree to the packet) can apply; if any Marco line already exists above, skip opener scripts entirely.\n\n")
    : "";
  const igDmNeutral = isInstagramDm(platform, channel);
  const igDmOpenerAlreadyInThread =
    igDmNeutral &&
    (assistantTurns >= 1 || threadContainsFirstTimeBuyingQuestion(conversation));
  const igNeutralDmChannelBlock = igDmNeutral
    ? tikTokNoPrice +
      (igDmOpenerAlreadyInThread
        ? "CHANNEL: instagram_dm — Marco already has at least one outbound in this thread (often the manual first DM with the first-time buying question). Do NOT send another opener and do NOT ask about first-time vs experienced buyer or the buying process again. Answer LATEST_LEAD_MESSAGE in Marco's voice. Order: offer to text the full breakdown first when they have not agreed yet; ask for a mobile number only after they clearly want the packet sent, or on the next turn after they agree. Never recycle appreciation + first-time question.\n\n"
        : "CHANNEL: instagram_dm — Use the same neutral DM flow as TikTok. If this is Marco's first line in the thread, first-time check then breakdown offer then number (after they agree to the packet) can apply; if any Marco line already exists above, skip opener scripts entirely. Never quote list price in DM.\n\n")
    : "";
  const prefix = tikTokChannelBlock + igNeutralDmChannelBlock + inboundChannelBlock(channel);
  if (assistantTurns === 0 && lastUserText.trim() && !igDmNeutral && !isTikTokPlatform(platform)) {
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
  if (isNeutralDmFlow(platform, channel) && messageAsksPropertyPriceOrCost(lastUserText)) {
    lines.push(
      "PRICE_ASK_TIKTOK: They asked price or cost. Do not quote any dollar amount in DM. First beat: Marco's breakdown offer in casual voice (yeah of course, would it help if I sent the entire breakdown on the home they inquired about, location and pricing included, by text when they want it). No lecturing about the app or DMs being a rough place for sheets. Do not ask for their phone number in the same reply unless they already clearly agreed to receive the packet. After they agree, next turn can ask for a good mobile number to text it to.",
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
    if (isTikTokPlatform(platform)) {
      lines.push(
        "TIKTOK_AFTER_FIRST_TIME_ANSWER: Next step is the breakdown-offer beat only, in Marco's natural texting voice (warm, not robotic). Do not ask for a phone number in this reply unless they already clearly agreed they want the packet sent. Number ask comes after they agree to the packet, or on the following turn once they said yes to sending it.",
      );
    }
    if (igDmNeutral) {
      lines.push(
        "INSTAGRAM_DM_AFTER_FIRST_TIME_ANSWER: Next step is the breakdown-offer beat only, in Marco's natural texting voice (warm, not robotic). Do not ask for a phone number in this reply unless they already clearly agreed they want the packet sent. Number ask comes after they agree to the packet, or on the following turn once they said yes to sending it.",
      );
    }
  }
  if (signalsLookingOutsideSanAntonio(lastUserText)) {
    lines.push(
      "TEXAS_SERVICE_AREA: The lead is looking outside San Antonio or named another Texas market. In Marco's first-person voice: say you help buyers all across Texas for homes above $600k (say six hundred thousand naturally if needed). Keep it one short sentence, then continue answering their message or the listing conversation.",
    );
  }
  if (signalsWantsInfoInDmOnly(lastUserText)) {
    lines.push(
      "DM_ONLY_REQUEST_OPENING: They want the packet or details in this Instagram or TikTok DM instead of SMS. Never promise to send the full breakdown, pricing, links, or packet inside this DM thread. Do not promise you will text them until they give a mobile number. Brief empathy in Marco's casual texting voice, one short beat on why the full sheet and links land cleaner over text, then a fresh ask for a good number—different angle than MARCO_PREVIOUS_OUTBOUND. One or two short sentences.",
    );
  }
  if (!phoneOnFile) {
    lines.push(
      "NO_PHONE_NO_SMS_PROMISE_OPENING: No mobile on file yet. Never say you will text them, shoot them a text, or promise SMS or WhatsApp delivery. Never promise the full pricing breakdown or packet as something you will deliver inside this DM. You may offer that once they share a number you will text the breakdown by end of day.",
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
  if (lead.phone) {
    return PHONE_JUST_CAPTURED_REPLY;
  }
  const who = greetingNameForOpening(lead);
  const neutralDm = isNeutralDmFlow(inboundPlatform, inboundChannel);
  if (openingStage === FunnelStage.New) {
    if (neutralDm) {
      const hey = who !== "there" ? `Thanks for reaching out ${who}!` : "Thanks for reaching out!";
      if (signalsTourOrScheduleIntent(lastUserText)) {
        return `${hey} I'd love to help. Want me to send the full breakdown on that place first, specs and timing, then we can line up a tour from there?`;
      }
      if (messageAsksListingLocation(lastUserText)) {
        return `${hey} It's west of Stone Oak. Want me to text you the full breakdown on that home when you're ready, specs and all?`;
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
    if (neutralDm) {
      const lastLower = lastUserText.trim().toLowerCase();
      const conv: Conversation = conversation ?? { messages: [] };
      const experiencedInLine =
        /\bown multiple\b/.test(lastLower) ||
        /\b(not at all|already been through|not my first|not a first)\b/.test(lastLower) ||
        /\b(i'?ve|have)\s+(already\s+)?(bought|owned)\b/.test(lastLower);
      const notFirstOrExperienced =
        /^no\b/.test(lastLower) ||
        /^not at all\b/.test(lastLower) ||
        /\bnot my first\b/.test(lastLower) ||
        /\bisn'?t\b/.test(lastLower) ||
        /\bisnt\b/.test(lastLower) ||
        experiencedInLine ||
        leadThreadSignalsExperiencedBuyer(conv);
      if (signalsBrowsingOrPriceDeflection(lastUserText)) {
        return "Got it, just looking is totally fine. Want me to send the full breakdown on that place by text when you want to peek, specs and pricing?";
      }
      if (messageAsksListingLocation(lastUserText) && messageAsksPropertyPriceOrCost(lastUserText)) {
        return "Yeah of course, it's west of Stone Oak. Would it help if I just sent the entire breakdown on the home you inquired about, location and pricing included?";
      }
      if (messageAsksPropertyPriceOrCost(lastUserText)) {
        return "Yeah of course, would it help if I just sent the entire breakdown of the home you inquired about, location and pricing included?";
      }
      if (notFirstOrExperienced) {
        return "Ahh gotcha of course, would it help if I sent over the entire breakdown of the property you inquired about?";
      }
      return "Oh awesome, would it help if I sent the entire breakdown over of the home you inquired about?";
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
  if (lead.phone) {
    return PHONE_JUST_CAPTURED_REPLY;
  }
  const recent = getRecentAssistantTexts(conversation, 5);
  const neutralDm = isNeutralDmFlow(inboundPlatform, inboundChannel);
  const pool: string[] = [];
  if (neutralDm) {
    pool.push(
      "Would it help if I sent over the entire breakdown for that home, specs and pricing by text when you want it?",
      "Ahh gotcha. Want me to line up the full packet on that place for you by text first?",
    );
  }
  if (/\bva\b|veteran|military|gi\b/i.test(lastUserText)) {
    pool.push(
      neutralDm
        ? "VA helps a ton on the payment side. What's the best number to text you the full breakdown and a few similar homes?"
        : "VA helps a ton on the payment side, we can walk real numbers when you want. What's the best number to text you the spec sheet and a few similar homes?",
    );
  }
  if (leadTextSignalsNoAgent(lastUserText)) {
    pool.push(
      neutralDm
        ? "Got you. What's a good number I can send the full breakdown and a couple backup listings to?"
        : "Got you. What's a good number I can send the full breakdown and a couple backup listings to?",
      neutralDm
        ? "Cool, since you're rolling solo on this, what number works best for me to text you the packet?"
        : "Cool, since you're rolling solo on this, what number works best for me to text you the packet?",
    );
  }
  if (openingStage === FunnelStage.OpeningOfferedDetails || openingStage === FunnelStage.OpeningAskedFirstTime) {
    if (neutralDm) {
      pool.push(
        "Fair enough. Want me to send the full breakdown on this one by text when you're ready?",
        "I can line up a tour once I know your schedule, what days are easiest? If you want the spec sheet first I can text it over once you're cool with that.",
      );
    } else {
      pool.push(
        "Fair enough. Want me to text you the breakdown on this one? What's the best number?",
        "I can line up a tour once I know your schedule, what days are easiest? If you want the spec sheet first, drop a number and I'll send it.",
      );
    }
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
  if (neutralDm) {
    return "Want me to send the full breakdown on that place by text when you're ready, specs and pricing?";
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
    out = extractPhoneFromConversation(conversation)
      ? PHONE_JUST_CAPTURED_REPLY
      : isNeutralDmFlow(inboundPlatform, inboundChannel)
        ? "Want me to send the full breakdown on that home by text when you're ready, specs and pricing?"
        : "What's the best number to text you the spec sheet on this house?";
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
  const out = alternatePipelineReplyFallback(lead, meta, lastA, lastU, recent, lead.platform, "dm");
  marcoLog("sanitize_pipeline_result", {
    requestId: log?.requestId,
    correlationId: log?.correlationId,
    out_preview: previewText(out),
  });
  return out;
}

function fallbackMarcoReply(
  lead: Lead,
  meta: FunnelDeterministicMeta,
  platform?: string,
  channel?: "comment" | "dm",
): string {
  if (meta.phoneJustCaptured) {
    return PHONE_JUST_CAPTURED_REPLY;
  }
  if (meta.listSendPromised) {
    return (
      "For sure. I'll text you a personalized list of homes that match what you said. " +
      "Skim when you can and tell me what you want to tour first."
    );
  }
  if (!lead.phone) {
    return "Of course. Is there a good number I can reach you at to send you more info?";
  }
  return "Thanks, I'm on it and will keep this moving.";
}

/** Marco-toned last resort when they asked for email delivery; avoids generic number-ask repeat. */
const EMAIL_DELIVERY_PIPELINE_FALLBACK =
  "Honestly the full breakdown is way easier to read over text, links dont always come through clean on email. Whats a good number?";

function fallbackMarcoPipelineReply(
  lead: Lead,
  meta: FunnelDeterministicMeta,
  lastUser: string,
  recentMarco?: string[],
  platform?: string,
  channel: "comment" | "dm" = "dm",
): string {
  const neutralDm = isNeutralDmFlow(platform ?? lead.platform, channel);
  if (neutralDm) {
    const who = greetingNameForOpening(lead);
    const hey = who !== "there" ? `Thanks for reaching out ${who}!` : "Thanks for reaching out!";
    if (messageAsksPropertyPriceOrCost(lastUser)) {
      return "Yeah of course, would it help if I just sent the entire breakdown of the home you inquired about, location and pricing included?";
    }
    if (messageAsksListingLocation(lastUser)) {
      return `${hey} It's west of Stone Oak. Want me to text you the full breakdown on that home when you're ready, specs and all?`;
    }
    if (!lead.phone) {
      return "Of course. Is there a good number I can reach you at to send you more info?";
    }
  }
  if (
    !lead.phone &&
    !meta.phoneJustCaptured &&
    !meta.listSendPromised &&
    signalsEmailDeliveryRequest(lastUser)
  ) {
    if (!recentMarco?.length || !candidateMatchesRecentMarco(EMAIL_DELIVERY_PIPELINE_FALLBACK, recentMarco)) {
      return EMAIL_DELIVERY_PIPELINE_FALLBACK;
    }
  }
  return fallbackMarcoReply(lead, meta, platform, channel);
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
    Boolean(lead.phone?.trim()),
  );

  const openingDeliveryBlock =
    "PHONE_ONLY_DELIVERY: Use SMS/text to their phone for breakdowns and options. Never ask phone or email, never offer email.\n\n";

  const userBlock =
    contextPrefix +
    openingDeliveryBlock +
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
    const response = await messagesCreateWithRetry(client, {
      model,
      max_tokens: 900,
      system: isNeutralDmFlow(inboundPlatform, inboundChannel)
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
        `\n\nRETROACTIVE_FIX: Your draft matches or nearly matches a prior Marco line in this thread. Output ONLY valid JSON with a new "reply" that (1) answers LATEST_LEAD_MESSAGE directly, (2) never repeats or paraphrases any prior Marco message, (3) if the agent question was already asked above and the lead answered, move to the next step (usually phone number to send details), (4) one or two short sentences, (5) never em dashes or en dashes, no exceptions, no hyphen pauses between phrases.`;
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
      anthropic_http_status: anthropicHttpStatus(e),
      model,
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
    criteria: lead.criteria,
    phone_just_captured: Boolean(meta.phoneJustCaptured),
    list_send_promised: Boolean(meta.listSendPromised),
  };

  const lastUserText = getLastUserMessageText(conversation);
  const lastAssistantText = getLastAssistantMessageText(conversation);
  const recentMarcoOutbounds = getRecentAssistantTexts(conversation, 5);
  const postOpeningHints: string[] = [];
  const neutralDmPipeline = isNeutralDmFlow(inboundPlatform, inboundChannel);
  const canPromiseSms = Boolean(lead.phone?.trim()) || meta.phoneJustCaptured;
  if (!canPromiseSms) {
    postOpeningHints.push(
      "NO_PHONE_ON_FILE: No mobile number captured yet (unless phone_just_captured in FUNNEL_CONTEXT is true). Never say you will text them, shoot a text, or promise SMS or WhatsApp delivery of the breakdown, pricing, or packet. Never promise the full breakdown or pricing packet inside TikTok or Instagram DM as the delivery path. You may offer that once they share a number you will text the full breakdown by end of day. If they want info in-app only, acknowledge in Marco's casual voice and persist toward a good number—links and full sheet read cleaner in one text thread—fresh wording, not a copy of MARCO_PREVIOUS_OUTBOUND.",
    );
  }
  if (isTikTokPlatform(inboundPlatform)) {
    postOpeningHints.push(
      "TIKTOK_NO_LIST_PRICE_IN_DM: Never quote list price, ballpark, mid 500s, or dollar amounts for the specific property in chat. If they ask cost, use Marco's breakdown-offer voice from training (yeah of course, would it help if I sent the entire breakdown, location and pricing included by text), not platform meta about TikTok or DMs being a rough place for sheets. Offer the breakdown by text first; mobile number only after they clearly want it sent. Buyer budget criteria is ok to discuss.",
    );
  }
  if (isInstagramDm(inboundPlatform, inboundChannel)) {
    postOpeningHints.push(
      "INSTAGRAM_DM_NEUTRAL_FLOW: Same neutral DM rules as TikTok. Never quote list price, ballpark, mid 500s, or dollar amounts for the specific property in chat. Offer the full breakdown by text first; mobile number only after they clearly want it sent. First-time buyer question drives engagement when Marco has not already asked it in the thread.",
    );
  }
  if (!neutralDmPipeline && isInstagramPlatform(inboundPlatform)) {
    postOpeningHints.push(
      "INSTAGRAM_FLOW: Keep Marco's Instagram cadence from training threads. Direct price or location asks should get a direct practical answer first, then a soft qualifier. If they react to value (high, low, fair), validate briefly and offer full breakdown in Marco voice. Number ask usually comes after value or explicit agreement, not as first move. Keep it concise and human.",
    );
  }
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
  if (neutralDmPipeline && messageAsksPropertyPriceOrCost(lastUserText)) {
    postOpeningHints.push(
      "PRICE_ASK_TIKTOK: No dollar amounts in DM. First beat is the entire-breakdown offer in Marco's casual texting voice (same shape as screenshots: would it help if I sent the breakdown on the home they inquired about, location and pricing included). No app or DM quality lectures. Ask for a mobile number only after they agree they want it sent.",
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
  if (signalsWantsInfoInDmOnly(lastUserText)) {
    postOpeningHints.push(
      "DM_ONLY_REQUEST: They want the breakdown or packet in Instagram or TikTok DM instead of SMS. Never promise to send the full breakdown, pricing, links, or packet inside this DM thread. Do not promise you will text them until a number is on file. One or two short sentences: brief empathy in Marco's voice, one casual beat on why a number is smoother for the full sheet and links, then a fresh mobile ask—not the same wording as MARCO_PREVIOUS_OUTBOUND. Optional: one allowed non-price DM fact (e.g. west of Stone Oak if they asked area). No paragraphs.",
    );
  }
  if (signalsEmailDeliveryRequest(lastUserText)) {
    postOpeningHints.push(
      "EMAIL_DELIVERY_ASK: They asked to get the packet or details by email. Answer that directly in casual Marco voice, not corporate. One short honest line on why text is better here (links, full breakdown readable). Then ask for a mobile number in fresh wording, not the same sentence as MARCO_PREVIOUS_OUTBOUND. Never offer to send by email.",
    );
  }
  if (signalsWantsBreakdownImmediately(lastUserText)) {
    postOpeningHints.push(
      "BREAKDOWN_URGENCY: The lead wants the full breakdown ASAP or right now. Acknowledge the rush, but do NOT agree to send it immediately. Explain briefly you have to put together the full pricing and breakdown sheet so it is accurate, and commit to sending it by the end of the day. Keep it short and human, no excuses.",
    );
  }
  if (signalsLookingOutsideSanAntonio(lastUserText)) {
    postOpeningHints.push(
      "TEXAS_SERVICE_AREA: Lead is searching outside San Antonio or named another Texas area. In Marco's first-person voice: you help buyers across Texas for homes above $600k. One short beat, then continue the thread.",
    );
  }
  if (meta.phoneJustCaptured) {
    postOpeningHints.push(
      "END_OF_DAY_DELIVERY_ONLY: They just shared their number this turn. Confirm you will text the full breakdown (pricing, specs, similar options if relevant) by END OF DAY today. Never say immediately, right now, right away, sending it now, or any phrase that promises instant delivery.",
    );
  }
  const postOpeningPrefix =
    inboundChannelBlock(inboundChannel) +
    "PHONE_ONLY_DELIVERY: Send breakdowns and listing options by text/SMS to their phone number only. Never ask phone or email, never offer email, never ask for email. If they sent an email, thank them briefly and still get a mobile number to text the packet.\n\n" +
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
    return fallbackMarcoPipelineReply(lead, meta, lastUserText, undefined, inboundPlatform, inboundChannel);
  }

  const runOnce = async (blockContent: string) => {
    const t0 = Date.now();
    const response = await messagesCreateWithRetry(client, {
      model,
      max_tokens: PIPELINE_REPLY_MAX_TOKENS,
      system: isNeutralDmFlow(inboundPlatform, inboundChannel)
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
        `\n\nRETROACTIVE_FIX: Your draft matches or nearly matches a prior Marco line in CONVERSATION. Output ONLY valid JSON with a new "reply" that (1) answers LATEST_LEAD_MESSAGE, (2) does not reuse prior Marco wording or structure, (3) if a question was already asked and answered in the thread, advance instead of re-asking, (4) one or two short sentences, (5) never em dashes or en dashes, no exceptions, no hyphen pauses between phrases` +
        ", (6) never offer email or phone-or-email choice.";
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
        inboundPlatform,
        inboundChannel,
      );
    }
    if (reply && reply.length > PIPELINE_REPLY_MAX_CHARS) {
      marcoLog("llm_pipeline_reply_too_long", {
        requestId: log?.requestId,
        correlationId: log?.correlationId,
        reply_chars: reply.length,
        max_chars: PIPELINE_REPLY_MAX_CHARS,
        draft_preview: previewText(reply),
      });
      const shrinkBlock =
        userBlock +
        `\n\nBREVITY_FIX: Your previous draft was ${reply.length} characters (max ${PIPELINE_REPLY_MAX_CHARS}). Output ONLY valid JSON with "reply" as ONE or TWO short sentences, total under ${PIPELINE_REPLY_MAX_CHARS} characters. ` +
        "Do NOT promise to send pricing, the full breakdown, or links in this DM. Brief empathy, then redirect to text on a number for that property's details. Do not reuse MARCO_PREVIOUS_OUTBOUND wording. No em dashes.";
      const shrunk = await runOnce(shrinkBlock);
      if (
        shrunk &&
        shrunk.length <= PIPELINE_REPLY_MAX_CHARS &&
        !candidateMatchesRecentMarco(shrunk, recentMarcoOutbounds)
      ) {
        reply = shrunk;
      } else {
        reply = alternatePipelineReplyFallback(
          lead,
          meta,
          lastAssistantText,
          lastUserText,
          recentMarcoOutbounds,
          inboundPlatform,
          inboundChannel,
        );
      }
    }
    const finalReply =
      reply ??
      fallbackMarcoPipelineReply(lead, meta, lastUserText, recentMarcoOutbounds, inboundPlatform, inboundChannel);
    marcoLog("llm_pipeline_done", {
      requestId: log?.requestId,
      correlationId: log?.correlationId,
      reply_preview: previewText(finalReply),
      used_hardcoded_fallback: !reply,
      reply_chars: finalReply.length,
    });
    return finalReply;
  } catch (e) {
    console.warn("[llm] generateMarcoPipelineReply failed:", e);
    marcoLog("llm_pipeline_error", {
      requestId: log?.requestId,
      correlationId: log?.correlationId,
      error: e instanceof Error ? e.message : String(e),
      anthropic_http_status: anthropicHttpStatus(e),
      model,
    });
    return fallbackMarcoPipelineReply(lead, meta, lastUserText, recentMarcoOutbounds, inboundPlatform, inboundChannel);
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
  platform?: string,
  channel: "comment" | "dm" = "dm",
): string {
  if (!lead.phone) {
    const ph = alternatePhoneResistanceFallback(lastAssistant, lastUser);
    if (!candidateMatchesRecentMarco(ph, recentMarco)) return ph;
  }

  const pool: string[] = [];

  if (meta.phoneJustCaptured) {
    pool.push(
      PHONE_JUST_CAPTURED_REPLY,
      "Cool. I'll get you the full packet by the end of the day plus a few backups. Does that house feel close or should we skew cheaper or a different part of town?",
    );
  }

  if (meta.listSendPromised) {
    pool.push(
      "For sure. I'll text you a list of matching homes. Skim when you can and tell me what you want to tour first.",
      "I'll fire over a curated list by text. When you've had a skim, text back what you want to see first.",
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

  return fallbackMarcoPipelineReply(lead, meta, lastUser, recentMarco, platform, channel);
}

/** When the model still duplicates Marco's last line after retry, force a different angle. */
function alternatePhoneResistanceFallback(
  lastAssistant: string,
  lastUser: string,
): string {
  if (signalsEmailDeliveryRequest(lastUser) && !isDuplicateMarcoReply(EMAIL_DELIVERY_PIPELINE_FALLBACK, lastAssistant)) {
    return EMAIL_DELIVERY_PIPELINE_FALLBACK;
  }
  const options = [
    "Yeah fair. Best way for the full breakdown, links, and details is text so it all lands clean in one place. Whats a good number to send it over to?",
    "Totally hear you. I keep full packets on text so nothing gets missed. Whats the best number and Ill text you the full breakdown by end of day once I pull it together?",
    "Got you. Quick answer, number is the best way for full details and options without losing pieces in chat. What number should I send it to?",
  ];
  const lower = lastUser.toLowerCase();
  if (/\bwhy\b.*\bnumber\b|\bnumber\b.*\?/.test(lower)) {
    return "Honestly its so I can send you links and the full listing sheets cleanly in one shot. Whats a good number and Ill text you everything by end of day.";
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
Your reply_text must never contain em dashes or en dashes, no exceptions (they read AI-written and kill human DM tone). Use only periods, commas, question marks, exclamation marks, and apostrophes. No hyphen or spaced hyphen as a pause between clauses.

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

