"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamAccumulator = void 0;
exports.openRouterConfigured = openRouterConfigured;
exports.callOpenRouter = callOpenRouter;
/**
 * The OpenRouter client. One key, ~400 models, an OpenAI-compatible endpoint.
 *
 * NO NEW DEPENDENCY. Global `fetch` only — axios is in the tree but the fast
 * overlay deploy path cannot run `npm install`, so anything this file needed
 * that Node does not already ship would force a full image rebuild for a
 * feature that is, in the end, an HTTP POST and an SSE parse.
 *
 * WHAT OPENROUTER GIVES US THAT A DIRECT SDK DOES NOT:
 *   · `usage.cost` in the response body — spend is measured, not estimated.
 *   · `models: [primary, ...fallbacks]` — failover on context-length errors,
 *     rate limits and outages happens upstream, in one round trip.
 *   · `provider: { sort: "price" }` — needed EXPLICITLY, because requests that
 *     carry tools otherwise route through the quality-first tier and quietly
 *     cost more than the cheap model the router picked.
 *
 * THE STREAM IS THE FIDDLY PART. SSE frames arrive split across network
 * chunks, keep-alive comments (`: OPENROUTER PROCESSING`) share the stream with
 * data, tool-call arguments are delivered a few characters at a time keyed by
 * index, and usage only shows up in the FINAL chunk. `StreamAccumulator` owns
 * all four concerns and is exported so it can be tested without a network.
 */
const catalog_js_1 = require("./catalog.js");
const internal_js_1 = require("./internal.js");
const translate_js_1 = require("./translate.js");
const DEFAULT_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 120_000;
function openRouterConfigured() {
    return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}
function baseUrl() {
    return (process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
}
function timeoutMs(req) {
    if (req.timeoutMs && req.timeoutMs > 0)
        return req.timeoutMs;
    const env = Number(process.env.HARVEY_REQUEST_TIMEOUT_MS);
    return Number.isFinite(env) && env > 0 ? env : DEFAULT_TIMEOUT_MS;
}
function headers() {
    const key = process.env.OPENROUTER_API_KEY?.trim();
    const h = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
    };
    /* Attribution headers are optional and purely cosmetic on OpenRouter's
       dashboard — they are what makes spend attributable to this app rather
       than to an anonymous key. */
    const url = process.env.OPENROUTER_APP_URL?.trim();
    const title = process.env.OPENROUTER_APP_TITLE?.trim();
    if (url)
        h["HTTP-Referer"] = url;
    if (title)
        h["X-Title"] = title;
    return h;
}
function readUsage(usage, model) {
    const promptTokens = Math.max(0, Math.round(Number(usage?.prompt_tokens) || 0));
    const completionTokens = Math.max(0, Math.round(Number(usage?.completion_tokens) || 0));
    const cachedTokens = Math.max(0, Math.round(Number(usage?.prompt_tokens_details?.cached_tokens) || 0));
    const reported = Number(usage?.cost);
    if (Number.isFinite(reported) && reported >= 0) {
        return { promptTokens, completionTokens, cachedTokens, costUsd: reported, costEstimated: false };
    }
    /* No cost in the body (some providers omit it): fall back to the catalog and
       SAY that the number is an estimate, so the dashboard never presents a
       guess as a measurement. */
    const info = (0, catalog_js_1.getModelInfo)(model);
    const costUsd = info
        ? (promptTokens / 1e6) * info.inputPerM + (completionTokens / 1e6) * info.outputPerM
        : 0;
    return { promptTokens, completionTokens, cachedTokens, costUsd, costEstimated: true };
}
/* ────────────────────────── request body ────────────────────────── */
function buildBody(req, stream) {
    const models = [req.model, ...(req.fallbacks || [])].filter((m, i, arr) => m && arr.indexOf(m) === i);
    const body = {
        model: req.model,
        messages: (0, translate_js_1.toOpenAiMessages)(req.messages, req.system),
        max_tokens: req.maxTokens,
        stream,
        /* Ask for usage accounting explicitly: without it OpenRouter returns token
           counts but no `cost`, and cost is the only number worth recording. */
        usage: { include: true },
    };
    if (models.length > 1)
        body.models = models;
    if (typeof req.temperature === "number")
        body.temperature = req.temperature;
    const tools = (0, translate_js_1.toOpenAiTools)(req.tools);
    if (tools)
        body.tools = tools;
    if (stream)
        body.stream_options = { include_usage: true };
    if (req.maxCostUsd && req.maxCostUsd > 0) {
        /* A cost ceiling means two things to OpenRouter: rank providers by price
           rather than by quality, and refuse any provider whose per-million price
           is above what we budgeted for the model we chose. Without the explicit
           sort, a tool-carrying request is routed quality-first and the ceiling is
           the only thing left doing any work. */
        const info = (0, catalog_js_1.getModelInfo)(req.model);
        const provider = { sort: "price" };
        if (info)
            provider.max_price = { prompt: info.inputPerM, completion: info.outputPerM };
        body.provider = provider;
    }
    return body;
}
/**
 * Feeds raw bytes of an SSE stream in, gets text deltas out, and keeps the
 * pieces that only make sense once the stream ends (tool calls, usage, the
 * model that actually ran, the finish reason).
 *
 * Stateful on purpose: `push()` is called once per network chunk and chunk
 * boundaries fall wherever TCP decides, including mid-line and mid-JSON.
 */
