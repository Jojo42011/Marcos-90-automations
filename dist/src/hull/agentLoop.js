"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.serializeToolResult = serializeToolResult;
exports.runAgentLoop = runAgentLoop;
exports.extractSentences = extractSentences;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const founderPrompt_js_1 = require("./founderPrompt.js");
const index_js_1 = require("../harvey/index.js");
const modelRouting_js_1 = require("./modelRouting.js");
const retrieval_js_1 = require("./memory/retrieval.js");
const tools_js_1 = require("./tools.js");
const index_js_2 = require("../integrations/gmail/index.js");
const curiosity_js_1 = require("./curiosity.js");
const MAX_AGENT_STEPS = 8;
const MAX_TOOL_CHARS = 12000;
function serializeToolResult(result) {
    const str = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    if (str.length <= MAX_TOOL_CHARS)
        return str;
    return str.slice(0, MAX_TOOL_CHARS) + `\n\n[TRUNCATED: ${str.length} chars total]`;
}
function extractAssistantText(content) {
    const parts = [];
    for (const block of content) {
        if (block.type === "text" && block.text.trim())
            parts.push(block.text.trim());
    }
    return parts.join("\n\n").trim();
}
function stripMarkdownForSpeech(text) {
    return text
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/^#+\s*/gm, "")
        .replace(/^[-•]\s+/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function finalizeSpeech(text, opts, hadToolOnly) {
    let speech = opts.fastMode
        ? text
        : opts.voiceMode
            ? text
            : (0, curiosity_js_1.maybeAppendCuriosityQuestion)(text, hadToolOnly);
    if (opts.voiceMode)
        speech = stripMarkdownForSpeech(speech);
    return speech;
}
async function runAgentLoop(opts) {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key) {
        return {
            speech: "Anthropic API key not configured.",
            toolRounds: 0,
            model: "none",
        };
    }
    const client = new sdk_1.default({ apiKey: key });
    const factLimit = opts.fastMode ? 4 : 8;
    const facts = await (0, retrieval_js_1.searchFacts)(opts.message, factLimit);
    const memoryPacket = (0, retrieval_js_1.getMemoryPacket)(opts.message, facts);
    const { confidence, count } = opts.fastMode
        ? { confidence: 1, count: facts.length }
        : await (0, retrieval_js_1.getRetrievalConfidence)(opts.message);
    const businessSpecific = !opts.fastMode &&
        !opts.voiceMode &&
        /\b(lead|client|deal|listing|marco|tiktok|mojo|brivity|canyon|price|funnel)\b/i.test(opts.message);
    if (!opts.voiceMode && confidence < 0.15 && count < 3 && businessSpecific) {
        const clar = await client.messages.create({
            model: (0, modelRouting_js_1.getHaikuModel)(),
            max_tokens: 200,
            messages: [
                {
                    role: "user",
                    content: `Marco asked: "${opts.message}" but memory has low confidence. Generate ONE targeted clarification question. No preamble.`,
                },
            ],
        });
        const q = extractAssistantText(clar.content);
        return { speech: q, toolRounds: 0, model: (0, modelRouting_js_1.getHaikuModel)(), clarification: true };
    }
    let system = (0, founderPrompt_js_1.buildFounderSystemPrompt)(memoryPacket);
    system += `\n\n${index_js_1.HARVEY_CONTENT_MANAGER_SYSTEM_PROMPT}`;
    if (opts.voiceMode) {
        system +=
            "\n\nVOICE MODE: Spoken replies only. Max 2-3 short sentences. Lead with the number or answer. No markdown, bullets, or asterisks — plain spoken English. For lead counts, TikTok stats, tasks, or pipeline questions, call the matching tool first instead of guessing. If the utterance is incomplete, ask one short clarifying question.";
        if ((0, index_js_2.isGmailConfigured)()) {
            system +=
                "\n\nEMAIL: When Marco asks you to send an email, you MUST call gmail_send first. Use to=\"marco\" for his inbox. NEVER confirm sent unless gmail_send returned ok:true with messageId.";
        }
    }
    else if (opts.fastMode) {
        system +=
            "\n\nWHATSAPP MODE: Reply in 1-3 short sentences. No markdown. Be direct and conversational.";
        if (opts.ownerMode) {
            system +=
                "\n\nWhen Marco asks you to text/send someone on WhatsApp, call whatsapp_send with the contact name or number and exact message. Confirm briefly after sending.";
        }
        if (opts.channelContext) {
            system += `\n\n${opts.channelContext}`;
        }
    }
    const model = opts.fastMode
        ? (0, modelRouting_js_1.getHaikuModel)()
        : opts.voiceMode
            ? (0, modelRouting_js_1.getHaikuModel)()
            : (0, modelRouting_js_1.needsSonnet)(opts.message)
                ? (0, modelRouting_js_1.getAethonModel)()
                : (0, modelRouting_js_1.getHaikuModel)();
    const messages = [...(opts.history || []), { role: "user", content: opts.message }];
    const hullTools = (0, tools_js_1.getHullToolDefinitions)({ whatsappSend: opts.ownerMode });
    const sonnetTools = !opts.fastMode && model === (0, modelRouting_js_1.getAethonModel)();
    const ownerWhatsAppTools = opts.fastMode && opts.ownerMode;
    const voiceTools = Boolean(opts.voiceMode) && !opts.fastMode;
    const emailIntent = (0, index_js_2.isGmailConfigured)() &&
        /\b(send|email|e-mail|mail)\b/i.test(opts.message) &&
        /\b(email|e-mail|mail|inbox|gmail|me|marco)\b/i.test(opts.message);
    const nurtureIntent = /\b(nurture|scoring|score|hot lead|warm lead|cold lead|lead nurture|re-score|rescore)\b/i.test(opts.message);
    const gmailTools = (0, index_js_2.isGmailConfigured)() &&
        (sonnetTools || ownerWhatsAppTools || voiceTools || emailIntent || opts.ownerMode);
    const nurtureTools = sonnetTools || ownerWhatsAppTools || voiceTools || nurtureIntent || opts.ownerMode;
    const toolsEnabled = sonnetTools || ownerWhatsAppTools || voiceTools || gmailTools || nurtureTools;
    if (gmailTools) {
        system +=
            "\n\nEMAIL: When Marco asks you to send an email, you MUST call gmail_send with recipient, subject, and body before replying. For Marco's inbox use to=\"marco\" or his full email if you know it. NEVER say an email was sent unless gmail_send returned ok:true with a messageId — if the tool returns error, report that error to Marco.";
    }
    if (nurtureTools) {
        system +=
            "\n\nLEAD NURTURE: For scoring, hot/warm/cold tiers, or nurture routing questions, call get_lead_nurture_overview or get_lead_nurture_tier before answering. Use get_lead_score_detail for one lead. Use lead_nurture_score_all / lead_nurture_rescore_cold only when Marco explicitly asks to refresh scores.";
    }
    const activeTools = toolsEnabled ? hullTools : undefined;
    const maxTokens = opts.fastMode ? 512 : opts.voiceMode ? 1024 : (0, modelRouting_js_1.getMaxTokens)();
    let toolRounds = 0;
    let hadToolOnly = false;
    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
        if (opts.onToken) {
            const stream = client.messages.stream({
                model,
                max_tokens: maxTokens,
                system,
                messages,
                tools: activeTools,
            });
            let full = "";
            const finalMsg = await new Promise((resolve, reject) => {
                stream.on("text", (t) => {
                    full += t;
                    opts.onToken?.(t);
                });
                stream
                    .finalMessage()
                    .then(resolve)
                    .catch(reject);
            });
            if (finalMsg.stop_reason !== "tool_use") {
                const text = full.trim() || extractAssistantText(finalMsg.content);
                return { speech: finalizeSpeech(text, opts, hadToolOnly), toolRounds, model };
            }
            const toolUseBlocks = finalMsg.content.filter((b) => b.type === "tool_use");
            hadToolOnly = toolUseBlocks.length > 0 && !full.trim();
            const toolResults = await Promise.all(toolUseBlocks.map(async (tu) => {
                const input = tu.input && typeof tu.input === "object" && !Array.isArray(tu.input)
                    ? tu.input
                    : {};
                let result;
                try {
                    result = await (0, tools_js_1.executeHullTool)(tu.name, input);
                }
                catch (err) {
                    result = { error: err instanceof Error ? err.message : String(err) };
                }
                return {
                    type: "tool_result",
                    tool_use_id: tu.id,
                    content: serializeToolResult(result),
                };
            }));
            messages.push({ role: "assistant", content: finalMsg.content });
            messages.push({ role: "user", content: toolResults });
            toolRounds++;
            continue;
        }
        const response = await client.messages.create({
            model,
            max_tokens: maxTokens,
            system,
            messages,
            tools: activeTools,
        });
        if (response.stop_reason !== "tool_use") {
            return {
                speech: finalizeSpeech(extractAssistantText(response.content), opts, hadToolOnly),
                toolRounds,
                model,
            };
        }
        const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
        hadToolOnly = true;
        const toolResults = await Promise.all(toolUseBlocks.map(async (tu) => {
            const input = tu.input && typeof tu.input === "object" && !Array.isArray(tu.input)
                ? tu.input
                : {};
            let result;
            try {
                result = await (0, tools_js_1.executeHullTool)(tu.name, input);
            }
            catch (err) {
                result = { error: err instanceof Error ? err.message : String(err) };
            }
            return {
                type: "tool_result",
                tool_use_id: tu.id,
                content: serializeToolResult(result),
            };
        }));
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });
        toolRounds++;
    }
    return {
        speech: "Hit the tool loop limit — try a narrower question.",
        toolRounds,
        model,
    };
}
function extractSentences(buffer) {
    const sentences = [];
    let rest = buffer;
    const re = /([^.!?]+[.!?]+)\s*/g;
    let m;
    while ((m = re.exec(rest)) !== null) {
        const s = m[1].trim();
        if (s.length > 2)
            sentences.push(s);
    }
    const lastEnd = rest.lastIndexOf(".") > rest.lastIndexOf("!")
        ? Math.max(rest.lastIndexOf("."), rest.lastIndexOf("!"), rest.lastIndexOf("?"))
        : Math.max(rest.lastIndexOf("!"), rest.lastIndexOf("?"));
    if (lastEnd >= 0)
        rest = rest.slice(lastEnd + 1);
    else if (sentences.length)
        rest = "";
    return { sentences, remainder: rest };
}
