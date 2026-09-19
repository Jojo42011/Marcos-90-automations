"use strict";
/**
 * The boundary between Anthropic's message shape and OpenAI's.
 *
 * WHY TRANSLATE INSTEAD OF REWRITING. ~120 tool definitions, the agent loop,
 * the memory extractor and the job runner are all written against Anthropic's
 * `MessageParam` / `Tool` shapes. Changing all of them to a neutral format
 * would be a large, risky edit that no operator would ever see the benefit of.
 * So the internal format stays Anthropic-shaped and the conversion happens
 * here, in pure functions, on the way to and from an OpenAI-compatible API.
 *
 * THE TWO SHAPES DISAGREE ABOUT WHERE A TOOL RESULT LIVES. Anthropic puts
 * `tool_result` blocks inside a *user* message; OpenAI wants one message per
 * result, with `role: "tool"` and a `tool_call_id`. One user message therefore
 * becomes several OpenAI messages, and the reverse direction regroups them.
 * That asymmetry is the whole reason this file is longer than it looks.
 *
 * NOTHING HERE THROWS. A malformed block (unparseable tool arguments, an image
 * with no data, an unknown block type) is degraded, not fatal: a chat turn
 * must not die because one historical message is odd.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.imageToDataUrl = imageToDataUrl;
exports.dataUrlToImageBlock = dataUrlToImageBlock;
exports.parseToolArguments = parseToolArguments;
exports.toOpenAiTools = toOpenAiTools;
exports.toOpenAiMessages = toOpenAiMessages;
exports.toolUsesFromOpenAi = toolUsesFromOpenAi;
exports.fromOpenAiMessages = fromOpenAiMessages;
/* ────────────────────────── helpers ────────────────────────── */
function asBlocks(content) {
    if (typeof content === "string")
        return content ? [{ type: "text", text: content }] : [];
    return Array.isArray(content) ? content : [];
}
/** Anthropic's base64 image source → the data URL OpenAI expects. */
function imageToDataUrl(source) {
    if (!source || typeof source !== "object")
        return null;
    if (source.type === "url" && typeof source.url === "string") {
        return source.url;
    }
    const s = source;
    if (typeof s.data !== "string" || !s.data)
        return null;
    return `data:${s.media_type || "image/jpeg"};base64,${s.data}`;
}
/** The reverse: a data URL back into an Anthropic image block. */
function dataUrlToImageBlock(url) {
    const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(String(url || ""));
    if (!m)
        return { type: "image", source: { type: "url", url: String(url || "") } };
    return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
}
/**
 * Tool arguments arrive as a JSON *string*, and models do get it wrong —
 * truncated objects, doubled braces, plain prose. A malformed argument blob
 * must degrade to something the tool layer can reject cleanly, never to an
 * exception thrown mid-turn.
 */
function parseToolArguments(raw) {
    if (raw && typeof raw === "object" && !Array.isArray(raw))
        return raw;
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text)
        return {};
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
        return { value: parsed };
    }
    catch {
        /* Kept verbatim under `_raw` so the failure is visible in the tool error
           and in the usage log, instead of the call silently becoming `{}`. */
        return { _raw: text };
    }
}
/** Flatten a tool_result's content to text. Images are pulled out separately. */
function toolResultText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .filter((b) => b?.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("\n");
}
function toolResultImages(content) {
    if (!Array.isArray(content))
        return [];
    return content
        .filter((b) => b?.type === "image")
        .map((b) => imageToDataUrl(b.source))
        .filter((u) => Boolean(u));
}
/* ────────────────────────── Anthropic → OpenAI ────────────────────────── */
function toOpenAiTools(tools) {
    if (!Array.isArray(tools) || !tools.length)
        return undefined;
    const out = [];
    for (const raw of tools) {
        const t = raw;
        if (!t || typeof t.name !== "string" || !t.name)
            continue;
        out.push({
            type: "function",
            function: {
                name: t.name,
                description: t.description ? String(t.description) : undefined,
                /* OpenAI rejects a function with no schema; an empty object schema is
                   the honest equivalent of "this tool takes no arguments". */
                parameters: t.input_schema || { type: "object", properties: {} },
            },
        });
    }
    return out.length ? out : undefined;
}
/**
 * Anthropic messages → OpenAI chat-completions messages, system prompt first.
 *
 * A single user message holding tool results becomes one `role: "tool"` message
 * per result, followed by a user message carrying whatever text or images were
 * in the same turn. Order matters to both APIs: results must come before the
 * next user text, or the model answers the wrong question.
 */
