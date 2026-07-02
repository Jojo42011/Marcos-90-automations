"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getContentBrainModel = getContentBrainModel;
exports.claudeChatWithTools = claudeChatWithTools;
exports.claudeSimpleChat = claudeSimpleChat;
/**
 * Claude client for the Content Manager Brain's interactive tool-calling
 * chat interface (the "Ask the Brain" dashboard feature, src/server.ts
 * chatWithSession route).
 *
 * Replaces the former Gemini-based agentic loop (deleted brain/gemini.ts).
 * Claude's native tool-use protocol needs no schema conversion — the
 * existing CmBrainToolDefinition already uses Claude's own input_schema
 * field name/shape, so tool definitions in tools.ts are unchanged.
 */
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const claude_content_js_1 = require("../../../integrations/claude-content.js");
const client = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
function getContentBrainModel() {
    return process.env.CONTENT_BRAIN_MODEL?.trim() || claude_content_js_1.CONTENT_MODELS.QUALITY;
}
/**
 * Multi-round agentic tool-calling loop. Each round: send the conversation
 * (+ tool definitions) to Claude; if it responds with tool_use blocks,
 * execute them via onToolCall and feed tool_result blocks back in; repeat
 * until Claude returns plain text or maxRounds is hit.
 */
async function claudeChatWithTools(input) {
    const messages = (input.history ?? []).map((m) => ({
        role: m.role,
        content: m.content,
    }));
    messages.push({ role: "user", content: input.userMessage });
    const maxRounds = input.maxRounds ?? 8;
    const model = input.model ?? getContentBrainModel();
    for (let round = 0; round < maxRounds; round++) {
        let response;
        try {
            response = await client.messages.create({
                model,
                max_tokens: 4096,
                system: input.system,
                tools: input.tools,
                messages,
            });
        }
        catch (err) {
            (0, claude_content_js_1.logContentAiFailure)("brain tool-chat round", err);
            throw err;
        }
        const toolUses = response.content.filter((b) => b.type === "tool_use");
        if (toolUses.length === 0) {
            const text = response.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("")
                .trim();
            return text || "No response generated.";
        }
        messages.push({ role: "assistant", content: response.content });
        const toolResults = [];
        for (const call of toolUses) {
            const result = await input.onToolCall(call.name, (call.input ?? {}));
            toolResults.push({
                type: "tool_result",
                tool_use_id: call.id,
                content: typeof result === "string" ? result : JSON.stringify(result ?? {}),
            });
        }
        messages.push({ role: "user", content: toolResults });
    }
    return "Reached maximum tool rounds — try a more specific question.";
}
/** Simple single-turn completion — one-sentence chat-session summaries. */
async function claudeSimpleChat(userPrompt, model) {
    try {
        const response = await client.messages.create({
            model: model ?? claude_content_js_1.CONTENT_MODELS.FAST,
            max_tokens: 600,
            system: "You are a concise copywriter for Marco Puga Realty. Return only what is asked.",
            messages: [{ role: "user", content: userPrompt }],
        });
        return response.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();
    }
    catch (err) {
        (0, claude_content_js_1.logContentAiFailure)("brain simple chat", err);
        throw err;
    }
}
