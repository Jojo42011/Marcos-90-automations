"use strict";
/**
 * OpenAI Chat Completions client for the Content Manager Brain.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOpenAIApiKey = getOpenAIApiKey;
exports.getCmBrainModel = getCmBrainModel;
exports.getCmBrainMiniModel = getCmBrainMiniModel;
exports.toOpenAITools = toOpenAITools;
exports.openAIChatCompletion = openAIChatCompletion;
exports.openAISimpleChat = openAISimpleChat;
function getOpenAIApiKey() {
    return process.env.OPENAI_API_KEY?.trim() || null;
}
function getCmBrainModel() {
    return (process.env.CONTENT_BRAIN_MODEL?.trim() ||
        process.env.OPENAI_MODEL?.trim() ||
        "gpt-4o");
}
function getCmBrainMiniModel() {
    return (process.env.CONTENT_BRAIN_MINI_MODEL?.trim() ||
        process.env.OPENAI_MINI_MODEL?.trim() ||
        "gpt-4o-mini");
}
function toOpenAITools(defs) {
    return defs.map((t) => ({
        type: "function",
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
        },
    }));
}
async function openAIChatCompletion(input) {
    const key = getOpenAIApiKey();
    if (!key) {
        throw new Error("OPENAI_API_KEY not configured");
    }
    const body = {
        model: input.model ?? getCmBrainModel(),
        max_tokens: input.maxTokens ?? 4096,
        messages: [{ role: "system", content: input.system }, ...input.messages],
    };
    if (input.tools?.length) {
        body.tools = toOpenAITools(input.tools);
        body.tool_choice = "auto";
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI API ${res.status}: ${errText.slice(0, 500)}`);
    }
    const data = (await res.json());
    const message = data.choices?.[0]?.message;
    if (!message)
        throw new Error("OpenAI returned no message");
    return message;
}
/** Simple single-turn completion (hooks, captions). */
async function openAISimpleChat(userPrompt, model) {
    const message = await openAIChatCompletion({
        system: "You are a concise copywriter for Marco Puga Realty. Return only what is asked.",
        messages: [{ role: "user", content: userPrompt }],
        model: model ?? getCmBrainMiniModel(),
        maxTokens: 600,
    });
    return message.content?.trim() ?? "";
}