function toOpenAiMessages(messages, system) {
    const out = [];
    if (system && system.trim())
        out.push({ role: "system", content: system });
    for (const raw of Array.isArray(messages) ? messages : []) {
        const msg = raw;
        if (!msg || (msg.role !== "user" && msg.role !== "assistant"))
            continue;
        const blocks = asBlocks(msg.content);
        if (msg.role === "assistant") {
            const text = blocks
                .filter((b) => b.type === "text")
                .map((b) => String(b.text ?? ""))
                .join("\n")
                .trim();
            const toolCalls = blocks
                .filter((b) => b.type === "tool_use")
                .map((b) => {
                const tu = b;
                let args = "{}";
                try {
                    args = JSON.stringify(tu.input ?? {});
                }
                catch {
                    /* Circular or otherwise unserialisable input: send an empty object
                       rather than dropping the call, so the id chain stays intact. */
                    args = "{}";
                }
                return { id: String(tu.id), type: "function", function: { name: String(tu.name), arguments: args } };
            });
            if (!text && !toolCalls.length)
                continue;
            const assistant = { role: "assistant", content: text || null };
            if (toolCalls.length)
                assistant.tool_calls = toolCalls;
            out.push(assistant);
            continue;
        }
        /* user turn: tool results first, then the human-visible parts. */
        const parts = [];
        for (const b of blocks) {
            if (b.type === "tool_result") {
                const tr = b;
                out.push({
                    role: "tool",
                    tool_call_id: String(tr.tool_use_id),
                    content: toolResultText(tr.content) || (tr.is_error ? "error" : ""),
                });
                /* OpenAI's tool role cannot carry an image, and a screenshot is often
                   the whole answer (browser_screenshot). Re-attach it as a user part so
                   the picture survives the crossing instead of being silently dropped. */
                for (const url of toolResultImages(tr.content)) {
                    parts.push({ type: "image_url", image_url: { url } });
                }
            }
            else if (b.type === "text") {
                const text = String(b.text ?? "");
                if (text)
                    parts.push({ type: "text", text });
            }
            else if (b.type === "image") {
                const url = imageToDataUrl(b.source);
                if (url)
                    parts.push({ type: "image_url", image_url: { url } });
            }
        }
        if (!parts.length)
            continue;
        const onlyText = parts.every((p) => p.type === "text");
        out.push({
            role: "user",
            content: onlyText ? parts.map((p) => p.text).join("\n") : parts,
        });
    }
    return out;
}
/* ────────────────────────── OpenAI → Anthropic ────────────────────────── */
/** An OpenAI response's `tool_calls` in the `tool_use` shape Harvey expects. */
function toolUsesFromOpenAi(toolCalls) {
    if (!Array.isArray(toolCalls))
        return [];
    const out = [];
    for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        const name = call?.function?.name;
        if (!name)
            continue;
        out.push({
            /* Some providers omit the id on a streamed call. An id is load-bearing —
               it is how the result finds its call — so one is synthesised. */
            id: String(call.id || `call_${i}_${Date.now().toString(36)}`),
            name: String(name),
            input: parseToolArguments(call.function?.arguments),
        });
    }
    return out;
}
/**
 * OpenAI messages back into Anthropic shape. Used by the round-trip tests and
 * by anything that needs to re-read a translated transcript; consecutive
 * `role: "tool"` messages regroup into one user message of `tool_result` blocks,
 * which is the inverse of what `toOpenAiMessages` did to them.
 */
function fromOpenAiMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const systemParts = [];
    const out = [];
    let pendingResults = [];
    const flushResults = () => {
        if (!pendingResults.length)
            return;
        out.push({ role: "user", content: pendingResults });
        pendingResults = [];
    };
    for (const msg of list) {
        if (!msg || typeof msg !== "object")
            continue;
        if (msg.role === "system") {
            flushResults();
            if (typeof msg.content === "string")
                systemParts.push(msg.content);
            continue;
        }
        if (msg.role === "tool") {
            pendingResults.push({
                type: "tool_result",
                tool_use_id: String(msg.tool_call_id || ""),
                content: typeof msg.content === "string" ? msg.content : "",
            });
            continue;
        }
        if (msg.role === "assistant") {
            flushResults();
            const blocks = [];
            if (typeof msg.content === "string" && msg.content)
                blocks.push({ type: "text", text: msg.content });
            for (const call of msg.tool_calls || []) {
                if (!call?.function?.name)
                    continue;
                blocks.push({
                    type: "tool_use",
                    id: String(call.id || ""),
                    name: String(call.function.name),
                    input: parseToolArguments(call.function.arguments),
                });
            }
            if (blocks.length)
                out.push({ role: "assistant", content: blocks });
            continue;
        }
        if (msg.role === "user") {
            const blocks = [];
            if (typeof msg.content === "string") {
                if (msg.content)
                    blocks.push({ type: "text", text: msg.content });
            }
            else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part?.type === "text")
                        blocks.push({ type: "text", text: String(part.text ?? "") });
                    else if (part?.type === "image_url")
                        blocks.push(dataUrlToImageBlock(part.image_url?.url ?? ""));
                }
            }
            /* A user turn that followed tool results belongs in the SAME Anthropic
               message as those results — that is where they came from. */
            if (pendingResults.length) {
                out.push({ role: "user", content: [...pendingResults, ...blocks] });
                pendingResults = [];
            }
            else if (blocks.length) {
                out.push({ role: "user", content: blocks });
            }
        }
    }
    flushResults();
    return { system: systemParts.join("\n\n"), messages: out };
}
