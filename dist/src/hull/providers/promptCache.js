"use strict";
/**
 * Prompt caching: the difference between Harvey being affordable and not.
 *
 * THE MEASUREMENT THAT FORCED THIS. On the live server, "reply with exactly:
 * model layer online" cost **21,012 input tokens and 6.3 cents**. The reply was
 * three words. The input was ~14k tokens of tool schemas (120 of them) plus
 * ~2.3k of system prompt, sent again, in full, on every single turn. At that
 * rate the $10 daily cap is about 160 messages, and nothing about that number
 * has anything to do with what was asked.
 *
 * WHY CACHING AND NOT FEWER TOOLS. The obvious alternative is to stop sending
 * all 120 schemas — pick the relevant ones per turn. That trades a cost problem
 * for a correctness problem: the turn where the guess is wrong is the turn
 * Harvey says he cannot do something he can do, and it would be intermittent and
 * maddening to diagnose. Caching removes the cost of the repetition without
 * removing anything from the model's reach.
 *
 * HOW IT WORKS, AND ITS ONE REAL LIMIT. Anthropic caches the prompt PREFIX up to
 * a marked breakpoint: a cache write costs ~1.25x input, a cache read ~0.1x. Put
 * the breakpoint after the tools and after the system prompt — the two large,
 * byte-identical-every-turn blocks — and the second and later turns of a
 * conversation pay about a tenth for them. The limit is the TTL: roughly five
 * minutes of inactivity and the entry is gone, so a first message after a break
 * pays the write. That is the right trade for a chat, where turns arrive in
 * bursts.
 *
 * WHY IT IS CONDITIONAL. The breakpoint markers are an Anthropic feature.
 * OpenAI caches long prefixes automatically with no markers at all, and Gemini
 * does its own implicit caching, so sending markers to either is at best ignored
 * and at worst a validation error. This applies them only to Anthropic models,
 * and only when the prefix is big enough to be worth a breakpoint — Anthropic
 * has a minimum cacheable length, below which a marker just adds overhead.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.supportsExplicitCache = supportsExplicitCache;
exports.cachingEnabled = cachingEnabled;
exports.withCachedTools = withCachedTools;
exports.withCachedSystem = withCachedSystem;
exports.withCachedOpenAiTools = withCachedOpenAiTools;
exports.withCachedOpenAiSystem = withCachedOpenAiSystem;
exports.withCachedHistory = withCachedHistory;
/** Anthropic's minimum cacheable prefix is ~1k tokens; stay clear of the edge. */
const MIN_CACHEABLE_CHARS = 8000;
/** Only Anthropic takes explicit breakpoints. Everyone else caches implicitly. */
function supportsExplicitCache(model) {
    return /^anthropic\//.test(model) || /^claude[-.]/.test(model);
}
function cachingEnabled() {
    const v = process.env.HARVEY_PROMPT_CACHE?.trim().toLowerCase();
    return !(v === "false" || v === "0" || v === "off" || v === "no");
}
const EPHEMERAL = { type: "ephemeral" };
/**
 * Mark the tool block cacheable.
 *
 * The breakpoint goes on the LAST tool only. Anthropic caches everything before
 * a breakpoint, so one marker at the end covers all 120 schemas; a marker per
 * tool would burn the (small) limit on breakpoints for no benefit.
 *
 * Returns the tools unchanged when caching cannot help, and never mutates the
 * caller's array — these definitions are module-level constants shared by every
 * request, and writing to them would leak a cache marker into the direct
 * Anthropic path and into every other caller.
 */
function withCachedTools(tools, model) {
    if (!tools?.length || !cachingEnabled() || !supportsExplicitCache(model))
        return tools;
    if (JSON.stringify(tools).length < MIN_CACHEABLE_CHARS)
        return tools;
    const copy = tools.slice();
    const last = copy[copy.length - 1];
    copy[copy.length - 1] = { ...last, cache_control: EPHEMERAL };
    return copy;
}
/**
 * Mark the system prompt cacheable.
 *
 * Anthropic's `system` accepts either a string or an array of blocks, and only
 * the block form can carry a breakpoint, so a cached system prompt has to be
 * converted. Below the minimum length it stays a plain string.
 */
function withCachedSystem(system, model) {
    if (!system)
        return system;
    if (!cachingEnabled() || !supportsExplicitCache(model))
        return system;
    if (system.length < MIN_CACHEABLE_CHARS)
        return system;
    return [{ type: "text", text: system, cache_control: EPHEMERAL }];
}
/**
 * The same two breakpoints, applied to an already-translated OpenAI body.
 *
 * These have to exist separately because `toOpenAiTools` builds fresh objects
 * and `toOpenAiMessages` folds the system prompt into a plain string message —
 * both of which drop a `cache_control` added beforehand. So the OpenRouter path
 * marks up the translated body instead of the Anthropic-shaped input.
 */
function withCachedOpenAiTools(tools, model) {
    if (!tools?.length || !cachingEnabled() || !supportsExplicitCache(model))
        return tools;
    if (JSON.stringify(tools).length < MIN_CACHEABLE_CHARS)
        return tools;
    const copy = tools.slice();
    copy[copy.length - 1] = { ...copy[copy.length - 1], cache_control: EPHEMERAL };
    return copy;
}
/**
 * Convert the leading system message to the content-parts form that can carry a
 * breakpoint. This is the form OpenRouter documents for Anthropic caching.
 */
function withCachedOpenAiSystem(messages, model) {
    if (!cachingEnabled() || !supportsExplicitCache(model))
        return messages;
    const first = messages[0];
    if (!first || first.role !== "system" || typeof first.content !== "string")
        return messages;
    if (first.content.length < MIN_CACHEABLE_CHARS)
        return messages;
    const copy = messages.slice();
    copy[0] = {
        ...first,
        content: [{ type: "text", text: first.content, cache_control: EPHEMERAL }],
    };
    return copy;
}
/**
 * Mark the conversation prefix cacheable for a long tool loop.
 *
 * Inside one turn the agent loop can make sixteen calls, each resending every
 * previous tool result. Those results are the other thing that grows without
 * bound here, so the last message before the newest exchange gets a breakpoint
 * too. Skipped for short histories, where the prefix is not worth a marker.
 */
function withCachedHistory(messages, model) {
    if (!cachingEnabled() || !supportsExplicitCache(model))
        return messages;
    if (messages.length < 4)
        return messages;
    if (JSON.stringify(messages).length < MIN_CACHEABLE_CHARS)
        return messages;
    /* Second-to-last message: the newest exchange stays uncached because it
       changes every call and a breakpoint there would never be read. */
    const idx = messages.length - 2;
    const target = messages[idx];
    if (!target || typeof target !== "object" || !Array.isArray(target.content))
        return messages;
    const copy = messages.slice();
    const blocks = target.content.slice();
    const lastBlock = blocks[blocks.length - 1];
    if (!lastBlock || typeof lastBlock !== "object")
        return messages;
    blocks[blocks.length - 1] = { ...lastBlock, cache_control: EPHEMERAL };
    copy[idx] = { ...target, content: blocks };
    return copy;
}
