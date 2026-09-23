"use strict";
/**
 * Harvey operator — powered by Aethon Intelligence hull.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runHarveyChat = runHarveyChat;
exports.getHarveyModel = getHarveyModel;
const memory_js_1 = require("./memory.js");
const index_js_1 = require("../hull/providers/index.js");
const noteCapture_js_1 = require("./noteCapture.js");
const agentLoop_js_1 = require("../hull/agentLoop.js");
const extraction_js_1 = require("../hull/memory/extraction.js");
const modelRouting_js_1 = require("../hull/modelRouting.js");
async function runHarveyChat(input) {
    const sessionId = (0, memory_js_1.getOrCreateSessionId)(input.sessionId);
    const trimmed = input.message.trim();
    if (!trimmed)
        throw new Error("Missing message");
    const capturedNote = (0, noteCapture_js_1.tryCaptureNote)(trimmed, "text");
    if (capturedNote) {
        const speech = "Got it — I've saved that note.";
        (0, memory_js_1.appendSessionTurn)(sessionId, "user", trimmed);
        (0, memory_js_1.appendSessionTurn)(sessionId, "assistant", speech);
        return {
            speech,
            sessionId,
        };
    }
    const history = (0, memory_js_1.getSessionHistory)(sessionId);
    const sessionMemory = (0, memory_js_1.historyToAnthropicMessages)(history);
    let speech;
    if (!(0, index_js_1.providerStatus)().primary) {
        speech =
            "No model provider is configured. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY on the server.";
    }
    else {
        try {
            const result = await (0, agentLoop_js_1.runAgentLoop)({
                message: trimmed,
                history: sessionMemory,
                // Timestamped turns feed the continuity layer: sitting detection,
                // open-question tracking, deictic retrieval, rolling summary.
                timedHistory: history.map((t) => ({ role: t.role, content: t.content, at: t.at })),
                sessionId,
                voiceMode: input.voiceMode,
                fullMode: input.fullMode,
                onToken: input.onToken,
            });
            speech = result.speech;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[harvey/chat]", msg);
            speech = `Hit an API error: ${msg}`;
        }
    }
    (0, memory_js_1.appendSessionTurn)(sessionId, "user", trimmed);
    (0, memory_js_1.appendSessionTurn)(sessionId, "assistant", speech);
    const episodeTurns = [
        ...history.map((t) => ({ role: t.role, text: t.content })),
        { role: "user", text: trimmed },
        { role: "assistant", text: speech },
    ];
    void (0, extraction_js_1.runPostConversationExtraction)(sessionId, episodeTurns);
    return {
        speech,
        sessionId,
    };
}
function getHarveyModel() {
    return (0, modelRouting_js_1.getAethonModel)();
}
