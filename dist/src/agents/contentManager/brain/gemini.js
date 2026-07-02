"use strict";
/**
 * Google Gemini client for the Content Manager Brain.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGeminiApiKey = getGeminiApiKey;
exports.getCmBrainModel = getCmBrainModel;
exports.getCmBrainMiniModel = getCmBrainMiniModel;
exports.toGeminiFunctionDeclarations = toGeminiFunctionDeclarations;
exports.geminiChatWithTools = geminiChatWithTools;
exports.geminiSimpleChat = geminiSimpleChat;
function getGeminiApiKey() {
    const key = process.env.GEMINI_API_KEY?.trim() || null;
    if (key && !key.startsWith("AIza")) {
        console.error(`[Gemini] WARNING: GEMINI_API_KEY has unexpected format (got ${key.slice(0, 12)}…). ` +
            `Expected AIza… key from Google AI Studio (https://aistudio.google.com/app/apikey). ` +
            `If this is an OAuth token (AQ., ya29., etc.), the Gemini API will return 401 UNAUTHENTICATED.`);
    }
    return key;
}
function getCmBrainModel() {
    return (process.env.CONTENT_BRAIN_MODEL?.trim() ||
        process.env.GEMINI_MODEL?.trim() ||
        "gemini-2.5-flash");
}
function getCmBrainMiniModel() {
    return (process.env.CONTENT_BRAIN_MINI_MODEL?.trim() ||
        process.env.GEMINI_MINI_MODEL?.trim() ||
        "gemini-2.5-flash");
}
function toGeminiSchemaNode(node) {
    if (!node || typeof node !== "object")
        return { type: "STRING" };
    const o = node;
    if (o.type === "object") {
        const properties = {};
        const props = o.properties;
        if (props) {
            for (const [key, val] of Object.entries(props)) {
                properties[key] = toGeminiSchemaNode(val);
            }
        }
        return {
            type: "OBJECT",
            properties,
            required: Array.isArray(o.required) ? o.required : [],
        };
    }
    if (o.type === "array") {
        return {
            type: "ARRAY",
            items: toGeminiSchemaNode(o.items),
            description: o.description,
        };
    }
    const typeMap = {
        string: "STRING",
        number: "NUMBER",
        integer: "INTEGER",
        boolean: "BOOLEAN",
    };
    const geminiType = typeMap[String(o.type)] || "STRING";
    const out = { type: geminiType };
    if (o.description)
        out.description = o.description;
    if (Array.isArray(o.enum))
        out.enum = o.enum;
    return out;
}
function toGeminiFunctionDeclarations(defs) {
    return defs.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: toGeminiSchemaNode(t.input_schema),
    }));
}
async function geminiGenerateContent(input) {
    const key = getGeminiApiKey();
    if (!key)
        throw new Error("GEMINI_API_KEY not configured");
    if (!key.startsWith("AIza")) {
        throw new Error(`GEMINI_API_KEY has invalid format: got ${key.slice(0, 12)}… but expected AIza… API key. ` +
            `Gemini generative language API only accepts API keys from Google AI Studio ` +
            `(https://aistudio.google.com/app/apikey), not OAuth tokens. ` +
            `If you have an OAuth token (AQ., ya29., etc.), get a new API key from AI Studio.`);
    }
    const model = input.model ?? getCmBrainModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
        systemInstruction: { parts: [{ text: input.system }] },
        contents: input.contents,
        generationConfig: { maxOutputTokens: input.maxTokens ?? 4096 },
    };
    if (input.tools?.length) {
        body.tools = [{ functionDeclarations: toGeminiFunctionDeclarations(input.tools) }];
        body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 500)}`);
    }
    const data = (await res.json());
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts?.length)
        throw new Error("Gemini returned no content");
    return parts;
}
function extractText(parts) {
    return parts
        .map((p) => ("text" in p ? p.text : ""))
        .join("")
        .trim();
}
function extractFunctionCalls(parts) {
    const calls = [];
    for (const p of parts) {
        if ("functionCall" in p && p.functionCall?.name) {
            calls.push({
                name: p.functionCall.name,
                args: p.functionCall.args ?? {},
            });
        }
    }
    return calls;
}
async function geminiChatWithTools(input) {
    const contents = [...(input.history ?? [])];
    contents.push({ role: "user", parts: [{ text: input.userMessage }] });
    const maxRounds = input.maxRounds ?? 8;
    for (let round = 0; round < maxRounds; round++) {
        const parts = await geminiGenerateContent({
            system: input.system,
            contents,
            tools: input.tools,
            model: input.model,
        });
        const calls = extractFunctionCalls(parts);
        if (calls.length === 0) {
            return extractText(parts) || "No response generated.";
        }
        contents.push({ role: "model", parts });
        const responses = [];
        for (const call of calls) {
            const result = await input.onToolCall(call.name, call.args);
            const responseObj = result && typeof result === "object" && !Array.isArray(result)
                ? result
                : { result };
            responses.push({
                functionResponse: { name: call.name, response: responseObj },
            });
        }
        contents.push({ role: "user", parts: responses });
    }
    return "Reached maximum tool rounds — try a more specific question.";
}
/** Simple single-turn completion (hooks, captions). */
async function geminiSimpleChat(userPrompt, model) {
    const parts = await geminiGenerateContent({
        system: "You are a concise copywriter for Marco Puga Realty. Return only what is asked.",
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        model: model ?? getCmBrainMiniModel(),
        maxTokens: 600,
    });
    return extractText(parts);
}
