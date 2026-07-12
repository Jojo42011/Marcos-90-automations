"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.complete = complete;
exports.getAnthropicModel = getAnthropicModel;
exports.classifyNewLeadBuyingIntent = classifyNewLeadBuyingIntent;
exports.preflightLeadTurnReview = preflightLeadTurnReview;
exports.generateMarcoPipelineReply = generateMarcoPipelineReply;
exports.rewriteReplyWithTone = rewriteReplyWithTone;
/**
 * Anthropic client — Claude Haiku (not Sonnet) for tone / light generation when wired in.
 */
require("dotenv/config");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const prompts_js_1 = require("../../../config/prompts.js");
const conversationUtils_js_1 = require("../../app/conversationUtils.js");
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
function normalizeIntentToken(token) {
    return token
        .trim()
        .toLowerCase()
        .replace(/^[@#]+/, "")
        .replace(/[.?!,;:…]+$/u, "");
}
/**
 * Single-token messages: whitelist → true, else false (no API).
 * Two tokens "how much" (normalized) → true (no API).
 * Everything else → null (run Haiku).
 */
function classifyObviousShortMessageWithoutLlm(text) {
    const tokens = text.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) {
        return false;
    }
    if (tokens.length === 1) {
        const w = normalizeIntentToken(tokens[0]);
        if (!w) {
            return false;
        }
        return SINGLE_WORD_BUY_INTENT_WHITELIST.has(w);
    }
    if (tokens.length === 2) {
        const a = normalizeIntentToken(tokens[0]);
        const b = normalizeIntentToken(tokens[1]);
        if (a === "how" && b === "much") {
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
function getAnthropicModel() {
    return model;
}
/**
 * Haiku intent gate: true only when the message clearly signals buyer / property interest.
 * On missing API key or parse/API errors, returns true (fail-open so real leads are not dropped).
 */
async function classifyNewLeadBuyingIntent(message) {
    const text = message.trim();
    if (!text) {
        return false;
    }
    const shortResult = classifyObviousShortMessageWithoutLlm(text);
    if (shortResult !== null) {
        return shortResult;
    }
    const client = getClient();
    if (!client) {
        console.warn("[llm] classifyNewLeadBuyingIntent: ANTHROPIC_API_KEY missing — treating as interested");
        return true;
    }
    const system = `You gate a real-estate buyer funnel on Instagram/ManyChat. Be STRICT. When unsure, use intent=false.

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
        console.warn("[llm] classifyNewLeadBuyingIntent failed — fail-open:", e);
        return true;
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
const DEFAULT_REPEAT_COACHING = "The lead may have repeated the same message; acknowledge briefly, stay on the current funnel step, do not restart from the beginning, and do not repeat or closely mirror Marco's prior outbound. Advance the thread in a new direction. If the latest lead tone is resistant or negative, avoid upbeat affirmations and match their sentiment. Keep moving naturally through Marco's framework: value, then agent context, then number ask.";
/**
 * Before modules/reply: full thread → repeat signal + short coaching (2+ user messages only).
 * Combined with deterministic duplicate detection in the pipeline.
 */
async function preflightLeadTurnReview(input) {
    const transcript = input.conversation.messages
        .map((m) => `${m.role === "user" ? "Lead" : "Marco"}: ${m.text}`)
        .join("\n");
    const client = getClient();
    if (!client) {
        const repeatedMessage = (0, conversationUtils_js_1.isLastUserMessageRepeated)(input.conversation);
        return {
            repeatedMessage,
            coachingNote: repeatedMessage ? DEFAULT_REPEAT_COACHING : "",
        };
    }
    const userBlock = `CURRENT_FUNNEL_STAGE: ${input.leadState}\n\nCONVERSATION (oldest first):\n${transcript}`;
    try {
        const response = await client.messages.create({
            model,
            max_tokens: 256,
            system: prompts_js_1.prompts.preflightTurnReview.trim(),
            messages: [{ role: "user", content: userBlock }],
        });
        const block = response.content[0];
        if (block.type !== "text") {
            const repeatedMessage = (0, conversationUtils_js_1.isLastUserMessageRepeated)(input.conversation);
            return {
                repeatedMessage,
                coachingNote: repeatedMessage ? DEFAULT_REPEAT_COACHING : "",
            };
        }
        const parsed = parsePreflightJson(block.text);
        if (parsed) {
            return parsed;
        }
        const repeatedMessage = (0, conversationUtils_js_1.isLastUserMessageRepeated)(input.conversation);
        return {
            repeatedMessage,
            coachingNote: repeatedMessage ? DEFAULT_REPEAT_COACHING : "",
        };
    }
    catch (e) {
        console.warn("[llm] preflightLeadTurnReview failed:", e);
        const repeatedMessage = (0, conversationUtils_js_1.isLastUserMessageRepeated)(input.conversation);
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
function fallbackMarcoReply(lead, meta) {
    if (meta.phoneJustCaptured) {
        return ("For sure. I'll send you the full breakdown on that home with specs, pricing, and a couple similar options. " +
            "Was this what you had in mind, or are you leaning toward a different area or price range?");
    }
    if (meta.listSendPromised) {
        return ("Of course. I'll email a personalized list of matching homes. " +
            "Skim it when you can and tell me what catches your eye so we can line up showings.");
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
 * One Haiku call: full thread + funnel JSON → next Marco DM (post–opening funnel only).
 */
async function generateMarcoPipelineReply(input) {
    const { lead, conversation, meta, preflight } = input;
    const client = getClient();
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
        email_on_file: Boolean(lead.email),
        criteria: lead.criteria,
        phone_just_captured: Boolean(meta.phoneJustCaptured),
        list_send_promised: Boolean(meta.listSendPromised),
    };
    const userBlock = `PREFLIGHT:\n${JSON.stringify(preflightPayload, null, 2)}\n\n` +
        `FUNNEL_CONTEXT:\n${JSON.stringify(funnelContext, null, 2)}\n\n` +
        `CONVERSATION (oldest first):\n${transcript}`;
    if (!client) {
        return fallbackMarcoReply(lead, meta);
    }
    try {
        const response = await client.messages.create({
            model,
            max_tokens: 900,
            system: (0, prompts_js_1.getMarcoUnifiedPipelineSystem)(),
            messages: [{ role: "user", content: userBlock }],
        });
        const block = response.content[0];
        if (block.type !== "text") {
            return fallbackMarcoReply(lead, meta);
        }
        const reply = parsePipelineReplyJson(block.text);
        if (!reply) {
            return fallbackMarcoReply(lead, meta);
        }
        if (!(0, conversationUtils_js_1.assistantAlreadySaid)(conversation, reply)) {
            return reply;
        }
        // Bucket E: never fire the identical line twice in one thread — one reword retry.
        const retry = await client.messages.create({
            model,
            max_tokens: 900,
            system: (0, prompts_js_1.getMarcoUnifiedPipelineSystem)(),
            messages: [
                { role: "user", content: userBlock },
                { role: "assistant", content: JSON.stringify({ reply }) },
                {
                    role: "user",
                    content: "That reply is identical to a line Marco already sent earlier in this thread. Rewrite it much shorter, with a different opener, keeping the same intent. Output ONLY the JSON.",
                },
            ],
        });
        const retryBlock = retry.content[0];
        const reworded = retryBlock.type === "text" ? parsePipelineReplyJson(retryBlock.text) : null;
        return reworded ?? reply;
    }
    catch (e) {
        console.warn("[llm] generateMarcoPipelineReply failed:", e);
        return fallbackMarcoReply(lead, meta);
    }
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
Your reply_text must use only periods, commas, question marks, exclamation marks, and apostrophes. No em dashes or hyphen punctuation between clauses.

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