class StreamAccumulator {
    buffer = "";
    toolCalls = new Map();
    text = "";
    finishReason = null;
    modelUsed = "";
    usage;
    done = false;
    /** Set when the provider sends an error frame mid-stream instead of a 4xx. */
    streamError = null;
    /** Returns the text deltas contained in this chunk, in order. */
    push(chunk) {
        this.buffer += chunk;
        const deltas = [];
        let idx;
        while ((idx = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, idx).replace(/\r$/, "");
            this.buffer = this.buffer.slice(idx + 1);
            const delta = this.line(line);
            if (delta)
                deltas.push(delta);
        }
        return deltas;
    }
    /** Flush whatever is left when the socket closes without a trailing newline. */
    finish() {
        const rest = this.buffer.trim();
        this.buffer = "";
        if (!rest)
            return [];
        const delta = this.line(rest);
        return delta ? [delta] : [];
    }
    line(raw) {
        const line = raw.trim();
        if (!line)
            return null;
        /* `: OPENROUTER PROCESSING` keep-alives share the stream with data and are
           not JSON. Treating a comment as a frame is the classic way to make a
           stream parser throw on a healthy connection. */
        if (line.startsWith(":"))
            return null;
        if (!line.startsWith("data:"))
            return null;
        const payload = line.slice(5).trim();
        if (!payload)
            return null;
        if (payload === "[DONE]") {
            this.done = true;
            return null;
        }
        let frame;
        try {
            frame = JSON.parse(payload);
        }
        catch {
            /* A frame that will not parse is one lost token, not a lost turn. */
            return null;
        }
        if (frame?.error) {
            this.streamError = {
                message: String(frame.error?.message || "stream error"),
                code: Number(frame.error?.code) || undefined,
            };
            return null;
        }
        if (typeof frame?.model === "string" && frame.model)
            this.modelUsed = frame.model;
        if (frame?.usage)
            this.usage = frame.usage;
        const choice = Array.isArray(frame?.choices) ? frame.choices[0] : undefined;
        if (!choice)
            return null;
        if (choice.finish_reason)
            this.finishReason = String(choice.finish_reason);
        const delta = choice.delta || choice.message || {};
        for (const call of delta.tool_calls || []) {
            const index = Number(call?.index ?? 0);
            const existing = this.toolCalls.get(index) || { id: "", name: "", args: "" };
            if (call?.id)
                existing.id = String(call.id);
            if (call?.function?.name)
                existing.name += String(call.function.name);
            if (typeof call?.function?.arguments === "string")
                existing.args += call.function.arguments;
            this.toolCalls.set(index, existing);
        }
        const content = delta.content;
        if (typeof content === "string" && content) {
            this.text += content;
            return content;
        }
        /* Some providers stream content as parts rather than a bare string. */
        if (Array.isArray(content)) {
            const joined = content
                .map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
                .join("");
            if (joined) {
                this.text += joined;
                return joined;
            }
        }
        return null;
    }
    /** Assembled tool calls, in the index order the provider streamed them. */
    collectedToolCalls() {
        return [...this.toolCalls.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, c]) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.args },
        }));
    }
}
exports.StreamAccumulator = StreamAccumulator;
async function* streamChunks(body) {
    const decoder = new TextDecoder();
    const anyBody = body;
    if (anyBody && typeof anyBody.getReader === "function") {
        const reader = anyBody.getReader();
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            yield typeof value === "string" ? value : decoder.decode(value, { stream: true });
        }
        return;
    }
    if (anyBody && typeof anyBody[Symbol.asyncIterator] === "function") {
        for await (const value of anyBody) {
            yield typeof value === "string" ? value : decoder.decode(value, { stream: true });
        }
        return;
    }
    throw new internal_js_1.ModelLayerError("bad_response", "streaming response had no readable body", {
        provider: "openrouter",
    });
}
/* ────────────────────────── the call ────────────────────────── */
async function postJson(req, stream) {
    const controller = new AbortController();
    const ms = timeoutMs(req);
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const res = await fetch(`${baseUrl()}/chat/completions`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify(buildBody(req, stream)),
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new internal_js_1.ModelLayerError("http_error", `OpenRouter returned ${res.status}`, {
                status: res.status,
                provider: "openrouter",
                model: req.model,
                body: text,
            });
        }
        return res;
    }
    catch (err) {
        if (err instanceof internal_js_1.ModelLayerError)
            throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (err?.name === "AbortError") {
            throw new internal_js_1.ModelLayerError("timeout", `OpenRouter did not respond within ${ms}ms`, {
                provider: "openrouter",
                model: req.model,
            });
        }
        throw new internal_js_1.ModelLayerError("network", `OpenRouter request failed: ${message}`, {
            provider: "openrouter",
            model: req.model,
        });
    }
    finally {
        clearTimeout(timer);
    }
}
async function callOpenRouter(req) {
    if (!openRouterConfigured()) {
        throw new internal_js_1.ModelLayerError("no_key", "OPENROUTER_API_KEY is not set", { provider: "openrouter" });
    }
    return req.onToken ? callStreaming(req) : callOnce(req);
}
async function callOnce(req) {
    const res = await postJson(req, false);
    let body;
    try {
        body = await res.json();
    }
    catch (err) {
        throw new internal_js_1.ModelLayerError("bad_response", "OpenRouter returned a body that was not JSON", {
            provider: "openrouter",
            model: req.model,
            body: err instanceof Error ? err.message : String(err),
        });
    }
    /* A 200 carrying `error` happens on moderation and on upstream provider
       failures; treating it as success would return an empty answer as if the
       model had simply chosen to say nothing. */
    if (body?.error) {
        throw new internal_js_1.ModelLayerError("http_error", String(body.error?.message || "OpenRouter returned an error"), {
            status: Number(body.error?.code) || undefined,
            provider: "openrouter",
            model: req.model,
            body: JSON.stringify(body.error).slice(0, 600),
        });
    }
    const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
    const message = choice?.message || {};
    const rawContent = message.content;
    const text = typeof rawContent === "string"
        ? rawContent
        : Array.isArray(rawContent)
            ? rawContent.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
            : "";
    const modelUsed = String(body?.model || req.model);
    return {
        text,
        toolUses: (0, translate_js_1.toolUsesFromOpenAi)(message.tool_calls),
        stopReason: choice?.finish_reason ? String(choice.finish_reason) : null,
        modelUsed,
        ...readUsage(body?.usage, modelUsed),
    };
}
async function callStreaming(req) {
    const res = await postJson(req, true);
    const acc = new StreamAccumulator();
    try {
        for await (const chunk of streamChunks(res.body)) {
            for (const delta of acc.push(chunk))
                req.onToken?.(delta);
        }
        for (const delta of acc.finish())
            req.onToken?.(delta);
    }
    catch (err) {
        if (err instanceof internal_js_1.ModelLayerError)
            throw err;
        throw new internal_js_1.ModelLayerError("network", `OpenRouter stream broke: ${err instanceof Error ? err.message : String(err)}`, {
            provider: "openrouter",
            model: req.model,
        });
    }
    if (acc.streamError) {
        throw new internal_js_1.ModelLayerError("http_error", acc.streamError.message, {
            status: acc.streamError.code,
            provider: "openrouter",
            model: req.model,
        });
    }
    const modelUsed = acc.modelUsed || req.model;
    return {
        text: acc.text,
        toolUses: (0, translate_js_1.toolUsesFromOpenAi)(acc.collectedToolCalls()),
        stopReason: acc.finishReason,
        modelUsed,
        ...readUsage(acc.usage, modelUsed),
    };
}
