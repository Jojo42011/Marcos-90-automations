"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAnthropicApiKeyConfigured = isAnthropicApiKeyConfigured;
exports.classifyAnthropicFailure = classifyAnthropicFailure;
exports.failOpenReport = failOpenReport;
exports.complete = complete;
exports.getAnthropicModel = getAnthropicModel;
exports.classifyNewLeadBuyingIntent = classifyNewLeadBuyingIntent;
exports.anthropicLiveCheck = anthropicLiveCheck;
exports.preflightLeadTurnReview = preflightLeadTurnReview;
exports.sanitizeOpeningReplyAgainstRecentMarco = sanitizeOpeningReplyAgainstRecentMarco;
exports.sanitizePipelineReplyAgainstRecentMarco = sanitizePipelineReplyAgainstRecentMarco;
exports.generateMarcoOpeningReply = generateMarcoOpeningReply;
exports.generateMarcoPipelineReply = generateMarcoPipelineReply;
exports.rewriteReplyWithTone = rewriteReplyWithTone;
/**
 * Anthropic client — Claude Haiku (not Sonnet) for tone / light generation when wired in.
 */
require("dotenv/config");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const prompts_js_1 = require("../../../config/prompts.js");
const state_js_1 = require("../../core/state.js");
const funnelDeterministic_js_1 = require("../../app/funnelDeterministic.js");
const conversationUtils_js_1 = require("../../app/conversationUtils.js");
const marcoLog_js_1 = require("../../app/marcoLog.js");
const db_js_1 = require("../../core/db.js");
const index_js_1 = require("../simplyrets/index.js");
const listingMatch_js_1 = require("../../core/listingMatch.js");
const listingsStore_js_1 = require("../../core/listingsStore.js");
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
function normalizeIntentToken(token) {
    return token
        .trim()
        .toLowerCase()
        .replace(/^[@#]+/, "")
        .replace(/[.?!,;:…]+$/u, "");
}
function isInstagramPlatform(platform) {
    return (platform ?? "").toLowerCase().includes("insta");
}
/** Short listing-style questions: comments always; Instagram DMs use same patterns (many leads DM price/location). */
function matchesListingQuestionShortPhrase(lower) {
    return (/\b(how much|how\s*much)\b/.test(lower) ||
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
        /\bhow much is (it|this|that)\b/.test(lower));
}
/**
 * Single-token messages: whitelist → true, else false (no API).
 * Two tokens "how much" / "price range" (normalized) → true (no API).
 * Instagram comments + Instagram DMs: short listing questions → true (no API) when pattern matches.
 * Everything else → null (run Haiku).
 */
function classifyObviousShortMessageWithoutLlm(text, opts) {
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
            if (commentOne.has(w))
                return true;
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
function getClient() {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key)
        return null;
    return new sdk_1.default({ apiKey: key });
}
/** True when Fly/local env has a non-empty API key (billing may still fail at request time). */
function isAnthropicApiKeyConfigured() {
    return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
const FAIL_OPEN_LOG = [];
const FAIL_OPEN_MAX = 200;
/** Classify why a call failed, because the answers are different per cause. */
function classifyAnthropicFailure(e) {
    const status = anthropicHttpStatus(e);
    const message = e instanceof Error ? e.message : String(e);
    const lower = message.toLowerCase();
    let kind = "other";
    if (status === 401 || status === 403)
        kind = "auth";
    else if (lower.includes("credit balance") || lower.includes("billing") || lower.includes("quota"))
        kind = "credit";
    else if (status === 429)
        kind = "rate_limit";
    else if (status === 529 || status === 503)
        kind = "overloaded";
    else if (status === 400)
        kind = "bad_request";
    else if (!status)
        kind = "network";
    return { kind, status, message };
}
function recordFailOpen(e) {
    const c = classifyAnthropicFailure(e);
    FAIL_OPEN_LOG.push({ at: new Date().toISOString(), status: c.status, kind: c.kind, message: c.message.slice(0, 300) });
    if (FAIL_OPEN_LOG.length > FAIL_OPEN_MAX)
        FAIL_OPEN_LOG.splice(0, FAIL_OPEN_LOG.length - FAIL_OPEN_MAX);
}
/** Recent fail-opens, newest first, with a count per cause. */
function failOpenReport(sinceMinutes = 120) {
    const cutoff = Date.now() - sinceMinutes * 60_000;
    const recent = FAIL_OPEN_LOG.filter((e) => new Date(e.at).getTime() >= cutoff);
    const byKind = {};
    for (const e of recent)
        byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    return { total: recent.length, sinceMinutes, byKind, recent: recent.slice(-25).reverse() };
}
function anthropicHttpStatus(e) {
    if (e && typeof e === "object" && "status" in e) {
        const s = e.status;
        return typeof s === "number" ? s : undefined;
    }
    return undefined;
}
function isRetriableAnthropicHttpStatus(status) {
    return status === 429 || status === 503 || status === 529;
}
/**
 * One automatic retry on overload / rate limit so a funded key recovers without a silent template-only turn.
 */
async function messagesCreateWithRetry(client, params) {
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            return (await client.messages.create(params));
        }
        catch (e) {
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
async function complete(prompt, context) {
    const client = getClient();
    if (!client) {
        throw new Error("ANTHROPIC_API_KEY is not set");
    }
    const userContent = context.trim().length > 0
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
function getAnthropicModel() {
    return model;
}
/**
 * Haiku intent gate: true only when the message clearly signals buyer / property interest.
 * On missing API key or parse/API errors, returns true (fail-open so real leads are not dropped).
 */
async function classifyNewLeadBuyingIntent(message, opts) {
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
        FAIL_OPEN_LOG.push({ at: new Date().toISOString(), status: undefined, kind: "no_api_key",
            message: "ANTHROPIC_API_KEY is not set" });
        return true;
    }
    const insta = isInstagramPlatform(opts?.platform);
    const igDm = insta && opts?.channel === "dm";
    const igComment = insta && opts?.channel === "comment";
    const commentNote = opts?.channel === "comment" && !insta
        ? `\n\nCHANNEL: This text is a COMMENT on a listing-style post. Short listing questions → prefer intent=true unless clearly spam.\n`
        : "";
    const instagramListingNote = igComment || igDm
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
        const parsed = JSON.parse(stripCodeFences(block.text));
        if (!parsed || typeof parsed !== "object")
            return true;
        const intent = parsed.intent;
        if (intent === false)
            return false;
        if (intent === true)
            return true;
        return true;
    }
    catch (e) {
        /* Fail-open is deliberate — a real buyer must not be dropped because the
           API hiccuped — but it is recorded, because from the outside this is
           indistinguishable from the agent choosing to reply to everyone. */
        recordFailOpen(e);
        console.warn("[llm] classifyNewLeadBuyingIntent failed — fail-open:", e);
        return true;
    }
}
/**
 * One minimal live call, purely to answer "is the key actually working?".
 *
 * The /health endpoint reports `api_key_configured`, which only says the
 * variable is set — it has never proved the key can bill a request. An expired
 * card or an exhausted rate limit looks identical to a healthy system there,
 * while every intent check quietly fails open behind it.
 */
async function anthropicLiveCheck() {
    const started = Date.now();
    const client = getClient();
    if (!client) {
        return { ok: false, model, latencyMs: 0, kind: "no_api_key", error: "ANTHROPIC_API_KEY is not set" };
    }
    try {
        await client.messages.create({ model, max_tokens: 1, messages: [{ role: "user", content: "ok" }] });
        return { ok: true, model, latencyMs: Date.now() - started };
    }
    catch (e) {
        const c = classifyAnthropicFailure(e);
        return { ok: false, model, latencyMs: Date.now() - started, kind: c.kind, status: c.status, error: c.message.slice(0, 400) };
    }
}
function formatConversationHistory(c) {
    if (!c.messages.length)
        return "(no prior messages)";
    return c.messages
        .map((m) => `${m.role === "user" ? "Lead" : "Marco"}: ${m.text}`)
        .join("\n");
}
/**
 * Strip optional ```json fences from model output.
 */
function stripCodeFences(raw) {
    let s = raw.trim();
    const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(s);
    if (fence)
        s = fence[1].trim();
    return s;
}
function parsePreflightJson(raw) {
    try {
        const s = stripCodeFences(raw);
        const parsed = JSON.parse(s);
        if (!parsed || typeof parsed !== "object")
            return null;
        const o = parsed;
        const repeatedMessage = o.repeated_message === true;
        const coachingNote = typeof o.coaching_note === "string" ? o.coaching_note.trim() : "";
        return { repeatedMessage, coachingNote };
    }
    catch {
        return null;
    }
}
const DEFAULT_REPEAT_COACHING = "The lead may have repeated the same message; acknowledge briefly, stay on the current funnel step, do not restart from the beginning, and do not repeat or closely mirror Marco's prior outbound. Advance the thread in a new direction. If they are resisting giving a phone number, reply to their exact words in one or two short sentences, never reuse canned resistance lines, vary the ask each time. If the latest lead tone is resistant or negative, avoid upbeat affirmations and match their sentiment. Keep moving naturally through Marco's framework: value, then agent context, then number ask.";
/**
 * Before modules/reply: full thread → repeat signal + short coaching (2+ user messages only).
 * Combined with deterministic duplicate detection in the pipeline.
 */
async function preflightLeadTurnReview(input, log) {
    const transcript = input.conversation.messages
        .map((m) => `${m.role === "user" ? "Lead" : "Marco"}: ${m.text}`)
        .join("\n");
    const client = getClient();
    if (!client) {
        const repeatedMessage = (0, conversationUtils_js_1.isLastUserMessageRepeated)(input.conversation);
        const out = {
            repeatedMessage,
            coachingNote: repeatedMessage ? DEFAULT_REPEAT_COACHING : "",
        };
        (0, marcoLog_js_1.marcoLog)("preflight_skip", {
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
            system: prompts_js_1.prompts.preflightTurnReview.trim(),
            messages: [{ role: "user", content: userBlock }],
        });
        const block = response.content[0];
        if (block.type !== "text") {
            const repeatedMessage = (0, conversationUtils_js_1.isLastUserMessageRepeated)(input.conversation);
            (0, marcoLog_js_1.marcoLog)("preflight_bad_block", {
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
            (0, marcoLog_js_1.marcoLog)("preflight_haiku", {
                requestId: log?.requestId,
                correlationId: log?.correlationId,
                repeated_message: parsed.repeatedMessage,
                coaching_preview: (0, marcoLog_js_1.previewText)(parsed.coachingNote, 280),
            });
            (0, marcoLog_js_1.marcoLogDebug)("preflight_haiku_full_coaching", {
                requestId: log?.requestId,
                correlationId: log?.correlationId,
                coaching_note: parsed.coachingNote || "",
            });
            return parsed;
        }
        const repeatedMessage = (0, conversationUtils_js_1.isLastUserMessageRepeated)(input.conversation);
        (0, marcoLog_js_1.marcoLog)("preflight_parse_fallback", {
            requestId: log?.requestId,
            correlationId: log?.correlationId,
            repeated_message: repeatedMessage,
        });
        return {
            repeatedMessage,
            coachingNote: repeatedMessage ? DEFAULT_REPEAT_COACHING : "",
        };
    }
    catch (e) {
        console.warn("[llm] preflightLeadTurnReview failed:", e);
        const repeatedMessage = (0, conversationUtils_js_1.isLastUserMessageRepeated)(input.conversation);
        (0, marcoLog_js_1.marcoLog)("preflight_error_fallback", {
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
function parsePipelineReplyJson(raw) {
    try {
        const s = stripCodeFences(raw);
        const parsed = JSON.parse(s);
        if (!parsed || typeof parsed !== "object")
            return null;
        const r = parsed.reply;
        if (typeof r !== "string" || !r.trim())
            return null;
        return r.trim();
    }
    catch {
        return null;
    }
}
function greetingNameForOpening(lead) {
    if (lead.name?.trim()) {
        return lead.name.trim();
    }
    const u = lead.username?.trim();
    if (!u)
        return "there";
    const first = u.split(/[._]/)[0] ?? u;
    if (!/^[a-zA-Z]+$/.test(first))
        return "there";
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}
/** Lead's message centers on seeing the home / scheduling, not generic interest. */
function signalsTourOrScheduleIntent(text) {
    return /\b(schedule|set up|book|line up|tour|showing|walkthrough|see (the |this )?(home|house|place|property)|visit|when can we|can we see|come (by|see)|stop by)\b/i.test(text);
}
/** Lead is deflecting price pressure or early capture. */
function signalsBrowsingOrPriceDeflection(text) {
    const t = text.toLowerCase();
    return (/\bjust browsing\b/.test(t) ||
        /\bnot worried about (the )?price\b/.test(t) ||
        /\bprice (doesn|isn)'t matter\b/.test(t) ||
        /\bnot (really )?about (the )?price\b/.test(t) ||
        /\bjust looking\b/.test(t) ||
        /\bno rush\b/.test(t));
}
function isTikTokPlatform(platform) {
    return (platform ?? "").toLowerCase().includes("tik");
}
/** Instagram DM only (comments use the legacy Instagram opening path). */
function isInstagramDm(platform, channel) {
    return (platform ?? "").toLowerCase().includes("insta") && channel === "dm";
}
/** Dynamic rule reinforcement based on current message intent (Marco feedback). */
function getDynamicRuleReinforcement(userMessage) {
    const msg = userMessage.toLowerCase();
    const rules = [];
    if (msg.includes("show") ||
        msg.includes("visit") ||
        msg.includes("see it") ||
        msg.includes("available today") ||
        msg.includes("can i come")) {
        rules.push("ACTIVE RULE, SHOWING REQUEST DETECTED: Do NOT confirm a same-day showing. Check schedule and guide toward tomorrow. Use: \"Let me check my schedule. I am typically more available in the afternoons. Would tomorrow work for you?\"");
    }
    if ((msg.includes("price") ||
        msg.includes("cost") ||
        msg.includes("how much") ||
        msg.includes("what is it listed")) &&
        (msg.includes("asap") ||
            msg.includes("now") ||
            msg.includes("today") ||
            msg.includes("urgent") ||
            msg.includes("right now"))) {
        rules.push("ACTIVE RULE, URGENT PRICE REQUEST DETECTED: Do NOT guess or state a price. Use: \"Let me get that over to you as soon as possible. I'm currently on the move and not at my desk, but I will send all the details as soon as I'm able.\"");
    }
    if (msg.includes("email") ||
        msg.includes("send me") ||
        msg.includes("more options") ||
        msg.includes("more listings")) {
        rules.push("ACTIVE RULE, EMAIL/OPTIONS REQUEST: Only offer email AFTER phone number is captured. If phone is not yet captured, get the phone number first before offering to send anything via email.");
    }
    if ((msg.includes("house") ||
        msg.includes("home") ||
        msg.includes("property") ||
        msg.includes("listing")) &&
        !msg.includes("stone oak") &&
        !msg.includes("canyon lake") &&
        !msg.includes("new braunfels") &&
        !msg.includes("san antonio")) {
        rules.push("ACTIVE RULE, AMBIGUOUS PROPERTY REFERENCE: Ask which property or video they are referring to. Use screenshot language from GLOBAL rules if property is unknown. Do NOT assume which property they mean.");
    }
    if (rules.length === 0)
        return "";
    return "\n\nACTIVE SITUATION RULES FOR THIS MESSAGE:\n" + rules.join("\n");
}
/** TikTok DM and Instagram DM share the same neutral funnel (no listing-specific close in DM). */
function isNeutralDmFlow(platform, channel) {
    return isTikTokPlatform(platform) || isInstagramDm(platform, channel);
}
/**
 * hasKnownListing = Boolean(lead.adCampaign) — true only when this thread matched a
 * known ad campaign (a real, current listing with confirmed pricing). Most comments
 * are on posts with no such match (detectAdCampaign only recognizes specific ad
 * copy), so the default here is NEVER invent a price for a post Marco hasn't
 * confirmed pricing for — matches Marco's explicit rule: price only on his own
 * listings, breakdown-by-text offer otherwise.
 */
function inboundChannelBlock(channel, hasKnownListing) {
    if (channel === "comment") {
        const priceRule = hasKnownListing
            ? "Price ballpark for this confirmed listing is fine per your rules."
            : "Do NOT state, hint, or estimate a specific price or dollar amount for this post. You do not have confirmed pricing for it. Acknowledge the price question, then offer to send the full breakdown by text (location and pricing included) once they share a mobile number.";
        return ("CHANNEL: instagram_comment. The lead's latest line came from a COMMENT on your post (ManyChat comment automation). " +
            "Treat it like a short public-adjacent question: answer what they asked first (info, location per your rules, tour, availability). " +
            priceRule + " " +
            "Do not ignore 'how much', 'price', 'info', or 'where' style asks — always respond to them, just without guessing a number. Stay concise.\n\n");
    }
    return "";
}
function openingContextAppendix(lastUserText, conversation, channel, platform, phoneOnFile, hasKnownListing) {
    const lines = [];
    const assistantTurns = conversation.messages.filter((m) => m.role === "assistant").length;
    const tikTokOpenerAlreadyInThread = isTikTokPlatform(platform) &&
        (assistantTurns >= 1 || (0, conversationUtils_js_1.threadContainsFirstTimeBuyingQuestion)(conversation));
    const tikTokNoPrice = "TIKTOK_NO_LIST_PRICE_IN_DM: TikTok DMs can be about many different homes/videos. Never state or hint list price, asking price, dollar amounts, ballpark, mid 500s, or payment estimates for the property they asked about. If they ask how much or price, do not give a number in chat. Offer the full breakdown by text first in Marco's real voice (same family as the training screenshots: yeah of course, would it help if I sent the entire breakdown of the home you inquired about, location and pricing included, that kind of beat). Do not use platform meta or AI-ish lines about TikTok being a rough place for sheets or similar. Offer the breakdown AND ask for the mobile number in the SAME reply; do not wait a turn for them to agree first. Discussing the buyer's own budget range is fine; do not quote this listing's price in DM.\n\n";
    const tikTokChannelBlock = isTikTokPlatform(platform)
        ? tikTokNoPrice +
            (tikTokOpenerAlreadyInThread
                ? "CHANNEL: tiktok_dm. Marco already has at least one outbound in this thread (often the manual first DM with the first-time buying question). Do NOT send another opener and do NOT ask about first-time vs experienced buyer or the buying process again. Answer LATEST_LEAD_MESSAGE in Marco's voice, then offer the full breakdown and ask for the best mobile number in that SAME reply. Do not spend a turn waiting for them to agree to the packet before asking. If they already gave a number, confirm you are texting it instead of asking again. Never recycle appreciation + first-time question.\n\n"
                : "CHANNEL: tiktok_dm. Use TikTok flow, not Instagram. If this is Marco's first line in the thread, send ONE message that offers the full breakdown plus a couple other options and asks for the best number to text them to. Do not open with the first-time buying question and do not split the offer and the number ask across turns. If any Marco line already exists above, skip opener scripts entirely.\n\n")
        : "";
    const igDmNeutral = isInstagramDm(platform, channel);
    const igDmOpenerAlreadyInThread = igDmNeutral &&
        (assistantTurns >= 1 || (0, conversationUtils_js_1.threadContainsFirstTimeBuyingQuestion)(conversation));
    const igNeutralDmChannelBlock = igDmNeutral
        ? tikTokNoPrice +
            (igDmOpenerAlreadyInThread
                ? "CHANNEL: instagram_dm. Marco already has at least one outbound in this thread (often the manual first DM with the first-time buying question). Do NOT send another opener and do NOT ask about first-time vs experienced buyer or the buying process again. Answer LATEST_LEAD_MESSAGE in Marco's voice, then offer the full breakdown and ask for the best mobile number in that SAME reply. Do not spend a turn waiting for them to agree to the packet before asking. If they already gave a number, confirm you are texting it instead of asking again. Never recycle appreciation + first-time question.\n\n"
                : "CHANNEL: instagram_dm. Use the same neutral DM flow as TikTok. If this is Marco's first line in the thread, send ONE message that offers the full breakdown plus a couple other options and asks for the best number to text them to. Do not open with the first-time buying question and do not split the offer and the number ask across turns. If any Marco line already exists above, skip opener scripts entirely. Never quote list price in DM.\n\n")
        : "";
    const prefix = tikTokChannelBlock + igNeutralDmChannelBlock + inboundChannelBlock(channel, hasKnownListing);
    if (assistantTurns === 0 && lastUserText.trim() && !igDmNeutral && !isTikTokPlatform(platform)) {
        lines.push("FIRST_OUTBOUND_RULE: This is Marco's first reply in the thread. The lead's latest line is their opener. Answer its primary intent first (tour, showing, schedule, availability, a direct question). Do not ignore that to deliver a pricing script. Use thanks plus mid 500s plus alignment question only when their message is generic interest or price led, not when they already asked for something specific like a tour.");
    }
    if (signalsTourOrScheduleIntent(lastUserText)) {
        lines.push("TOUR_OR_SCHEDULE_SIGNAL: The lead is asking to tour, see the home, or schedule. Do NOT confirm same-day. Guide toward tomorrow with schedule-check language. Pricing is secondary in this turn.");
    }
    if (signalsBrowsingOrPriceDeflection(lastUserText)) {
        lines.push("BROWSING_OR_PRICE_DEFLECTION: The lead is browsing or said price is not their focus. Acknowledge briefly and steer toward a good number to text the breakdown. Do not ask preferences, timeline, bedrooms, or what matters in a home.");
    }
    if ((0, conversationUtils_js_1.messageAsksListingLocation)(lastUserText)) {
        lines.push("LOCATION_ASK: The lead asked where this home is. Let them know you can text the full breakdown which includes the address and all specs. Steer toward getting a good mobile number. Do not state any specific street, neighborhood, or location detail in DM.");
    }
    if (isNeutralDmFlow(platform, channel) && (0, conversationUtils_js_1.messageAsksPropertyPriceOrCost)(lastUserText)) {
        lines.push("PRICE_ASK_TIKTOK: They asked price or cost. Do not quote any dollar amount in DM. Offer the breakdown in Marco's casual voice (yeah of course, would it help if I sent the entire breakdown on the home they inquired about, location and pricing included) AND ask for the best number to text it to, in the SAME reply. No lecturing about the app or DMs being a rough place for sheets. Do not split the offer and the ask across turns.");
    }
    if ((0, conversationUtils_js_1.messageAsksBuilderIdentity)(lastUserText)) {
        lines.push("BUILDER_ASK: The lead asked who the builder or developer is. NEVER name the builder. Briefly deflect; steer to a good number for the breakdown or answer non-builder parts of their message.");
    }
    if ((0, conversationUtils_js_1.threadContainsFirstTimeBuyingQuestion)(conversation) || (0, conversationUtils_js_1.leadThreadSignalsExperiencedBuyer)(conversation)) {
        lines.push("FIRST_TIME_TOPIC_CLOSED: The first-time-through-the-buying-process question already appears in Marco's lines or the lead already said they are not a first-time buyer. Do NOT ask that again in any wording (including rephrases like first time through a process like this).");
        if (isTikTokPlatform(platform)) {
            lines.push("TIKTOK_AFTER_FIRST_TIME_ANSWER: Acknowledge their answer in a few words, then offer the breakdown AND ask for the best number to text it to, in this same reply. Marco's natural texting voice (warm, not robotic). Do not wait a turn for them to agree to the packet before asking.");
        }
        if (igDmNeutral) {
            lines.push("INSTAGRAM_DM_AFTER_FIRST_TIME_ANSWER: Acknowledge their answer in a few words, then offer the breakdown AND ask for the best number to text it to, in this same reply. Marco's natural texting voice (warm, not robotic). Do not wait a turn for them to agree to the packet before asking.");
        }
    }
    if ((0, conversationUtils_js_1.signalsLookingOutsideSanAntonio)(lastUserText)) {
        lines.push("TEXAS_SERVICE_AREA: The lead is looking outside San Antonio or named another Texas market. In Marco's first-person voice: say you help buyers all across Texas. Keep it one short sentence, then continue answering their message or the listing conversation. Never mention a dollar amount or price threshold in this line.");
    }
    if ((0, conversationUtils_js_1.signalsWantsInfoInDmOnly)(lastUserText)) {
        lines.push("DM_ONLY_REQUEST_OPENING: They want the packet or details in this Instagram or TikTok DM instead of SMS. Never promise to send the full breakdown, pricing, links, or packet inside this DM thread. Do not promise you will text them until they give a mobile number. Brief empathy in Marco's casual texting voice, one short beat on why the full sheet and links land cleaner over text, then a fresh ask for a good number. Different angle than MARCO_PREVIOUS_OUTBOUND. One or two short sentences.");
    }
    if (!phoneOnFile) {
        lines.push("NO_PHONE_NO_SMS_PROMISE_OPENING: No mobile on file yet. Never say you will text them, shoot them a text, or promise SMS or WhatsApp delivery. Never promise the full pricing breakdown or packet as something you will deliver inside this DM. You may offer that once they share a number you will text the breakdown by end of day.");
    }
    const body = lines.length ? `${lines.join("\n")}\n\n` : "";
    return prefix + body;
}
/**
 * What Marco knows about the home this lead messaged about, when ManyChat told
 * us which one (or an exact match was made earlier).
 *
 * The point of wiring `listing_id` through was to stop the agent asking "which
 * property?", so the block leads with the address and the fact that it must not
 * ask. It deliberately does NOT relax the DM price rule: knowing the list price
 * and being allowed to quote it in a TikTok/Instagram DM are separate questions,
 * and the answer to the second is still no. The breakdown-by-text offer is what
 * carries pricing, which is exactly why it earns the number.
 */
function knownListingBlock(lead, neutralDm) {
    const key = lead.mlsListingKey?.trim();
    if (!key)
        return "";
    const listing = (0, listingsStore_js_1.getListing)(key);
    if (!listing)
        return "";
    const address = [listing.street, listing.city, listing.state].filter(Boolean).join(", ");
    const specs = [
        listing.beds ? `${listing.beds} bed` : null,
        listing.baths ? `${listing.baths} bath` : null,
        listing.livingArea ? `${listing.livingArea} sqft` : null,
        listing.yearBuilt ? `built ${listing.yearBuilt}` : null,
    ]
        .filter(Boolean)
        .join(", ");
    const priceRule = neutralDm
        ? "Do NOT state the list price or any dollar amount in this DM, even though you know it. The full breakdown by text is what carries pricing."
        : "You may reference pricing per your normal rules for a confirmed listing.";
    return ("KNOWN_LISTING: You know exactly which home this lead is asking about. " +
        `It is ${address || key}` +
        (specs ? ` (${specs})` : "") +
        ". Never ask them which property they mean, and never ask them to send a screenshot or a link. " +
        "You may refer to it naturally, the way someone who pulled it up would. " +
        priceRule +
        " Do not invent any fact that is not listed here.\n\n");
}
function fallbackOpeningReply(lead, openingStage, lastUserText, conversation, inboundChannel = "dm", inboundPlatform = "instagram") {
    if (lead.phone) {
        return funnelDeterministic_js_1.PHONE_JUST_CAPTURED_REPLY;
    }
    const who = greetingNameForOpening(lead);
    const neutralDm = isNeutralDmFlow(inboundPlatform, inboundChannel);
    if (openingStage === state_js_1.FunnelStage.New) {
        if (neutralDm) {
            const hey = who !== "there" ? `Thanks for reaching out ${who}!` : "Thanks for reaching out!";
            /* Collapsed opener: offer AND ask in one message. Each of these used to
               end without the number ask, which cost a whole round trip on a
               surface where the next reply can be days away. */
            if (signalsTourOrScheduleIntent(lastUserText)) {
                return `${hey} I can send the full breakdown on that place, specs and timing included, and we can line up a tour from there. What's the best number to text it to?`;
            }
            if ((0, conversationUtils_js_1.messageAsksListingLocation)(lastUserText)) {
                return `${hey} I can text you the full breakdown on that home, address and all the specs included. What's the best number to send it to?`;
            }
            return `${hey} I'd love to send over the full breakdown on that home, plus a couple other options in case it's not quite the right fit. What's the best number to text them to?`;
        }
        /* Instagram keeps its trained mid-500s price framing, but the alignment
           qualifier no longer stands alone as the whole reply. Since the collapse
           the funnel moves to PhoneRequested right after this message, so the
           message itself has to carry the ask or the ask never happens. */
        if ((0, conversationUtils_js_1.messageAsksListingLocation)(lastUserText)) {
            const hey = who !== "there" ? `Hey ${who}` : "Hey";
            return `${hey}, this one's typically mid 500s depending on finishes. I can text you the full breakdown with the address and specs, what's the best number to send it to?`;
        }
        if (signalsTourOrScheduleIntent(lastUserText)) {
            const hey = who !== "there" ? `Hey ${who}` : "Hey";
            return `${hey}, for sure we can line up a tour. This one is typically mid 500s depending on finishes if that helps you ballpark it. What's the best number to reach you at so I can send the details and times?`;
        }
        const thanks = inboundChannel === "comment"
            ? who !== "there"
                ? `Hey ${who}, thanks for commenting`
                : "Hey, thanks for commenting"
            : who !== "there"
                ? `Hey ${who}, I appreciate you reaching out`
                : "Hey, I appreciate you reaching out";
        return `${thanks}. The pricing on this one typically runs in the mid 500s depending on finishes and add-ons. I'd love to send over the full breakdown plus a couple other options in case it's not quite the right fit, what's the best number to text them to?`;
    }
    if (openingStage === state_js_1.FunnelStage.OpeningAskedFirstTime) {
        if (neutralDm) {
            const lastLower = lastUserText.trim().toLowerCase();
            const conv = conversation ?? { messages: [] };
            const experiencedInLine = /\bown multiple\b/.test(lastLower) ||
                /\b(not at all|already been through|not my first|not a first)\b/.test(lastLower) ||
                /\b(i'?ve|have)\s+(already\s+)?(bought|owned)\b/.test(lastLower);
            const notFirstOrExperienced = /^no\b/.test(lastLower) ||
                /^not at all\b/.test(lastLower) ||
                /\bnot my first\b/.test(lastLower) ||
                /\bisn'?t\b/.test(lastLower) ||
                /\bisnt\b/.test(lastLower) ||
                experiencedInLine ||
                (0, conversationUtils_js_1.leadThreadSignalsExperiencedBuyer)(conv);
            if (signalsBrowsingOrPriceDeflection(lastUserText)) {
                return "Got it, just looking is totally fine. Want me to text you the full breakdown when you're ready? What's a good number?";
            }
            if ((0, conversationUtils_js_1.messageAsksListingLocation)(lastUserText) && (0, conversationUtils_js_1.messageAsksPropertyPriceOrCost)(lastUserText)) {
                return "Would it help if I sent the entire breakdown on the home you inquired about, location and pricing included?";
            }
            if ((0, conversationUtils_js_1.messageAsksPropertyPriceOrCost)(lastUserText)) {
                return "Would it help if I sent over the entire breakdown of the home you inquired about, location and pricing included, by text?";
            }
            if (notFirstOrExperienced) {
                return "Ahh gotcha of course, would it help if I sent over the entire breakdown of the property you inquired about?";
            }
            return "Oh awesome, would it help if I sent the entire breakdown over of the home you inquired about?";
        }
        if (signalsBrowsingOrPriceDeflection(lastUserText)) {
            return "Got it, no pressure at all. Want me to text you the full breakdown on that place when you're ready? What's a good number?";
        }
        return "For sure, that helps. Are you currently working with an agent?";
    }
    if (conversation &&
        (0, conversationUtils_js_1.threadContainsAgentQuestion)(conversation) &&
        (0, conversationUtils_js_1.leadTextSignalsNoAgent)(lastUserText)) {
        return "Got you. What's a good number I can text you the full breakdown on this place and a couple similar options?";
    }
    if (signalsBrowsingOrPriceDeflection(lastUserText)) {
        return "Totally hear you. What's a good number I can text you the full breakdown and a couple similar options?";
    }
    return "Makes sense. Would there be a good number I could send all this info over to?";
}
function alternateOpeningFallback(lead, openingStage, lastUserText, conversation, inboundChannel = "dm", inboundPlatform = "instagram") {
    if (lead.phone) {
        return funnelDeterministic_js_1.PHONE_JUST_CAPTURED_REPLY;
    }
    const recent = (0, conversationUtils_js_1.getRecentAssistantTexts)(conversation, 5);
    const neutralDm = isNeutralDmFlow(inboundPlatform, inboundChannel);
    const pool = [];
    if (neutralDm) {
        pool.push("Would it help if I sent over the entire breakdown for that home, specs and pricing by text when you want it?", "Ahh gotcha. Want me to line up the full packet on that place for you by text first?");
    }
    if (/\bva\b|veteran|military|gi\b/i.test(lastUserText)) {
        pool.push(neutralDm
            ? "VA helps a ton on the payment side. What's the best number to text you the full breakdown and a few similar homes?"
            : "VA helps a ton on the payment side, we can walk real numbers when you want. What's the best number to text you the spec sheet and a few similar homes?");
    }
    if ((0, conversationUtils_js_1.leadTextSignalsNoAgent)(lastUserText)) {
        pool.push(neutralDm
            ? "Got you. What's a good number I can send the full breakdown and a couple backup listings to?"
            : "Got you. What's a good number I can send the full breakdown and a couple backup listings to?", neutralDm
            ? "Cool, since you're rolling solo on this, what number works best for me to text you the packet?"
            : "Cool, since you're rolling solo on this, what number works best for me to text you the packet?");
    }
    if (openingStage === state_js_1.FunnelStage.OpeningOfferedDetails || openingStage === state_js_1.FunnelStage.OpeningAskedFirstTime) {
        if (neutralDm) {
            pool.push("Fair enough. Want me to send the full breakdown on this one by text when you're ready?", "I can line up a tour once I know your schedule, what days are easiest? If you want the spec sheet first I can text it over once you're cool with that.");
        }
        else {
            pool.push("Fair enough. Want me to text you the breakdown on this one? What's the best number?", "I can line up a tour once I know your schedule, what days are easiest? If you want the spec sheet first, drop a number and I'll send it.");
        }
    }
    pool.push(fallbackOpeningReply(lead, openingStage, lastUserText, conversation, inboundChannel, inboundPlatform));
    for (const c of pool) {
        if (!(0, conversationUtils_js_1.candidateMatchesRecentMarco)(c, recent))
            return c;
    }
    if (neutralDm) {
        return "Want me to send the full breakdown on that place by text when you're ready, specs and pricing?";
    }
    return "What's the best number to text you details on this home?";
}
/**
 * Final guard before DB append: never persist an opening reply that matches recent Marco lines.
 */
function sanitizeOpeningReplyAgainstRecentMarco(reply, lead, conversation, openingStage, log, inboundChannel = "dm", inboundPlatform = "instagram") {
    if (!reply?.trim())
        return reply;
    const recent = (0, conversationUtils_js_1.getRecentAssistantTexts)(conversation, 5);
    if (!(0, conversationUtils_js_1.candidateMatchesRecentMarco)(reply, recent))
        return (0, conversationUtils_js_1.enforceOutboundTextRules)(reply);
    (0, marcoLog_js_1.marcoLog)("sanitize_opening", {
        requestId: log?.requestId,
        correlationId: log?.correlationId,
        reason: "draft_matched_recent_marco",
        draft_preview: (0, marcoLog_js_1.previewText)(reply),
        opening_stage: openingStage,
    });
    const lastUser = (0, conversationUtils_js_1.getLastUserMessageText)(conversation);
    let out = alternateOpeningFallback(lead, openingStage, lastUser, conversation, inboundChannel, inboundPlatform);
    if ((0, conversationUtils_js_1.candidateMatchesRecentMarco)(out, recent)) {
        out = fallbackOpeningReply(lead, openingStage, lastUser, conversation, inboundChannel, inboundPlatform);
    }
    if ((0, conversationUtils_js_1.candidateMatchesRecentMarco)(out, recent)) {
        out = (0, funnelDeterministic_js_1.extractPhoneFromConversation)(conversation)
            ? funnelDeterministic_js_1.PHONE_JUST_CAPTURED_REPLY
            : isNeutralDmFlow(inboundPlatform, inboundChannel)
                ? "Want me to send the full breakdown on that home by text when you're ready, specs and pricing?"
                : "What's the best number to text you the spec sheet on this house?";
    }
    out = (0, conversationUtils_js_1.enforceOutboundTextRules)(out);
    (0, marcoLog_js_1.marcoLog)("sanitize_opening_result", {
        requestId: log?.requestId,
        correlationId: log?.correlationId,
        out_preview: (0, marcoLog_js_1.previewText)(out),
    });
    return out;
}
/**
 * Final guard before DB append for post-opening funnel replies.
 */
function sanitizePipelineReplyAgainstRecentMarco(reply, lead, conversation, meta, log) {
    if (!reply?.trim())
        return reply;
    const recent = (0, conversationUtils_js_1.getRecentAssistantTexts)(conversation, 5);
    if (!(0, conversationUtils_js_1.candidateMatchesRecentMarco)(reply, recent))
        return (0, conversationUtils_js_1.enforceOutboundTextRules)(reply);
    (0, marcoLog_js_1.marcoLog)("sanitize_pipeline", {
        requestId: log?.requestId,
        correlationId: log?.correlationId,
        reason: "draft_matched_recent_marco",
        draft_preview: (0, marcoLog_js_1.previewText)(reply),
        funnel_stage: lead.state,
    });
    const lastA = (0, conversationUtils_js_1.getLastAssistantMessageText)(conversation) ?? "";
    const lastU = (0, conversationUtils_js_1.getLastUserMessageText)(conversation);
    let out = alternatePipelineReplyFallback(lead, meta, lastA, lastU, recent, lead.platform, "dm");
    out = (0, conversationUtils_js_1.enforceOutboundTextRules)(out);
    (0, marcoLog_js_1.marcoLog)("sanitize_pipeline_result", {
        requestId: log?.requestId,
        correlationId: log?.correlationId,
        out_preview: (0, marcoLog_js_1.previewText)(out),
    });
    return out;
}
function fallbackMarcoReply(lead, meta, platform, channel) {
    if (meta.phoneJustCaptured) {
        return funnelDeterministic_js_1.PHONE_JUST_CAPTURED_REPLY;
    }
    if (meta.listSendPromised) {
        return ("For sure. I'll text you a personalized list of homes that match what you said. " +
            "Skim when you can and tell me what you want to tour first.");
    }
    if (!lead.phone) {
        return "Of course. Is there a good number I can reach you at to send you more info?";
    }
    return "Thanks, I'm on it and will keep this moving.";
}
/** Marco-toned last resort when they asked for email delivery; avoids generic number-ask repeat. */
const EMAIL_DELIVERY_PIPELINE_FALLBACK = "Honestly the full breakdown is way easier to read over text, links dont always come through clean on email. Whats a good number?";
function fallbackMarcoPipelineReply(lead, meta, lastUser, recentMarco, platform, channel = "dm") {
    const neutralDm = isNeutralDmFlow(platform ?? lead.platform, channel);
    if (neutralDm) {
        const who = greetingNameForOpening(lead);
        const hey = who !== "there" ? `Thanks for reaching out ${who}!` : "Thanks for reaching out!";
        if ((0, conversationUtils_js_1.messageAsksPropertyPriceOrCost)(lastUser)) {
            return "Would it help if I sent over the entire breakdown of the home you inquired about, location and pricing included, by text?";
        }
        if ((0, conversationUtils_js_1.messageAsksListingLocation)(lastUser)) {
            return `${hey} I'd love to help with that. Want me to text you the full breakdown on that home, address and all the specs included?`;
        }
        if (!lead.phone) {
            return "Of course. Is there a good number I can reach you at to send you more info?";
        }
    }
    if (!lead.phone &&
        !meta.phoneJustCaptured &&
        !meta.listSendPromised &&
        (0, conversationUtils_js_1.signalsEmailDeliveryRequest)(lastUser)) {
        if (!recentMarco?.length || !(0, conversationUtils_js_1.candidateMatchesRecentMarco)(EMAIL_DELIVERY_PIPELINE_FALLBACK, recentMarco)) {
            return EMAIL_DELIVERY_PIPELINE_FALLBACK;
        }
    }
    return fallbackMarcoReply(lead, meta, platform, channel);
}
/**
 * One Haiku call: full thread + opening stage + preflight → next Marco DM (opening funnel only).
 * Replaces rigid per-branch deterministic scripts; stage advancement stays in the module.
 */
async function generateMarcoOpeningReply(input) {
    const { lead, conversation, openingStage, preflight, log } = input;
    const inboundChannel = input.inboundChannel ?? "dm";
    const inboundPlatform = input.inboundPlatform ?? "instagram";
    const client = getClient();
    (0, marcoLog_js_1.marcoLog)("llm_opening_start", {
        requestId: log?.requestId,
        correlationId: log?.correlationId,
        lead_id: lead.id,
        opening_stage: openingStage,
        model,
        preflight_repeated_flag: preflight.repeatedMessage,
    });
    const transcript = conversation.messages
        .map((m) => `${m.role === "user" ? "Lead" : "Marco"}: ${m.text}`)
        .join("\n");
    const preflightPayload = {
        repeated_message: preflight.repeatedMessage,
        coaching_note: preflight.coachingNote,
    };
    const lastUserText = (0, conversationUtils_js_1.getLastUserMessageText)(conversation);
    const lastAssistantText = (0, conversationUtils_js_1.getLastAssistantMessageText)(conversation);
    const recentMarcoOutbounds = (0, conversationUtils_js_1.getRecentAssistantTexts)(conversation, 5);
    const contextPrefix = openingContextAppendix(lastUserText, conversation, inboundChannel, inboundPlatform, Boolean(lead.phone?.trim()), Boolean(lead.adCampaign));
    const openingDeliveryBlock = "PHONE_ONLY_DELIVERY: Use SMS/text to their phone for breakdowns and options. Never ask phone or email, never offer email.\n\n";
    const dynamicRules = getDynamicRuleReinforcement(lastUserText);
    const userBlock = contextPrefix +
        knownListingBlock(lead, isNeutralDmFlow(inboundPlatform, inboundChannel)) +
        openingDeliveryBlock +
        dynamicRules +
        (dynamicRules ? "\n\n" : "") +
        `OPENING_STAGE: ${openingStage}\n\n` +
        `PREFLIGHT:\n${JSON.stringify(preflightPayload, null, 2)}\n\n` +
        `LATEST_LEAD_MESSAGE (address this directly; if it bundles several topics, handle them naturally in one reply):\n${lastUserText || "(empty)"}\n\n` +
        `MARCO_PREVIOUS_OUTBOUND (your new reply must NOT repeat the same wording or the same idea as this; use a different angle):\n${lastAssistantText ?? "(none)"}\n\n` +
        `CONVERSATION (oldest first):\n${transcript}`;
    if (!client) {
        (0, marcoLog_js_1.marcoLog)("llm_opening_fallback", {
            requestId: log?.requestId,
            correlationId: log?.correlationId,
            reason: "no_anthropic_client",
        });
        return fallbackOpeningReply(lead, openingStage, lastUserText, conversation, inboundChannel, inboundPlatform);
    }
    const runOnce = async (blockContent) => {
        const t0 = Date.now();
        const response = await messagesCreateWithRetry(client, {
            model,
            max_tokens: 900,
            system: isNeutralDmFlow(inboundPlatform, inboundChannel)
                ? (0, prompts_js_1.getMarcoTikTokOpeningSystem)()
                : (0, prompts_js_1.getMarcoOpeningSystem)(),
            messages: [{ role: "user", content: blockContent }],
        });
        const block = response.content[0];
        if (block.type !== "text") {
            return null;
        }
        (0, marcoLog_js_1.marcoLogDebug)("llm_opening_api_ms", {
            requestId: log?.requestId,
            correlationId: log?.correlationId,
            ms: Date.now() - t0,
            stop_reason: response.stop_reason,
        });
        return parsePipelineReplyJson(block.text);
    };
    try {
        let reply = await runOnce(userBlock);
        if (reply && (0, conversationUtils_js_1.candidateMatchesRecentMarco)(reply, recentMarcoOutbounds)) {
            (0, marcoLog_js_1.marcoLog)("llm_opening_duplicate_draft", {
                requestId: log?.requestId,
                correlationId: log?.correlationId,
                draft_preview: (0, marcoLog_js_1.previewText)(reply),
                action: "retroactive_fix_retry",
            });
            const fixBlock = userBlock +
                `\n\nRETROACTIVE_FIX: Your draft matches or nearly matches a prior Marco line in this thread. Output ONLY valid JSON with a new "reply" that (1) answers LATEST_LEAD_MESSAGE directly, (2) never repeats or paraphrases any prior Marco message, (3) if the agent question was already asked above and the lead answered, move to the next step (usually phone number to send details), (4) one or two short sentences, (5) never em dashes or en dashes, no exceptions, no hyphen pauses between phrases.`;
            reply = (await runOnce(fixBlock)) ?? reply;
        }
        if (reply && (0, conversationUtils_js_1.candidateMatchesRecentMarco)(reply, recentMarcoOutbounds)) {
            (0, marcoLog_js_1.marcoLog)("llm_opening_duplicate_draft", {
                requestId: log?.requestId,
                correlationId: log?.correlationId,
                draft_preview: (0, marcoLog_js_1.previewText)(reply),
                action: "alternate_opening_fallback",
            });
            reply = alternateOpeningFallback(lead, openingStage, lastUserText, conversation, inboundChannel, inboundPlatform);
        }
        if (reply && (0, conversationUtils_js_1.candidateMatchesRecentMarco)(reply, recentMarcoOutbounds)) {
            (0, marcoLog_js_1.marcoLog)("llm_opening_duplicate_draft", {
                requestId: log?.requestId,
                correlationId: log?.correlationId,
                action: "template_opening_fallback",
            });
            reply = fallbackOpeningReply(lead, openingStage, lastUserText, conversation, inboundChannel, inboundPlatform);
        }
        const finalReply = reply ??
            fallbackOpeningReply(lead, openingStage, lastUserText, conversation, inboundChannel, inboundPlatform);
        (0, marcoLog_js_1.marcoLog)("llm_opening_done", {
            requestId: log?.requestId,
            correlationId: log?.correlationId,
            reply_preview: (0, marcoLog_js_1.previewText)(finalReply),
            used_hardcoded_fallback: !reply,
        });
        return finalReply;
    }
    catch (e) {
        console.warn("[llm] generateMarcoOpeningReply failed:", e);
        (0, marcoLog_js_1.marcoLog)("llm_opening_error", {
            requestId: log?.requestId,
            correlationId: log?.correlationId,
            error: e instanceof Error ? e.message : String(e),
            anthropic_http_status: anthropicHttpStatus(e),
            model,
        });
        return fallbackOpeningReply(lead, openingStage, lastUserText, conversation, inboundChannel, inboundPlatform);
    }
}
/**
 * One Haiku call: full thread + funnel JSON → next Marco DM (post–opening funnel only).
 */
async function generateMarcoPipelineReply(input) {
    const { lead, conversation, meta, preflight, log } = input;
    const inboundChannel = input.inboundChannel ?? "dm";
    const inboundPlatform = input.inboundPlatform ?? "instagram";
    const client = getClient();
    (0, marcoLog_js_1.marcoLog)("llm_pipeline_start", {
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
        .map((m) => `${m.role === "user" ? "Lead" : "Marco"}: ${m.text}`)
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
    const lastUserText = (0, conversationUtils_js_1.getLastUserMessageText)(conversation);
    const lastAssistantText = (0, conversationUtils_js_1.getLastAssistantMessageText)(conversation);
    const recentMarcoOutbounds = (0, conversationUtils_js_1.getRecentAssistantTexts)(conversation, 5);
    const postOpeningHints = [];
    const neutralDmPipeline = isNeutralDmFlow(inboundPlatform, inboundChannel);
    const canPromiseSms = Boolean(lead.phone?.trim()) || meta.phoneJustCaptured;
    if (!canPromiseSms) {
        postOpeningHints.push("NO_PHONE_ON_FILE: No mobile number captured yet (unless phone_just_captured in FUNNEL_CONTEXT is true). Never say you will text them, shoot a text, or promise SMS or WhatsApp delivery of the breakdown, pricing, or packet. Never promise the full breakdown or pricing packet inside TikTok or Instagram DM as the delivery path. You may offer that once they share a number you will text the full breakdown by end of day. If they want info in-app only, acknowledge in Marco's casual voice and persist toward a good number. Links and full sheet read cleaner in one text thread. Fresh wording, not a copy of MARCO_PREVIOUS_OUTBOUND.");
    }
    /* Real MLS facts for the property this lead actually named.
       INSTAGRAM ONLY, and that is not an oversight: TIKTOK_NO_LIST_PRICE_IN_DM
       below forbids quoting a price on TikTok, so handing the model real figures
       there would be handing it the thing it is told not to say.
       Facts are provided, never a script — the model still writes in Marco's
       voice — and only on an EXACT match, because a confidently quoted price for
       the wrong house is worse than no price at all. */
    if (!isTikTokPlatform(inboundPlatform) && (0, index_js_1.isMlsFeedConfigured)()) {
        try {
            const match = (0, listingMatch_js_1.matchListingForLead)(lead, conversation);
            const matched = match.confidence === "exact" ? match.listing : null;
            /* Remember a certain match on the lead itself, so the CRM and the drips
               can show the property later without re-deriving it from a conversation
               that will keep growing. Only ever set on `exact`. */
            if (matched && lead.mlsListingKey !== matched.listingKey) {
                void (0, db_js_1.updateLeadCrmFields)({ leadId: lead.id, mlsListingKey: matched.listingKey }).catch((e) => console.error("[pipeline] could not link listing to lead:", e));
            }
            const comps = (0, listingMatch_js_1.comparablesFor)(lead, matched, matched ? 2 : 3);
            if (matched || comps.length) {
                const fact = (l) => `${[l.street, l.city].filter(Boolean).join(", ")} | ${l.listPrice != null ? "$" + Math.round(l.listPrice).toLocaleString("en-US") : "price on request"}${l.beds != null ? ` | ${l.beds} bed` : ""}${l.baths != null ? ` | ${l.baths} bath` : ""}${l.livingArea ? ` | ${Math.round(l.livingArea).toLocaleString("en-US")} sqft` : ""}${l.status ? ` | ${l.status}` : ""}${l.mlsNumber ? ` | MLS ${l.mlsNumber}` : ""}`;
                const lines = [];
                if (matched)
                    lines.push(`THE PROPERTY THEY ASKED ABOUT: ${fact(matched)}`);
                if (comps.length)
                    lines.push(`OTHER ACTIVE LISTINGS THAT FIT: ${comps.map(fact).join(" ;; ")}`);
                postOpeningHints.push("LIVE_MLS_FACTS: These come from the live MLS feed and are true as of now. " +
                    "Use them to answer a price or specs question directly instead of deferring. " +
                    "COPY EVERY FIGURE EXACTLY as written — never round, re-estimate or average a price, " +
                    "and never state a number that is not below. " +
                    (matched
                        ? ""
                        : "There is NO confident match for a specific property, so do NOT say 'the home you asked about' or imply these are it. Offer them as options. ") +
                    "If a listing is not Active, say so before anything else.\n" +
                    lines.join("\n"));
            }
        }
        catch (err) {
            /* Never let a listing lookup stop a lead getting a reply. */
            console.error("[pipeline] MLS fact lookup failed:", err);
        }
    }
    if (isTikTokPlatform(inboundPlatform)) {
        postOpeningHints.push("TIKTOK_NO_LIST_PRICE_IN_DM: Never quote list price, ballpark, mid 500s, or dollar amounts for the specific property in chat. If they ask cost, use Marco's breakdown-offer voice from training (yeah of course, would it help if I sent the entire breakdown, location and pricing included by text), not platform meta about TikTok or DMs being a rough place for sheets. Offer the breakdown by text first; mobile number only after they clearly want it sent. Buyer budget criteria is ok to discuss.");
    }
    if (isInstagramDm(inboundPlatform, inboundChannel)) {
        postOpeningHints.push("INSTAGRAM_DM_NEUTRAL_FLOW: Same neutral DM rules as TikTok. Never quote list price, ballpark, mid 500s, or dollar amounts for the specific property in chat. Offer the full breakdown by text first; mobile number only after they clearly want it sent. First-time buyer question drives engagement when Marco has not already asked it in the thread.");
    }
    if (!neutralDmPipeline && isInstagramPlatform(inboundPlatform)) {
        postOpeningHints.push("INSTAGRAM_FLOW: Keep Marco's Instagram cadence from training threads. Direct price or location asks should get a direct practical answer first, then a soft qualifier. If they react to value (high, low, fair), validate briefly and offer full breakdown in Marco voice. Number ask usually comes after value or explicit agreement, not as first move. Keep it concise and human.");
    }
    if (signalsBrowsingOrPriceDeflection(lastUserText)) {
        postOpeningHints.push("BROWSING_OR_PRICE_DEFLECTION: Lead is browsing or de emphasized price. Acknowledge briefly and steer toward a mobile number. Never ask preferences, timeline, bedrooms, or needs-analysis questions.");
    }
    if (signalsTourOrScheduleIntent(lastUserText)) {
        postOpeningHints.push("TOUR_OR_SCHEDULE_SIGNAL: Lead is focused on seeing the home or scheduling. Do NOT confirm same-day. Guide toward tomorrow. Use Marco's schedule-check language from GLOBAL rules.");
    }
    if ((0, conversationUtils_js_1.messageAsksListingLocation)(lastUserText)) {
        postOpeningHints.push("LOCATION_ASK: Lead asked where this listing is. Let them know you can text the full breakdown including the address and specs. Steer toward a mobile number. Do not state any specific area, neighborhood, or street in DM.");
    }
    if (neutralDmPipeline && (0, conversationUtils_js_1.messageAsksPropertyPriceOrCost)(lastUserText)) {
        postOpeningHints.push("PRICE_ASK_TIKTOK: No dollar amounts in DM. First beat is the entire-breakdown offer in Marco's casual texting voice (same shape as screenshots: would it help if I sent the breakdown on the home they inquired about, location and pricing included). No app or DM quality lectures. Offer the breakdown and ask for the best mobile number in the SAME reply, not on a later turn.");
    }
    if ((0, conversationUtils_js_1.messageAsksBuilderIdentity)(lastUserText)) {
        postOpeningHints.push("BUILDER_ASK: Lead asked builder or developer identity. NEVER name the builder. Deflect in one short line; steer to phone number or address only the non-builder parts of their message.");
    }
    if ((0, conversationUtils_js_1.threadContainsFirstTimeBuyingQuestion)(conversation) || (0, conversationUtils_js_1.leadThreadSignalsExperiencedBuyer)(conversation)) {
        postOpeningHints.push("FIRST_TIME_TOPIC_CLOSED: Do not ask again about first time buying, first time through the process, or similar. Already covered in the thread. Answer their latest message and advance.");
    }
    if ((0, conversationUtils_js_1.signalsWantsInfoInDmOnly)(lastUserText)) {
        postOpeningHints.push("DM_ONLY_REQUEST: They want the breakdown or packet in Instagram or TikTok DM instead of SMS. Never promise to send the full breakdown, pricing, links, or packet inside this DM thread. Do not promise you will text them until a number is on file. One or two short sentences: brief empathy in Marco's voice, one casual beat on why a number is smoother for the full sheet and links, then a fresh mobile ask. Not the same wording as MARCO_PREVIOUS_OUTBOUND. Do not give any area or location detail in DM; steer to phone number so the full breakdown (address included) can be sent by text. No paragraphs.");
    }
    if ((0, conversationUtils_js_1.signalsEmailDeliveryRequest)(lastUserText)) {
        postOpeningHints.push("EMAIL_DELIVERY_ASK: They asked to get the packet or details by email. Answer that directly in casual Marco voice, not corporate. One short honest line on why text is better here (links, full breakdown readable). Then ask for a mobile number in fresh wording, not the same sentence as MARCO_PREVIOUS_OUTBOUND. Never offer to send by email.");
    }
    if ((0, conversationUtils_js_1.signalsWantsBreakdownImmediately)(lastUserText)) {
        postOpeningHints.push("BREAKDOWN_URGENCY: The lead wants the full breakdown ASAP or right now. Acknowledge the rush, but do NOT agree to send it immediately. Explain briefly you have to put together the full pricing and breakdown sheet so it is accurate, and commit to sending it by the end of the day. Keep it short and human, no excuses.");
    }
    if ((0, conversationUtils_js_1.signalsLookingOutsideSanAntonio)(lastUserText)) {
        postOpeningHints.push("TEXAS_SERVICE_AREA: Lead is searching outside San Antonio or named another Texas area. In Marco's first-person voice: you help buyers across Texas. One short beat, then continue the thread. Never mention a dollar amount or price threshold in this line.");
    }
    if (meta.phoneJustCaptured) {
        postOpeningHints.push("PHONE_JUST_CAPTURED: They just shared their number this turn. One short confirm you will get the breakdown over to them. Do not add a fit check, budget question, or needs analysis.");
    }
    const postOpeningPrefix = inboundChannelBlock(inboundChannel, Boolean(lead.adCampaign)) +
        "PHONE_ONLY_DELIVERY: Send breakdowns and listing options by text/SMS to their phone number only. Never ask phone or email, never offer email, never ask for email. If they sent an email, thank them briefly and still get a mobile number to text the packet.\n\n" +
        (postOpeningHints.length ? `${postOpeningHints.join("\n")}\n\n` : "");
    const dynamicRules = getDynamicRuleReinforcement(lastUserText);
    const userBlock = postOpeningPrefix +
        dynamicRules +
        (dynamicRules ? "\n\n" : "") +
        `PREFLIGHT:\n${JSON.stringify(preflightPayload, null, 2)}\n\n` +
        `FUNNEL_CONTEXT:\n${JSON.stringify(funnelContext, null, 2)}\n\n` +
        `LATEST_LEAD_MESSAGE (answer this message directly in your reply; do not ignore their question or objection):\n${lastUserText || "(empty)"}\n\n` +
        `MARCO_PREVIOUS_OUTBOUND (your new reply must NOT repeat the same wording or the same idea as this; use a different angle):\n${lastAssistantText ?? "(none)"}\n\n` +
        `CONVERSATION (oldest first):\n${transcript}`;
    if (!client) {
        (0, marcoLog_js_1.marcoLog)("llm_pipeline_fallback", {
            requestId: log?.requestId,
            correlationId: log?.correlationId,
            reason: "no_anthropic_client",
        });
        return fallbackMarcoPipelineReply(lead, meta, lastUserText, undefined, inboundPlatform, inboundChannel);
    }
    const runOnce = async (blockContent) => {
        const t0 = Date.now();
        const response = await messagesCreateWithRetry(client, {
            model,
            max_tokens: PIPELINE_REPLY_MAX_TOKENS,
            system: isNeutralDmFlow(inboundPlatform, inboundChannel)
                ? (0, prompts_js_1.getMarcoTikTokUnifiedPipelineSystem)()
                : (0, prompts_js_1.getMarcoUnifiedPipelineSystem)(),
            messages: [{ role: "user", content: blockContent }],
        });
        const block = response.content[0];
        if (block.type !== "text") {
            return null;
        }
        (0, marcoLog_js_1.marcoLogDebug)("llm_pipeline_api_ms", {
            requestId: log?.requestId,
            correlationId: log?.correlationId,
            ms: Date.now() - t0,
            stop_reason: response.stop_reason,
        });
        return parsePipelineReplyJson(block.text);
    };
    try {
        let reply = await runOnce(userBlock);
        if (reply && (0, conversationUtils_js_1.candidateMatchesRecentMarco)(reply, recentMarcoOutbounds)) {
            (0, marcoLog_js_1.marcoLog)("llm_pipeline_duplicate_draft", {
                requestId: log?.requestId,
                correlationId: log?.correlationId,
                draft_preview: (0, marcoLog_js_1.previewText)(reply),
                action: "retroactive_fix_retry",
            });
            const fixBlock = userBlock +
                `\n\nRETROACTIVE_FIX: Your draft matches or nearly matches a prior Marco line in CONVERSATION. Output ONLY valid JSON with a new "reply" that (1) answers LATEST_LEAD_MESSAGE, (2) does not reuse prior Marco wording or structure, (3) if a question was already asked and answered in the thread, advance instead of re-asking, (4) one or two short sentences, (5) never em dashes or en dashes, no exceptions, no hyphen pauses between phrases` +
                ", (6) never offer email or phone-or-email choice.";
            reply = (await runOnce(fixBlock)) ?? reply;
        }
        if (reply && (0, conversationUtils_js_1.candidateMatchesRecentMarco)(reply, recentMarcoOutbounds)) {
            (0, marcoLog_js_1.marcoLog)("llm_pipeline_duplicate_draft", {
                requestId: log?.requestId,
                correlationId: log?.correlationId,
                draft_preview: (0, marcoLog_js_1.previewText)(reply),
                action: "alternate_pipeline_fallback",
            });
            reply = alternatePipelineReplyFallback(lead, meta, lastAssistantText, lastUserText, recentMarcoOutbounds, inboundPlatform, inboundChannel);
        }
        if (reply && reply.length > PIPELINE_REPLY_MAX_CHARS) {
            (0, marcoLog_js_1.marcoLog)("llm_pipeline_reply_too_long", {
                requestId: log?.requestId,
                correlationId: log?.correlationId,
                reply_chars: reply.length,
                max_chars: PIPELINE_REPLY_MAX_CHARS,
                draft_preview: (0, marcoLog_js_1.previewText)(reply),
            });
            const shrinkBlock = userBlock +
                `\n\nBREVITY_FIX: Your previous draft was ${reply.length} characters (max ${PIPELINE_REPLY_MAX_CHARS}). Output ONLY valid JSON with "reply" as ONE or TWO short sentences, total under ${PIPELINE_REPLY_MAX_CHARS} characters. ` +
                "Do NOT promise to send pricing, the full breakdown, or links in this DM. Brief empathy, then redirect to text on a number for that property's details. Do not reuse MARCO_PREVIOUS_OUTBOUND wording. No em dashes.";
            const shrunk = await runOnce(shrinkBlock);
            if (shrunk &&
                shrunk.length <= PIPELINE_REPLY_MAX_CHARS &&
                !(0, conversationUtils_js_1.candidateMatchesRecentMarco)(shrunk, recentMarcoOutbounds)) {
                reply = shrunk;
            }
            else {
                reply = alternatePipelineReplyFallback(lead, meta, lastAssistantText, lastUserText, recentMarcoOutbounds, inboundPlatform, inboundChannel);
            }
        }
        const finalReply = reply ??
            fallbackMarcoPipelineReply(lead, meta, lastUserText, recentMarcoOutbounds, inboundPlatform, inboundChannel);
        (0, marcoLog_js_1.marcoLog)("llm_pipeline_done", {
            requestId: log?.requestId,
            correlationId: log?.correlationId,
            reply_preview: (0, marcoLog_js_1.previewText)(finalReply),
            used_hardcoded_fallback: !reply,
            reply_chars: finalReply.length,
        });
        return finalReply;
    }
    catch (e) {
        console.warn("[llm] generateMarcoPipelineReply failed:", e);
        (0, marcoLog_js_1.marcoLog)("llm_pipeline_error", {
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
function alternatePipelineReplyFallback(lead, meta, lastAssistant, lastUser, recentMarco, platform, channel = "dm") {
    if (!lead.phone) {
        const ph = alternatePhoneResistanceFallback(lastAssistant, lastUser);
        if (!(0, conversationUtils_js_1.candidateMatchesRecentMarco)(ph, recentMarco))
            return ph;
    }
    const pool = [];
    if (meta.phoneJustCaptured) {
        pool.push(funnelDeterministic_js_1.PHONE_JUST_CAPTURED_REPLY);
    }
    if (meta.listSendPromised) {
        pool.push("For sure. I'll text you a list of matching homes. Skim when you can and tell me what you want to tour first.", "I'll fire over a curated list by text. When you've had a skim, text back what you want to see first.");
    }
    pool.push("Thanks for reaching out. What's a good number I can text you the full breakdown on this place?", "Got you. I'll keep it moving on my end, text me if anything shifts on your side.");
    for (const c of pool) {
        if (!(0, conversationUtils_js_1.candidateMatchesRecentMarco)(c, recentMarco)) {
            return c;
        }
    }
    return fallbackMarcoPipelineReply(lead, meta, lastUser, recentMarco, platform, channel);
}
/** When the model still duplicates Marco's last line after retry, force a different angle. */
function alternatePhoneResistanceFallback(lastAssistant, lastUser) {
    if ((0, conversationUtils_js_1.signalsEmailDeliveryRequest)(lastUser) && !(0, conversationUtils_js_1.isDuplicateMarcoReply)(EMAIL_DELIVERY_PIPELINE_FALLBACK, lastAssistant)) {
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
        if (!(0, conversationUtils_js_1.isDuplicateMarcoReply)(opt, lastAssistant)) {
            return opt;
        }
    }
    return options[0];
}
function parseReplyTextJson(raw) {
    try {
        const s = stripCodeFences(raw);
        const parsed = JSON.parse(s);
        if (!parsed || typeof parsed !== "object")
            return null;
        const rt = parsed.reply_text;
        if (typeof rt !== "string" || !rt.trim())
            return null;
        return rt.trim();
    }
    catch {
        return null;
    }
}
/**
 * Rewrites a deterministic DM in Marco's tone. Model must return ONLY JSON: {"reply_text":"..."}.
 * On any failure, returns null (caller keeps deterministic reply silently).
 */
async function rewriteReplyWithTone(systemPrompt, deterministicReply, conversation, preflightAppendix) {
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

${prompts_js_1.GLOBAL_MARCO_DM_RULES}

Output ONLY valid JSON with this exact shape (no markdown, no explanation, no code fences):
{"reply_text":"your single DM message here, properly escaped for JSON"}

MARCO_VOICE_RULES:
${systemPrompt.trim()}

DETERMINISTIC_DRAFT:
${deterministicReply.trim()}`;
    const preflightBlock = preflightAppendix && preflightAppendix.trim().length > 0
        ? `PREFLIGHT_NOTE:\n${preflightAppendix.trim()}\n\n`
        : "";
    const context = `${preflightBlock}CONVERSATION_HISTORY:\n${formatConversationHistory(conversation)}`;
    try {
        const raw = await complete(instruction, context);
        return parseReplyTextJson(raw);
    }
    catch {
        return null;
    }
}
