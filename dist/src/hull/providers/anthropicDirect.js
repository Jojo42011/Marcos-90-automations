"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.anthropicConfigured = anthropicConfigured;
exports.callAnthropic = callAnthropic;
/**
 * The direct-to-Anthropic path, kept so a missing OpenRouter key cannot take
 * Harvey down.
 *
 * This is what production runs on today: `ANTHROPIC_API_KEY` is already set and
 * the SDK is already a dependency, so this file adds no secret and no package.
 * It is a fallback rather than the primary for one reason — Anthropic's
 * response carries token counts but no price, so every cost recorded through
 * here is ESTIMATED from the catalog. `costEstimated: true` travels with it so
 * the dashboard can say which dollars were measured and which were computed.
 *
 * The messages need no translation: the internal format IS Anthropic's.
 */
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const catalog_js_1 = require("./catalog.js");
const internal_js_1 = require("./internal.js");
function anthropicConfigured() {
    return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}
function client(timeoutMs) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
        throw new internal_js_1.ModelLayerError("no_key", "ANTHROPIC_API_KEY is not set", { provider: "anthropic" });
    }
    return new sdk_1.default({ apiKey, timeout: timeoutMs, maxRetries: 0 });
}
function usageFrom(raw, slug) {
    const promptTokens = Math.max(0, Math.round(Number(raw?.input_tokens) || 0));
    const completionTokens = Math.max(0, Math.round(Number(raw?.output_tokens) || 0));
    const cachedTokens = Math.max(0, Math.round(Number(raw?.cache_read_input_tokens) || 0));
    const info = (0, catalog_js_1.getModelInfo)(slug);
    const costUsd = info
        ? (promptTokens / 1e6) * info.inputPerM + (completionTokens / 1e6) * info.outputPerM
        : 0;
    return { promptTokens, completionTokens, cachedTokens, costUsd, costEstimated: true };
}
function splitContent(content) {
    const parts = [];
    const toolUses = [];
    for (const raw of Array.isArray(content) ? content : []) {
        const block = raw;
        if (block?.type === "text" && block.text)
            parts.push(block.text);
        else if (block?.type === "tool_use" && block.name) {
            toolUses.push({
                id: String(block.id || ""),
                name: String(block.name),
                input: block.input && typeof block.input === "object" && !Array.isArray(block.input)
                    ? block.input
                    : {},
            });
        }
    }
    return { text: parts.join("\n\n").trim(), toolUses };
}
function wrap(err, slug) {
    if (err instanceof internal_js_1.ModelLayerError)
        return err;
    const e = err;
    const status = Number(e?.status) || undefined;
    let body;
    try {
        body = e?.error ? JSON.stringify(e.error) : undefined;
    }
    catch {
        body = undefined;
    }
    return new internal_js_1.ModelLayerError(status ? "http_error" : "network", `Anthropic call failed: ${e?.message || String(err)}`, { status, provider: "anthropic", model: slug, body });
}
async function callAnthropic(req) {
    const slug = req.model;
    const model = (0, catalog_js_1.toAnthropicId)(slug);
    const timeout = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : 120_000;
    const anthropic = client(timeout);
    const params = {
        model,
        max_tokens: req.maxTokens,
        messages: req.messages,
    };
    if (req.system)
        params.system = req.system;
    if (Array.isArray(req.tools) && req.tools.length)
        params.tools = req.tools;
    if (typeof req.temperature === "number")
        params.temperature = req.temperature;
    try {
        if (req.onToken) {
            const stream = anthropic.messages.stream(params);
            stream.on("text", (t) => req.onToken?.(t));
            const final = await stream.finalMessage();
            const { text, toolUses } = splitContent(final.content);
            return {
                text,
                toolUses,
                stopReason: final.stop_reason ?? null,
                /* Anthropic has no fallback chain of its own — what ran is what we
                   asked for, reported in slug form so callers see one id space. */
                modelUsed: slug,
                ...usageFrom(final.usage, slug),
            };
        }
        const res = await anthropic.messages.create(params);
        const { text, toolUses } = splitContent(res.content);
        return {
            text,
            toolUses,
            stopReason: res.stop_reason ?? null,
            modelUsed: slug,
            ...usageFrom(res.usage, slug),
        };
    }
    catch (err) {
        throw wrap(err, slug);
    }
}
